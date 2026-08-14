'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const {
  CFG, run, exists, dirSize, safeRelPath, isSafeName, resolveInside,
  iniGetList, iniSetList,
} = require('./util');

/* ------------------------------------------------------------- lectura ini */

async function readIni() {
  try { return await fsp.readFile(CFG.iniFile, 'utf8'); }
  catch { return ''; }
}

async function writeIni(text) {
  await fsp.mkdir(path.dirname(CFG.iniFile), { recursive: true });
  await fsp.writeFile(CFG.iniFile, text, 'utf8');
}

/* --------------------------------------------------------- parseo mod.info */

async function parseModInfo(file) {
  const raw = await fsp.readFile(file, 'utf8').catch(() => '');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 1 || line.trim().startsWith('#')) continue;
    const k = line.slice(0, eq).trim().toLowerCase();
    const v = line.slice(eq + 1).trim();
    if (!(k in out)) out[k] = v;
  }
  return {
    id: out.id || '',
    name: out.name || out.id || '',
    description: out.description || '',
    version: out.modversion || out.version || '',
    poster: out.poster || '',
  };
}

/** Busca recursivamente (max 4 niveles) los mod.info bajo `dir`. */
async function findModInfos(dir, depth = 0, acc = []) {
  if (depth > 4) return acc;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return acc; }

  const info = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'mod.info');
  if (info) {
    acc.push(path.join(dir, info.name));
    // seguimos bajando: B42 anida mods por version (mods/X/42/mod.info)
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      await findModInfos(path.join(dir, e.name), depth + 1, acc);
    }
  }
  return acc;
}

/* ------------------------------------------------------------- listado */

async function listMods() {
  await fsp.mkdir(CFG.modsDir, { recursive: true });
  const ini = await readIni();
  const enabledIds = iniGetList(ini, 'Mods');
  const workshop = iniGetList(ini, 'WorkshopItems');

  let dirs = [];
  try {
    dirs = (await fsp.readdir(CFG.modsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { /* carpeta vacia */ }

  const mods = [];
  for (const folder of dirs) {
    const full = path.join(CFG.modsDir, folder);
    const infos = await findModInfos(full);
    const parsed = [];
    for (const f of infos) {
      const meta = await parseModInfo(f);
      if (meta.id) parsed.push(meta);
    }
    // deduplicamos por id (B42 repite el mod en varias carpetas de version)
    const seen = new Set();
    const unique = parsed.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));

    const [size, stat] = await Promise.all([
      dirSize(full),
      fsp.stat(full).catch(() => null),
    ]);

    mods.push({
      folder,
      size,
      mtime: stat ? stat.mtimeMs : 0,
      entries: unique,
      ids: unique.map((m) => m.id),
      enabled: unique.some((m) => enabledIds.includes(m.id)),
      valid: unique.length > 0,
    });
  }

  mods.sort((a, b) => a.folder.localeCompare(b.folder));

  // ids activos en el .ini que no corresponden a ninguna carpeta local:
  // vienen de mods del Workshop que descarga el propio servidor
  const localIds = new Set(mods.flatMap((m) => m.ids));
  const orphanIds = enabledIds.filter((id) => !localIds.has(id));

  return { mods, enabledIds, workshop, orphanIds };
}

/* ------------------------------------------------------- activar/desactivar */

async function setModEnabled(modId, enabled) {
  const id = String(modId || '').trim();
  if (!id || !/^[\w .\-]{1,120}$/.test(id)) {
    throw Object.assign(new Error('id de mod invalido'), { status: 400 });
  }
  const ini = await readIni();
  if (!ini) throw Object.assign(new Error('el .ini aun no existe; arranca el servidor una vez'), { status: 409 });

  let list = iniGetList(ini, 'Mods');
  if (enabled && !list.includes(id)) list.push(id);
  if (!enabled) list = list.filter((x) => x !== id);

  await writeIni(iniSetList(ini, 'Mods', list));
  return list;
}

async function setWorkshopItems(ids) {
  const clean = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((x) => String(x).trim())
      .filter((x) => /^\d{4,12}$/.test(x)),
  )];
  const ini = await readIni();
  if (!ini) throw Object.assign(new Error('el .ini aun no existe; arranca el servidor una vez'), { status: 409 });
  await writeIni(iniSetList(ini, 'WorkshopItems', clean));
  return clean;
}

