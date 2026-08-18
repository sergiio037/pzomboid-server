'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const {
  CFG, run, exists, dirSize, fmtBytes, isSafeName, resolveInside, stamp, quarantine,
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
 * Aparta un mundo a la papelera. NO lo borra: la regla del proyecto es que
 * ninguna operacion destruye datos del usuario.
 *
 * Se sigue exigiendo el servidor parado. Renombrar bajo una JVM viva deja al
 * proceso escribiendo en un inodo huerfano, que es peor que borrar.
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
  const moved = await quarantine(full, CFG.trashDir, 'borrado');
  return { quarantined: moved.name };
}

/* ---------------------------------------------------------------- backups */

/** Ficheros de configuracion que acompañan al mundo dentro de la copia. */
function configFileNames() {
  return [
    path.basename(CFG.iniFile),
    path.basename(CFG.sandboxFile),
  ];
}

/**
 * Empaqueta el mundo Y su configuracion.
 *
 * Guardar solo la partida deja media copia: la lista de mods vive en el .ini,
 * y sin ella un mundo restaurado arranca sin los mods con los que se genero.
 * El .ini y el SandboxVars van sueltos en la raiz del archivo, junto a la
 * carpeta del mundo.
 */
async function backupWorld(name) {
  if (!isSafeName(name)) throw Object.assign(new Error('nombre invalido'), { status: 400 });
  const src = resolveInside(CFG.savesDir, name);
  if (!await exists(src)) throw Object.assign(new Error('ese mundo no existe'), { status: 404 });

  await fsp.mkdir(CFG.backupDir, { recursive: true });
  const file = `${name.replace(/[^\w.\-]/g, '_')}_${stamp()}.tar.gz`;
  const dest = path.join(CFG.backupDir, file);

  // rutas absolutas a proposito: en tar cada -C se interpreta relativo al
  // anterior, y con rutas relativas el segundo apuntaria dentro del primero
  const args = ['-czf', dest, '-C', path.resolve(CFG.savesDir), name];
  const included = [];
  for (const cfg of configFileNames()) {
    if (await exists(path.join(CFG.serverCfgDir, cfg))) {
      args.push('-C', path.resolve(CFG.serverCfgDir), cfg);
      included.push(cfg);
    }
  }

  // Con el disco lleno, tar deja un .tar.gz truncado que parece una copia buena.
  const necesario = await dirSize(src);
  const libre = await diskFree(CFG.backupDir);
  if (libre > 0 && libre < necesario * 1.2) {
    throw Object.assign(
      new Error(`el mundo ocupa ${fmtBytes(necesario)} y solo quedan ${fmtBytes(libre)} libres`),
      { status: 507 },
    );
  }

  // Se escribe a .part y se renombra al final: nunca queda visible una copia
  // a medias si el panel se reinicia durante el tar.
  const parcial = `${dest}.part`;
  args[1] = parcial;

  const r = await run('tar', args, { timeout: 900000 });

  // rc=1 en GNU tar es AVISO, no error. El caso normal es "file changed as we
  // read it" con jugadores conectados. Antes se borraba la copia y se
  // respondia "fallo", justo cuando mas se queria tener la copia.
  if (r.code >= 2) {
    await fsp.rm(parcial, { force: true }).catch(() => {});
    throw Object.assign(
      new Error(r.stderr.trim().slice(0, 300) || 'fallo al crear el backup'), { status: 500 },
    );
  }
  await fsp.rename(parcial, dest);

  const st = await fsp.stat(dest);
  return {
    file,
    size: st.size,
    config: included,
    warning: r.code === 1
      ? 'el mundo cambiaba mientras se copiaba (servidor en marcha): la copia puede no ser del todo consistente'
      : null,
  };
}

