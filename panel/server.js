'use strict';

const http = require('http');
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const { CFG, run, verifyPassword, safeRelPath } = require('./lib/util');
const pz = require('./lib/pz');
const mods = require('./lib/mods');
const worlds = require('./lib/worlds');
const settings = require('./lib/settings');
const sandbox = require('./lib/sandbox');

const app = express();
app.disable('x-powered-by');
// SIN proxy delante (install.sh no instala ninguno y node escucha en 0.0.0.0).
// Con 'trust proxy' activo, req.ip salia de X-Forwarded-For, que controla el
// cliente: rotando la cabecera el limitador de login no bloqueaba nunca.
// Poner 'loopback' SOLO si algun dia se pone Caddy o nginx por delante.
app.set('trust proxy', false);
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

/* -------------------------------------------------------------- sesiones */

const sessionMw = session({
  name: 'pzsid',
  secret: CFG.secret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,               // el panel va por HTTP plano; ver README
    maxAge: 12 * 60 * 60 * 1000,
  },
});
app.use(sessionMw);

function requireAuth(req, res, next) {
  if (req.session && req.session.auth) return next();
  return res.status(401).json({ error: 'no autenticado' });
}

/* Rate limit del login: 8 intentos por IP cada 5 minutos, mas un techo global.
 *
 * El techo global existe porque el limite por IP solo sirve si la IP es de
 * fiar, y ademas evita que un aluvion de intentos monopolice el event loop
 * ejecutando scrypt. El Map se poda: antes crecia sin limite. */
const attempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) {
    if (v.until < now && now - (v.ts || 0) > 10 * 60 * 1000) attempts.delete(k);
  }
}, 60000).unref?.();

let globalFails = 0;
let globalWindow = Date.now();

function globalAllowed() {
  if (Date.now() - globalWindow > 5 * 60 * 1000) { globalWindow = Date.now(); globalFails = 0; }
  globalFails += 1;
  return globalFails <= 100;
}

function loginAllowed(ip) {
  if (!globalAllowed()) return false;
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, until: 0 };
  if (rec.until > now) return false;
  if (now - (rec.ts || 0) > 5 * 60 * 1000) { rec.n = 0; }
  rec.ts = now;
  rec.n += 1;
  if (rec.n > 8) { rec.until = now + 5 * 60 * 1000; rec.n = 0; attempts.set(ip, rec); return false; }
  attempts.set(ip, rec);
  return true;
}

/* ------------------------------------------------------------ websockets */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const c of wss.clients) {
    if (c.readyState === 1) { try { c.send(msg); } catch { /* cliente muerto */ } }
  }
}

const tailer = new pz.ConsoleTail(CFG.consoleLog, (lines) => broadcast({ type: 'log', lines }));

server.on('upgrade', (req, socket, head) => {
  // ANTES de sessionMw: node retira su propio manejador de 'error' del socket
  // al emitir 'upgrade', y sessionMw responde de forma asincrona. Un RST del
  // cliente en ese hueco era una excepcion no capturada que mataba el panel,
  // y no hacia falta estar autenticado para provocarla.
  socket.on('error', () => socket.destroy());

  sessionMw(req, {}, () => {
    if (!req.session || !req.session.auth) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      ws.send(JSON.stringify({ type: 'hello', lines: tailer.tail(400) }));
    });
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  // ws emite 'error' sobre la instancia ante fallos de protocolo; sin listener
  // es igualmente una excepcion no capturada.
  ws.on('error', (e) => console.error('[ws]', e.message));
  ws.on('pong', () => { ws.isAlive = true; });
});

// Un cliente que desaparece sin cerrar (portatil que se suspende, wifi que
// cae) deja el socket abierto para siempre y broadcast le sigue escribiendo.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* se limpia en la vuelta siguiente */ }
  }
}, 30000);
heartbeat.unref?.();

