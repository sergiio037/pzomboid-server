'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { CFG, run, sleep, exists, iniGet } = require('./util');

const JAVA_PATTERN = 'zombie.network.GameServer';
// \x1b explicito: aqui habia un byte ESC literal, invisible en el
// codigo y facil de perder al copiar o al pasar por cualquier herramienta
// que sanee texto. El comportamiento es identico: lo que cambia es que se ve.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
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

/* ------------------------------------------------------- datos de conexion */

let cachedIp = null;

/**
 * IP publica de la VM. La pedimos al servidor de metadatos de GCP, que es la
 * fuente autoritativa; si no estamos en GCP devolvemos null y el navegador
 * cae a location.hostname, que para este panel es la misma direccion.
 */
async function publicIp() {
  if (cachedIp) return cachedIp;
  const r = await run('curl', [
    '-fsS', '-m', '3', '-H', 'Metadata-Flavor: Google',
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
  ], { timeout: 5000 });
  const ip = r.stdout.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { cachedIp = ip; return ip; }
  return null;
}

async function endpoint() {
  let port = '16261';
  let hasPassword = false;
  let publicName = '';
  try {
    const ini = await fsp.readFile(CFG.iniFile, 'utf8');
    port = iniGet(ini, 'DefaultPort') || port;
    hasPassword = Boolean(iniGet(ini, 'Password'));
    publicName = iniGet(ini, 'PublicName');
  } catch { /* el .ini aparece tras el primer arranque */ }
  return { ip: await publicIp(), port, hasPassword, publicName };
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
    this.ino = null;          // para detectar rotacion aunque el log crezca
    this.totalPushed = 0;     // contador monotono: sobrevive al recorte del ring
  }

  /**
   * Numero de secuencia de la ultima linea vista. A diferencia de ring.length,
   * no deja de crecer cuando el ring llega a su tope, asi que sirve como marca
   * para "dame lo que ha salido desde este momento".
   */
  get seq() { return this.totalPushed; }

  /** Lineas emitidas desde el numero de secuencia `from`. */
  linesSince(from) {
    const base = this.totalPushed - this.ring.length;   // seq de ring[0]
    return this.ring.slice(Math.max(0, from - base));
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
      this.totalPushed = this.ring.length;
      this.offset = st.size;
      this.ino = st.ino;
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
      // Comparar solo el tamaño no basta: pz-start.sh rota con mv + ': >', o sea
      // inodo nuevo. En un bucle de reinicio el log nuevo supera enseguida al
      // viejo y se perderian justo las primeras lineas, que son las del error.
      if (st.ino !== this.ino || st.size < this.offset) {
        this.offset = 0;
        this.carry = '';
      }
      this.ino = st.ino;
      if (st.size === this.offset) return;

      const len = Math.min(st.size - this.offset, 512 * 1024);
      const fh = await fsp.open(this.file, 'r');
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.offset);
      await fh.close();
      if (!bytesRead) return;                 // avanzar con `len` metia NUL en el carry
      this.offset += bytesRead;

      const chunk = this.carry + this._clean(buf.subarray(0, bytesRead).toString('utf8'));
      const parts = chunk.split('\n');
      this.carry = parts.pop();               // ultima linea posiblemente incompleta
      const lines = parts.filter((l) => l.length > 0);
      if (!lines.length) return;

      this.ring.push(...lines);
      this.totalPushed += lines.length;
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
 * Envia un comando y devuelve las lineas que el servidor escribio DESPUES.
 *
 * El cerrojo es necesario: dos capturas simultaneas se roban la respuesta la
 * una a la otra, y el panel lanza `players` cada 45 s ademas de bajo demanda.
 */
let capturing = false;

async function captureAfterCommand(tailer, cmd, { timeoutMs = 8000, done } = {}) {
  if (capturing) {
    throw Object.assign(new Error('ya hay una consulta en curso, reintenta'), { status: 409 });
  }
  capturing = true;
  try {
    const from = tailer.seq;
    await sendCommand(cmd);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(300);
      await tailer.poll();
      const lines = tailer.linesSince(from);
      if (done && done(lines)) return { lines, complete: true };
    }
    return { lines: tailer.linesSince(from), complete: false };
  } finally {
    capturing = false;
  }
}

const RE_PLAYERS = /Players connected \((\d+)\)/i;

/**
 * Lista de jugadores conectados. Se pide al propio servidor con el comando
 * `players` y se lee su respuesta del log; es la unica fuente fiable.
 */
async function queryPlayers(tailer) {
  const { lines } = await captureAfterCommand(tailer, 'players', {
    done: (ls) => ls.some((l) => RE_PLAYERS.test(l)),
  });

  const idx = lines.findIndex((l) => RE_PLAYERS.test(l));
  if (idx < 0) return { count: null, names: [] };

  const count = parseInt(RE_PLAYERS.exec(lines[idx])[1], 10) || 0;
  const names = [];
  for (const raw of lines.slice(idx + 1)) {
    const line = raw.trim();
    if (!line.startsWith('-')) break;
    names.push(line.replace(/^-\s*/, ''));
  }
  return { count, names };
}

/* ----------------------------------------------------------------- estado */

async function fullStatus(tailer) {
  const [state, pid, host, conn] = await Promise.all([
    unitState(), javaPid(), hostStats(), endpoint(),
  ]);
  const proc = await procStats(pid);
  return {
    unit: CFG.unit,
    serverName: CFG.serverName,
    endpoint: conn,
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
  ConsoleTail, sendCommand, power, queryPlayers, captureAfterCommand,
  fullStatus, unitState, javaPid, hostStats, endpoint,
};
