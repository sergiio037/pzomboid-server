'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const {
  CFG, run, exists, dirSize, isSafeName, resolveInside,
} = require('./util');

/* ------------------------------------------------------------------ mundos */

async function listWorlds() {
  await fsp.mkdir(CFG.savesDir, { recursive: true });
  let dirs = [];
  try {
    dirs = (await fsp.readdir(CFG.savesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { return []; }

  const out = [];
  for (const name of dirs) {
    const full = path.join(CFG.savesDir, name);
    const [size, stat, playerDb] = await Promise.all([
      dirSize(full),
      fsp.stat(full).catch(() => null),
      exists(path.join(full, 'players.db')),
    ]);
    out.push({
      name,
      size,
      mtime: stat ? stat.mtimeMs : 0,
      active: name === CFG.serverName,
      hasPlayers: playerDb,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Borra un mundo. Se exige que el servidor este parado: PZ mantiene las
 * bases de datos abiertas y borrarlas en caliente deja el proceso escribiendo
 * en ficheros huerfanos.
 */
async function deleteWorld(name, serverRunning) {
  if (!isSafeName(name)) throw Object.assign(new Error('nombre invalido'), { status: 400 });
  if (serverRunning) {
    throw Object.assign(
      new Error('detén el servidor antes de borrar un mundo'), { status: 409 },
    );
  }
  const full = resolveInside(CFG.savesDir, name);
  if (!await exists(full)) throw Object.assign(new Error('ese mundo no existe'), { status: 404 });
  await fsp.rm(full, { recursive: true, force: true });
  return true;
}

/* ---------------------------------------------------------------- backups */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function backupWorld(name) {
  if (!isSafeName(name)) throw Object.assign(new Error('nombre invalido'), { status: 400 });
  const src = resolveInside(CFG.savesDir, name);
  if (!await exists(src)) throw Object.assign(new Error('ese mundo no existe'), { status: 404 });

  await fsp.mkdir(CFG.backupDir, { recursive: true });
  const file = `${name.replace(/[^\w.\-]/g, '_')}_${stamp()}.tar.gz`;
  const dest = path.join(CFG.backupDir, file);

  const r = await run('tar', ['-czf', dest, '-C', CFG.savesDir, name], { timeout: 900000 });
  if (r.code !== 0) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw Object.assign(new Error(r.stderr.trim().slice(0, 300) || 'fallo al crear el backup'), { status: 500 });
  }
  const st = await fsp.stat(dest);
  return { file, size: st.size };
}

async function listBackups() {
  await fsp.mkdir(CFG.backupDir, { recursive: true });
  const files = (await fsp.readdir(CFG.backupDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.tar.gz'))
    .map((e) => e.name);

  const out = [];
  for (const name of files) {
    const st = await fsp.stat(path.join(CFG.backupDir, name)).catch(() => null);
    if (st) out.push({ name, size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function backupPath(name) {
  if (!/^[\w.\-]+\.tar\.gz$/.test(String(name || ''))) {
    throw Object.assign(new Error('nombre invalido'), { status: 400 });
  }
  return resolveInside(CFG.backupDir, name);
}

async function deleteBackup(name) {
  const full = backupPath(name);
  if (!await exists(full)) throw Object.assign(new Error('no existe'), { status: 404 });
  await fsp.rm(full, { force: true });
  return true;
}

/**
 * Restaura una copia sobre la carpeta de partidas.
 *
 * Nunca borra: si ya existe un mundo con ese nombre lo aparta con un sufijo
 * antes de extraer, de modo que un restore equivocado siempre se puede
 * deshacer a mano. Exige el servidor parado, igual que el borrado.
 */
async function restoreBackup(name, serverRunning) {
  if (serverRunning) {
    throw Object.assign(new Error('detén el servidor antes de restaurar'), { status: 409 });
  }
  const full = backupPath(name);
  if (!await exists(full)) throw Object.assign(new Error('esa copia no existe'), { status: 404 });

  // el nombre del mundo va dentro del propio .tar.gz, no lo adivinamos
  const list = await run('tar', ['-tzf', full], { timeout: 120000 });
  if (list.code !== 0) {
    throw Object.assign(new Error('la copia no se puede leer, ¿está corrupta?'), { status: 500 });
  }
  const tops = [...new Set(
    list.stdout.split('\n').map((l) => l.trim().split('/')[0]).filter(Boolean),
  )];
  if (tops.length !== 1 || !isSafeName(tops[0])) {
    throw Object.assign(
      new Error(`estructura inesperada dentro de la copia: ${tops.slice(0, 3).join(', ')}`),
      { status: 400 },
    );
  }

  const world = tops[0];
  const dest = resolveInside(CFG.savesDir, world);
  let movedTo = null;

  if (await exists(dest)) {
    movedTo = `${world}_antes-de-restaurar_${stamp()}`;
    await fsp.rename(dest, resolveInside(CFG.savesDir, movedTo));
  }

  const r = await run('tar', ['-xzf', full, '-C', CFG.savesDir], { timeout: 900000 });
  if (r.code !== 0) {
    // deshacemos para no dejar al usuario sin mundo
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    if (movedTo) await fsp.rename(resolveInside(CFG.savesDir, movedTo), dest).catch(() => {});
    throw Object.assign(
      new Error(r.stderr.trim().slice(0, 300) || 'fallo al extraer la copia'), { status: 500 },
    );
  }

  return { world, movedTo };
}

/* -------------------------------------------------------- configuracion */

const CONFIG_FILES = {
  ini: () => CFG.iniFile,
  sandbox: () => CFG.sandboxFile,
};

async function readConfig(kind) {
  const get = CONFIG_FILES[kind];
  if (!get) throw Object.assign(new Error('fichero desconocido'), { status: 400 });
  const file = get();
  const text = await fsp.readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    throw Object.assign(
      new Error(`${path.basename(file)} aun no existe (se crea en el primer arranque)`),
      { status: 404 },
    );
  }
  return { file, text };
}

async function writeConfig(kind, text) {
  const get = CONFIG_FILES[kind];
  if (!get) throw Object.assign(new Error('fichero desconocido'), { status: 400 });
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) {
    throw Object.assign(new Error('contenido invalido'), { status: 400 });
  }
  const file = get();
  await fsp.mkdir(path.dirname(file), { recursive: true });

  // Copia CON FECHA antes de sobrescribir. Con un unico .bak, varios guardados
  // seguidos pisaban el historial y se perdia el estado original: exactamente
  // lo que paso al desactivar mods de uno en uno.
  if (await exists(file)) {
    await fsp.copyFile(file, `${file}.${stamp()}.bak`).catch(() => {});
    await pruneBaks(file);
  }

  await fsp.writeFile(file, text, 'utf8');
  return file;
}

/** Conserva las 20 copias mas recientes de un fichero de configuracion. */
async function pruneBaks(file, keep = 20) {
  const dir = path.dirname(file);
  const base = `${path.basename(file)}.`;
  try {
    const olds = (await fsp.readdir(dir))
      .filter((n) => n.startsWith(base) && n.endsWith('.bak'))
      .sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - keep))) {
      await fsp.rm(path.join(dir, n), { force: true }).catch(() => {});
    }
  } catch { /* si no se puede listar, no pasa nada */ }
}

/** Copias con fecha de un fichero de configuracion, de mas nueva a mas vieja. */
async function listConfigBaks(kind) {
  const get = CONFIG_FILES[kind];
  if (!get) throw Object.assign(new Error('fichero desconocido'), { status: 400 });
  const file = get();
  const dir = path.dirname(file);
  const base = `${path.basename(file)}.`;

  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.startsWith(base) && n.endsWith('.bak'));
  } catch { return []; }

  const out = [];
  for (const name of names) {
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (st) out.push({ name, size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

module.exports = {
  listWorlds, deleteWorld,
  backupWorld, listBackups, backupPath, deleteBackup, restoreBackup,
  readConfig, writeConfig, listConfigBaks,
};