// Red de seguridad: con Restart=always systemd relanzaria, pero perder las
// sesiones y cortar un tar en vuelo por un error suelto no compensa.
process.on('uncaughtException', (e) => console.error('[panel] excepcion no capturada', e));
process.on('unhandledRejection', (e) => console.error('[panel] promesa rechazada', e));

/* ------------------------------------------------------------ helper API */

const ok = (res, data = {}) => res.json({ ok: true, ...data });

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) console.error('[api]', err);
      res.status(status).json({ error: err.message || 'error interno' });
    });
  };
}

/* ---------------------------------------------------------------- auth */

app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip || 'x';
  if (!loginAllowed(ip)) {
    return res.status(429).json({ error: 'demasiados intentos, espera 5 minutos' });
  }
  const { user, pass } = req.body || {};
  // comparamos hashes: longitud fija, asi timingSafeEqual nunca lanza
  const sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest();
  const userOk = crypto.timingSafeEqual(sha(user), sha(CFG.user));
  // Sin cortocircuito: con `!userOk || !verifyPassword(...)` scrypt solo corria
  // al acertar el usuario, y esos ~70 ms de diferencia lo delataban. Ahora se
  // evalua siempre, que es asumible porque el techo global acota los intentos.
  const passOk = verifyPassword(pass);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'usuario o contraseña incorrectos' });
  }
  req.session.auth = true;
  req.session.user = CFG.user;
  return ok(res, { user: CFG.user });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.auth) return res.json({ auth: true, user: req.session.user });
  return res.json({ auth: false });
});

/* -------------------------------------------------------------- estado */

app.get('/api/status', requireAuth, wrap(async (req, res) => {
  const st = await pz.fullStatus(tailer);
  ok(res, { status: st });
}));

app.post('/api/power', requireAuth, wrap(async (req, res) => {
  const action = String((req.body || {}).action || '');
  await pz.power(action);
  broadcast({ type: 'event', text: `[panel] accion "${action}" ejecutada` });
  ok(res, { action });
}));

/* Cerrojo: dos pestañas o un doble clic lanzaban dos pz-update.sh sobre el
 * mismo +force_install_dir. Y el timeout de 30 min mataba el bash dejando el
 * steamcmd huerfano y saltandose el systemctl start final: 4 GB en una VM
 * modesta pasan de media hora sin dificultad. */
let updating = null;

app.post('/api/update', requireAuth, wrap(async (req, res) => {
  if (updating) {
    throw Object.assign(new Error('ya hay una actualizacion en curso'), { status: 409 });
  }
  broadcast({ type: 'event', text: '[panel] actualizando servidor via SteamCMD, esto tarda...' });

  updating = (async () => {
    const r = await run(path.join(CFG.binDir, 'pz-update.sh'), [], { timeout: 3 * 3600 * 1000 });
    if (r.code !== 0) {
      throw Object.assign(new Error('la actualizacion fallo, revisa la consola'), { status: 500 });
    }
    return r;
  })().finally(() => { updating = null; });

  const r = await updating;
  ok(res, { output: r.stdout.slice(-4000) });
}));

/* ------------------------------------------------------------- consola */

app.get('/api/console', requireAuth, wrap(async (req, res) => {
  const n = Math.min(parseInt(req.query.lines, 10) || 400, 1000);
  ok(res, { lines: tailer.tail(n) });
}));

app.post('/api/console', requireAuth, wrap(async (req, res) => {
  const cmd = await pz.sendCommand((req.body || {}).cmd);
  broadcast({ type: 'event', text: `> ${cmd}` });
  ok(res, { cmd });
}));

app.get('/api/players', requireAuth, wrap(async (req, res) => {
  const st = await pz.unitState();
  if (st !== 'active') return ok(res, { players: { count: 0, names: [] }, offline: true });
  const players = await pz.queryPlayers(tailer);
  ok(res, { players });
}));

