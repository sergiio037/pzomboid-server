'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { CFG, run, sleep, exists } = require('./util');

const JAVA_PATTERN = 'zombie.network.GameServer';
const ANSI_RE = /\[[0-9;?]*[A-Za-z]/g;
const RING_MAX = 1000;

/* ------------------------------------------------------- estado del proceso */

async function unitState() {
  const r = await run('systemctl', ['is-active', CFG.unit]);
  return r.stdout.trim() || 'unknown';
}

async function javaPid() {
  const r = await run('pgrep', ['-u', CFG.sysUser, '-f', JAVA_PATTERN]);
  const pid = parseInt(r.stdout.trim().split('\n')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}

async function procStats(pid) {
  if (!pid) return null;
  const r = await run('ps', ['-o', '%cpu=,rss=,etimes=', '-p', String(pid)]);
  const parts = r.stdout.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return {
    cpu: parseFloat(parts[0]) || 0,
    memMB: Math.round((parseInt(parts[1], 10) || 0) / 1024),
    uptimeSec: parseInt(parts[2], 10) || 0,
  };
}

async function hostStats() {
  const df = await run('df', ['-B1', '--output=size,used,avail', '/']);
  const row = df.stdout.trim().split('\n')[1] || '';
  const [size, used, avail] = row.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return {
    cpuCount: os.cpus().length,
    load1: os.loadavg()[0],
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    diskTotal: size,
    diskUsed: used,
    diskFree: avail,
    uptimeSec: Math.round(os.uptime()),
  };
}

/* ---------------------------------------------------------------- consola */

/**
 * Tailer del log de consola. Lee incrementalmente, arrastra la linea parcial
 * entre lecturas y se reinicia solo si el fichero se trunca (reinicio del
 * servidor -> pz-start.sh rota el log).
 */
class ConsoleTail {
  constructor(file, onLines) {
    this.file = file;
    this.onLines = onLines;
    this.offset = 0;
    this.carry = '';
    this.ring = [];
    this.timer = null;
    this.busy = false;
  }

  async primeFromEnd(maxLines = 300) {
    try {
      const st = await fsp.stat(this.file);
      const want = Math.min(st.size, 256 * 1024);
      const fh = await fsp.open(this.file, 'r');
      const buf = Buffer.alloc(want);
      await fh.read(buf, 0, want, st.size - want);
      await fh.close();
      const lines = this._clean(buf.toString('utf8')).split('\n').filter(Boolean);
      this.ring = lines.slice(-maxLines);
      this.offset = st.size;
    } catch {
      this.offset = 0;
    }
  }

  _clean(s) {
    return s.replace(ANSI_RE, '').replace(/\r/g, '');
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const st = await fsp.stat(this.file);
      if (st.size < this.offset) { this.offset = 0; this.carry = ''; }
      if (st.size === this.offset) return;

      const len = Math.min(st.size - this.offset, 512 * 1024);
      const fh = await fsp.open(this.file, 'r');
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      await fh.close();
      this.offset += len;

      const chunk = this.carry + this._clean(buf.toString('utf8'));
      const parts = chunk.split('\n');
      this.carry = parts.pop();               // ultima linea posiblemente incompleta
      const lines = parts.filter((l) => l.length > 0);
      if (!lines.length) return;

      this.ring.push(...lines);
      if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
      this.onLines(lines);
    } catch {
      /* el fichero puede no existir todavia */
    } finally {
      this.busy = false;
    }
  }

  start(intervalMs = 600) {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref?.();
  }

  tail(n = 400) {
    return this.ring.slice(-n);
  }
}

/* --------------------------------------------------------------- comandos */

async function sendCommand(cmd) {
  const clean = String(cmd || '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) throw Object.assign(new Error('comando vacio'), { status: 400 });
  if (clean.length > 900) throw Object.assign(new Error('comando demasiado largo'), { status: 400 });

  const r = await run(path.join(CFG.binDir, 'pz-cmd.sh'), [clean], { timeout: 10000 });
  if (r.code === 3) throw Object.assign(new Error('el servidor no esta corriendo'), { status: 409 });
  if (r.code !== 0) {
    throw Object.assign(new Error(r.stderr.trim() || 'no se pudo enviar el comando'), { status: 500 });
  }
  return clean;
}

async function power(action) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    throw Object.assign(new Error('accion invalida'), { status: 400 });
  }
  const r = await run('sudo', ['-n', 'systemctl', action, CFG.unit], { timeout: 200000 });
  if (r.code !== 0) {
    throw Object.assign(new Error(r.stderr.trim() || `systemctl ${action} fallo`), { status: 500 });
  }
  return true;
}

/**
 * Lista de jugadores conectados. Se pide al propio servidor con el comando
 * `players` y se lee su respuesta del log; es la unica fuente fiable.
 */
async function queryPlayers(tailer) {
  const before = tailer.ring.length;
  await sendCommand('players');

  for (let i = 0; i < 10; i++) {
    await sleep(300);
    await tailer.poll();
    const fresh = tailer.ring.slice(Math.max(0, before - 5));
    const joined = fresh.join('\n');
    const m = /Players connected \((\d+)\)/i.exec(joined);
    if (!m) continue;

    const after = joined.slice(m.index + m[0].length);
    const names = [];
    for (const raw of after.split('\n').slice(1)) {
      const line = raw.trim();
      if (!line.startsWith('-')) break;
      names.push(line.replace(/^-\s*/, ''));
    }
    return { count: parseInt(m[1], 10) || 0, names };
  }
  return { count: null, names: [] };
}

/* ----------------------------------------------------------------- estado */

async function fullStatus(tailer) {
  const [state, pid, host] = await Promise.all([unitState(), javaPid(), hostStats()]);
  const proc = await procStats(pid);
  return {
    unit: CFG.unit,
    serverName: CFG.serverName,
    state,                                  // active | inactive | failed | activating
    running: state === 'active',
    ready: Boolean(pid) && await exists(process.env.PZ_FIFO || ''),
    pid,
    proc,
    host,
    branch: process.env.PZ_BRANCH || 'stable',
  };
}

module.exports = {
  ConsoleTail, sendCommand, power, queryPlayers,
  fullStatus, unitState, javaPid, hostStats,
};