/** Espacio libre en el sistema de ficheros que contiene `dir`, en bytes. */
async function diskFree(dir) {
  const r = await run('df', ['-B1', '--output=avail', dir], { timeout: 15000 });
  const n = parseInt((r.stdout.split('\n')[1] || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Barre los .part que dejo un tar interrumpido. Se llama al arrancar el panel. */
async function sweepPartials() {
  try {
    const rest = (await fsp.readdir(CFG.backupDir))
      .filter((n) => n.endsWith('.tar.gz.part'));
    for (const n of rest) await fsp.rm(path.join(CFG.backupDir, n), { force: true }).catch(() => {});
    return rest.length;
  } catch { return 0; }
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

  // el contenido va dentro del propio .tar.gz, no lo adivinamos
  const list = await run('tar', ['-tzf', full], { timeout: 120000 });
  if (list.code !== 0) {
    throw Object.assign(new Error('la copia no se puede leer, ¿está corrupta?'), { status: 500 });
  }

  const entries = list.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const tops = [...new Set(entries.map((e) => e.split('/')[0]))];
  // lo que tiene hijos es la carpeta del mundo; lo suelto, la configuracion
  const dirs = tops.filter((t) => entries.some((e) => e.startsWith(`${t}/`)));
  const loose = tops.filter((t) => !dirs.includes(t));

  if (dirs.length !== 1 || !isSafeName(dirs[0])) {
    throw Object.assign(
      new Error(`estructura inesperada dentro de la copia: ${tops.slice(0, 3).join(', ')}`),
      { status: 400 },
    );
  }
  const known = configFileNames();
  const configs = loose.filter((f) => known.includes(f));

  const world = dirs[0];
  const dest = resolveInside(CFG.savesDir, world);
  let movedTo = null;

  // A la papelera, no a la carpeta de partidas: si no, tras dos restauraciones
  // la lista de mundos es un cementerio de _antes-de-restaurar_.
  if (await exists(dest)) {
    movedTo = (await quarantine(dest, CFG.trashDir, 'restauracion')).name;
  }

  const r = await run('tar', ['-xzf', full, '-C', path.resolve(CFG.savesDir), world], { timeout: 900000 });
  if (r.code !== 0) {
    // deshacemos para no dejar al usuario sin mundo
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    if (movedTo) {
      await fsp.rename(resolveInside(CFG.trashDir, movedTo), dest).catch(() => {});
    }
    throw Object.assign(
      new Error(r.stderr.trim().slice(0, 300) || 'fallo al extraer la copia'), { status: 500 },
    );
  }

  // La configuracion se restaura con el mundo: es lo que devuelve el servidor
  // al estado exacto de la copia, incluida la lista de mods. La actual se
  // guarda con fecha antes de sobrescribir, asi que hay marcha atras.
  let configFailed = null;
  if (configs.length) {
    for (const cfg of configs) {
      const target = resolveInside(CFG.serverCfgDir, cfg);
      if (await exists(target)) {
        await fsp.copyFile(target, `${target}.${stamp()}.bak`).catch(() => {});
        await pruneBaks(target);
      }
    }
    // Una sola pasada por el archivo, y el mismo timeout que el mundo: 120 s
    // se quedaban cortos si el .tar.gz es grande y hay que recorrerlo entero.
    const rc = await run(
      'tar', ['-xzf', full, '-C', path.resolve(CFG.serverCfgDir), ...configs],
      { timeout: 900000 },
    );
    // Antes se descartaba el error en silencio y el panel decia "restaurado"
    // con la lista de mods sin recuperar, que es justo lo que promete.
    if (rc.code !== 0) {
      configFailed = rc.stderr.trim().slice(0, 200) || 'no se pudo restaurar la configuracion';
    }
  }

  return { world, movedTo, config: configFailed ? [] : configs, configFailed };
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
  //
  // Si la copia falla NO seguimos: antes el .catch se lo tragaba y el writeFile
  // truncaba igual, dejando el fichero cortado y sin copia de la version buena.
  if (await exists(file)) {
    try {
      await fsp.copyFile(file, `${file}.${stamp()}.bak`);
    } catch (e) {
      throw Object.assign(
        new Error(`no se pudo crear la copia previa (${e.code || e.message}); no se ha tocado el fichero`),
        { status: 507 },
      );
    }
    await pruneBaks(file);
  }

  // Escritura atomica: temporal, fsync y rename. writeFile abre con 'w', asi que
  // un fallo a mitad dejaba el .ini vacio y el servidor arrancaba sin mods, sin
  // contrasena y con todos los ajustes por defecto.
  const tmp = `${file}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
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
  backupWorld, listBackups, backupPath, deleteBackup, restoreBackup, sweepPartials,
  readConfig, writeConfig, listConfigBaks,
};