/* ---------------------------------------------------------------- mods */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CFG.tmpDir),
    filename: (req, file, cb) => cb(null, `up-${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: 512 * 1024 * 1024, files: 3000 },
});

app.get('/api/mods', requireAuth, wrap(async (req, res) => {
  ok(res, await mods.listMods());
}));

app.post('/api/mods/upload', requireAuth, upload.array('files'), wrap(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw Object.assign(new Error('no se recibio ningun fichero'), { status: 400 });

  // 'paths' viaja como campo de texto paralelo y en el mismo orden que 'files'
  let paths = (req.body || {}).paths || [];
  if (!Array.isArray(paths)) paths = [paths];

  await fsp.mkdir(CFG.modsDir, { recursive: true });
  const installed = [];
  const loose = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const rel = safeRelPath(paths[i] || f.originalname);
      const isZip = /\.zip$/i.test(rel || f.originalname);

      if (isZip && !rel.includes('/')) {
        installed.push(...await mods.installZip(f.path, f.originalname));
        await fsp.rm(f.path, { force: true }).catch(() => {});
      } else {
        loose.push({ tmpPath: f.path, relPath: rel });
      }
    }
    if (loose.length) installed.push(...await mods.installFiles(loose));
  } finally {
    for (const f of files) await fsp.rm(f.path, { force: true }).catch(() => {});
  }

  const list = await mods.listMods();
  ok(res, { installed: [...new Set(installed)], ...list });
}));

app.post('/api/mods/toggle', requireAuth, wrap(async (req, res) => {
  const { id, enabled } = req.body || {};
  await mods.setModEnabled(id, Boolean(enabled));
  ok(res, await mods.listMods());
}));

app.post('/api/mods/enabled', requireAuth, wrap(async (req, res) => {
  await mods.setEnabledIds((req.body || {}).ids);
  ok(res, await mods.listMods());
}));

app.post('/api/mods/workshop', requireAuth, wrap(async (req, res) => {
  await mods.setWorkshopItems((req.body || {}).ids);
  ok(res, await mods.listMods());
}));

app.delete('/api/mods/:folder', requireAuth, wrap(async (req, res) => {
  await mods.deleteMod(req.params.folder);
  ok(res, await mods.listMods());
}));

/* -------------------------------------------------------------- mundos */

app.get('/api/worlds', requireAuth, wrap(async (req, res) => {
  const [list, backups, state] = await Promise.all([
    worlds.listWorlds(), worlds.listBackups(), pz.unitState(),
  ]);
  ok(res, { worlds: list, backups, running: state === 'active', activeWorld: CFG.serverName });
}));

app.delete('/api/worlds/:name', requireAuth, wrap(async (req, res) => {
  const state = await pz.unitState();
  const r = await worlds.deleteWorld(req.params.name, state === 'active');
  broadcast({ type: 'event', text: `[panel] mundo "${req.params.name}" apartado a la papelera` });
  ok(res, { ...r, worlds: await worlds.listWorlds() });
}));

app.post('/api/worlds/:name/backup', requireAuth, wrap(async (req, res) => {
  const r = await worlds.backupWorld(req.params.name);
  ok(res, { backup: r, backups: await worlds.listBackups() });
}));

app.get('/api/backups/:name/download', requireAuth, wrap(async (req, res) => {
  const full = worlds.backupPath(req.params.name);
  res.download(full, req.params.name);
}));

app.post('/api/backups/:name/restore', requireAuth, wrap(async (req, res) => {
  const state = await pz.unitState();
  const r = await worlds.restoreBackup(req.params.name, state === 'active');
  broadcast({ type: 'event', text: `[panel] mundo "${r.world}" restaurado desde ${req.params.name}` });
  ok(res, { ...r, worlds: await worlds.listWorlds() });
}));

app.delete('/api/backups/:name', requireAuth, wrap(async (req, res) => {
  await worlds.deleteBackup(req.params.name);
  ok(res, { backups: await worlds.listBackups() });
}));

/* ------------------------------------------------------- ajustes visuales */

app.get('/api/settings', requireAuth, wrap(async (req, res) => {
  const { text } = await worlds.readConfig('ini');
  ok(res, { values: settings.parseIni(text) });
}));

app.post('/api/settings', requireAuth, wrap(async (req, res) => {
  const changes = (req.body || {}).changes;
  if (!changes || typeof changes !== 'object') {
    throw Object.assign(new Error('no se recibio ningun cambio'), { status: 400 });
  }
  const { text } = await worlds.readConfig('ini');
  const result = settings.applyIni(text, changes, { allowCreate: true });
  const touched = result.applied.length + result.created.length;
  if (touched) await worlds.writeConfig('ini', result.text);

  broadcast({ type: 'event', text: `[panel] ${touched} ajuste(s) guardados (requiere reinicio)` });
  ok(res, {
    values: settings.parseIni(result.text),
    applied: result.applied,
    created: result.created,
    skipped: result.skipped,
  });
}));

/* ------------------------------------------------ ajustes de partida (lua) */

app.get('/api/sandbox', requireAuth, wrap(async (req, res) => {
  const { text, file } = await worlds.readConfig('sandbox');
  ok(res, { file, items: sandbox.parseSandbox(text) });
}));

app.post('/api/sandbox', requireAuth, wrap(async (req, res) => {
  const changes = (req.body || {}).changes;
  if (!changes || typeof changes !== 'object') {
    throw Object.assign(new Error('no se recibio ningun cambio'), { status: 400 });
  }
  const { text } = await worlds.readConfig('sandbox');
  const result = sandbox.applySandbox(text, changes);
  if (result.applied.length) await worlds.writeConfig('sandbox', result.text);

  broadcast({ type: 'event', text: `[panel] ${result.applied.length} ajuste(s) de partida guardados (requiere reinicio)` });
  ok(res, {
    items: sandbox.parseSandbox(result.text),
    applied: result.applied,
    skipped: result.skipped,
  });
}));

/* --------------------------------------------------------- configuracion */

app.get('/api/config/:kind', requireAuth, wrap(async (req, res) => {
  ok(res, await worlds.readConfig(req.params.kind));
}));

app.post('/api/config/:kind', requireAuth, wrap(async (req, res) => {
  const file = await worlds.writeConfig(req.params.kind, (req.body || {}).text);
  broadcast({ type: 'event', text: `[panel] ${path.basename(file)} guardado (requiere reinicio)` });
  ok(res, { file });
}));

/* --------------------------------------------------------------- static */

// Sin cache de navegador: el panel se actualiza con `git pull` y un CSS o un JS
// viejos producen fallos invisibles (botones muertos, estilos a medias).
// 'no-cache' no significa "no guardar", sino "revalida siempre": con etag las
// recargas devuelven 304 y no cuestan practicamente nada.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use((req, res) => res.status(404).json({ error: 'no encontrado' }));

// multer y demas errores no capturados por wrap()
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[panel]', err);
  res.status(status).json({ error: err.message || 'error interno' });
});

/* ----------------------------------------------------------------- boot */

server.on('error', (e) => {
  console.error(`[panel] no se pudo escuchar en :${CFG.port} —`, e.code || e.message);
  process.exit(1);
});

(async () => {
  await fsp.mkdir(CFG.tmpDir, { recursive: true }).catch(() => {});

  // Un tar cortado por un reinicio del panel dejaba un .tar.gz a medias que
  // listBackups mostraba como copia valida.
  const barridos = await worlds.sweepPartials();
  if (barridos) console.log(`[panel] ${barridos} copia(s) a medias descartadas`);

  await tailer.primeFromEnd(400);
  tailer.start(600);

  server.listen(CFG.port, '0.0.0.0', () => {
    console.log(`[panel] escuchando en :${CFG.port}  (unidad ${CFG.unit}, mundo ${CFG.serverName})`);
  });
})().catch((e) => {
  console.error('[panel] fallo al arrancar', e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // Los sockets ascendidos cuentan como conexiones abiertas: sin cerrarlos,
    // server.close() no completaba nunca y siempre se acababa en el exit duro,
    // que puede cortar un tar en vuelo.
    for (const c of wss.clients) { try { c.close(1001); } catch { /* ya muerto */ } }
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