async function setEnabledIds(ids) {
  const clean = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((x) => String(x).trim())
      .filter((x) => x && /^[\w .\-]{1,120}$/.test(x)),
  )];
  const ini = await readIni();
  if (!ini) throw Object.assign(new Error('el .ini aun no existe; arranca el servidor una vez'), { status: 409 });
  await writeIni(iniSetList(ini, 'Mods', clean));
  return clean;
}

/* ------------------------------------------------------------------ borrar */

async function deleteMod(folder) {
  if (!isSafeName(folder)) throw Object.assign(new Error('nombre invalido'), { status: 400 });
  const full = resolveInside(CFG.modsDir, folder);
  if (!await exists(full)) throw Object.assign(new Error('no existe'), { status: 404 });

  // desactivamos sus ids en el .ini antes de borrar la carpeta
  const infos = await findModInfos(full);
  const ids = [];
  for (const f of infos) {
    const meta = await parseModInfo(f);
    if (meta.id) ids.push(meta.id);
  }
  if (ids.length) {
    const ini = await readIni();
    if (ini) {
      const list = iniGetList(ini, 'Mods').filter((x) => !ids.includes(x));
      await writeIni(iniSetList(ini, 'Mods', list));
    }
  }

  await fsp.rm(full, { recursive: true, force: true });
  return ids;
}

/* ------------------------------------------------------------- instalacion */

function looksLikeModRoot(names) {
  const lower = names.map((n) => n.toLowerCase());
  return lower.includes('mod.info') || lower.includes('media');
}

/**
 * Instala un .zip. Se extrae a un temporal, se inspecciona la raiz y solo
 * despues se mueve a `mods/`, para que un zip sin carpeta contenedora no
 * vuelque sus ficheros sueltos sobre el resto de mods.
 */
async function installZip(zipPath, originalName) {
  const stage = path.join(CFG.tmpDir, `x-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(stage, { recursive: true });

  try {
    const r = await run('unzip', ['-o', '-qq', zipPath, '-d', stage], { timeout: 300000 });
    if (r.code !== 0) {
      throw Object.assign(new Error(`no se pudo descomprimir: ${r.stderr.trim().slice(0, 200)}`), { status: 400 });
    }

    // Bajamos por las carpetas envoltorio que meten muchos zips
    // ("MiMod-v2/MiMod/mod.info") hasta dar con la raiz real del mod.
    let root = stage;
    let entries = await fsp.readdir(root, { withFileTypes: true });
    for (let i = 0; i < 3; i++) {
      if (looksLikeModRoot(entries.map((e) => e.name))) break;
      if (entries.length !== 1 || !entries[0].isDirectory()) break;
      root = path.join(root, entries[0].name);
      entries = await fsp.readdir(root, { withFileTypes: true });
    }

    const installed = [];
    const move = async (from, folderName) => {
      const dest = resolveInside(CFG.modsDir, folderName);
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(from, dest).catch(async () => {
        await fsp.mkdir(dest, { recursive: true });
        await run('cp', ['-a', `${from}/.`, dest]);
      });
      installed.push(folderName);
    };

    if (looksLikeModRoot(entries.map((e) => e.name))) {
      // el propio zip ES el mod: usamos el nombre del fichero como carpeta
      const base = path.basename(originalName || 'mod', '.zip').replace(/[^\w .\-]/g, '_') || 'mod';
      await move(root, base);
    } else {
      for (const e of entries) {
        if (e.isDirectory()) await move(path.join(root, e.name), e.name);
      }
    }

    if (!installed.length) {
      throw Object.assign(new Error('el zip no contiene ninguna carpeta de mod'), { status: 400 });
    }
    return installed;
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** Instala ficheros sueltos conservando su ruta relativa (drag&drop de carpeta). */
async function installFiles(files) {
  const roots = new Set();
  for (const f of files) {
    const rel = safeRelPath(f.relPath);
    if (!rel) continue;
    const dest = resolveInside(CFG.modsDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(f.tmpPath, dest).catch(async () => {
      await fsp.copyFile(f.tmpPath, dest);
      await fsp.rm(f.tmpPath, { force: true });
    });
    roots.add(rel.split('/')[0]);
  }
  if (!roots.size) throw Object.assign(new Error('no se recibio ningun fichero valido'), { status: 400 });
  return [...roots];
}

module.exports = {
  listMods, setModEnabled, setEnabledIds, setWorkshopItems,
  deleteMod, installZip, installFiles, readIni, writeIni,
};
