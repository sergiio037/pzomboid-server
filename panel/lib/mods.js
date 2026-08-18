'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const {
  CFG, run, exists, dirSize, safeRelPath, isSafeName, resolveInside, quarantine,
  iniGetList, iniSetList,
} = require('./util');
// worlds solo depende de util, asi que no hay ciclo. Se reutiliza su
// writeConfig para que TODA escritura del .ini pase por el mismo sitio:
// copia fechada, poda y escritura atomica.
const worlds = require('./worlds');

/* ------------------------------------------------------------- lectura ini */

async function readIni() {
  try { return await fsp.readFile(CFG.iniFile, 'utf8'); }
  catch { return ''; }
}

/**
 * Toda modificacion del .ini desde aqui (activar/desactivar mods, IDs del
 * Workshop, borrar un mod) pasa por writeConfig.
 *
 * Antes esto era un writeFile pelado, sin copia previa y sin atomicidad: es
 * exactamente la ruta por la que se perdio la lista de mods al desactivarlos
 * de uno en uno, y un fallo a media escritura dejaba el .ini vacio.
 */
async function writeIni(text) {
  await worlds.writeConfig('ini', text);
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

const PZ_WORKSHOP_APPID = '108600';

/**
 * Los mods viven en dos sitios distintos y hay que mirar en los dos:
 *   - manuales : <Zomboid>/mods/<Mod>/mod.info
 *   - Workshop : steamapps/workshop/content/108600/<idWorkshop>/mods/<Mod>/mod.info
 *
 * SteamCMD deja el contenido del Workshop junto a la instalacion del servidor,
 * pero segun como se lance puede acabar bajo Zomboid o bajo ~/Steam. Probamos
 * las tres rutas y usamos las que existan.
 */
function workshopRoots() {
  const rel = ['steamapps', 'workshop', 'content', PZ_WORKSHOP_APPID];
  return [
    path.join(CFG.serverDir, ...rel),
    path.join(CFG.zomboidDir, ...rel),
    path.join(path.dirname(CFG.zomboidDir), 'Steam', ...rel),
  ];
}

/** Lee una carpeta que contiene uno o varios mod.info y devuelve sus metadatos. */
async function readModFolder(full) {
  const infos = await findModInfos(full);
  const parsed = [];
  for (const f of infos) {
    const meta = await parseModInfo(f);
    if (meta.id) parsed.push(meta);
  }
  // deduplicamos por id: B42 repite el mod en una carpeta por version
  const seen = new Set();
  const entries = parsed.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));

  const [size, stat] = await Promise.all([
    dirSize(full),
    fsp.stat(full).catch(() => null),
  ]);

  return { entries, ids: entries.map((m) => m.id), size, mtime: stat ? stat.mtimeMs : 0 };
}

async function scanLocal() {
  await fsp.mkdir(CFG.modsDir, { recursive: true });
  let dirs = [];
  try {
    dirs = (await fsp.readdir(CFG.modsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { return []; }

  const out = [];
  for (const folder of dirs) {
    const data = await readModFolder(path.join(CFG.modsDir, folder));
    out.push({ folder, source: 'local', workshopId: null, ...data });
  }
  return out;
}

async function scanWorkshop() {
  const out = [];
  const seenIds = new Set();

  for (const root of workshopRoots()) {
    let dirs = [];
    try {
      dirs = (await fsp.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name);
    } catch { continue; }

    for (const wsId of dirs) {
      if (seenIds.has(wsId)) continue;
      seenIds.add(wsId);
      const data = await readModFolder(path.join(root, wsId));
      out.push({ folder: wsId, source: 'workshop', workshopId: wsId, ...data });
    }
  }
  return out;
}

async function listMods() {
  const ini = await readIni();
  const enabledIds = iniGetList(ini, 'Mods');
  const workshop = iniGetList(ini, 'WorkshopItems');

  const [local, ws] = await Promise.all([scanLocal(), scanWorkshop()]);
  const mods = [...local, ...ws].map((m) => ({
    ...m,
    enabled: m.ids.some((id) => enabledIds.includes(id)),
    valid: m.ids.length > 0,
  }));

  mods.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'local' ? -1 : 1;
    return (a.entries[0]?.name || a.folder).localeCompare(b.entries[0]?.name || b.folder);
  });

  const foundIds = new Set(mods.flatMap((m) => m.ids));
  const downloadedWs = new Set(ws.map((m) => m.workshopId));

  return {
    mods,
    enabledIds,
    workshop,
    // en Mods= pero sin carpeta en disco: id mal escrito o mod sin descargar
    orphanIds: enabledIds.filter((id) => !foundIds.has(id)),
    // en WorkshopItems= pero no descargado todavia
    pendingWorkshop: workshop.filter((id) => !downloadedWs.has(id)),
    // descargado y con Mod ID, pero sin activar en Mods=
    inactiveIds: mods
      .filter((m) => m.valid && !m.enabled)
      .flatMap((m) => m.ids.map((id) => ({ id, source: m.source, folder: m.folder }))),
  };
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

  // A la papelera, no rm: un mod local subido a mano no esta en el Workshop.
  const moved = await quarantine(full, CFG.modsTrashDir, 'borrado');
  return { ids, quarantined: moved.name };
}

/* ------------------------------------------------------------- instalacion */

function looksLikeModRoot(names) {
  const lower = names.map((n) => n.toLowerCase());
  if (lower.includes('mod.info') || lower.includes('media')) return true;
  // B42 reparte un mismo mod en <Mod>/42/mod.info junto a <Mod>/common/.
  // Sin esto, el zip se trataba como una coleccion y quedaban carpetas
  // sueltas mods/42 y mods/common que el siguiente zip volvia a pisar.
  return lower.includes('common') || lower.some((n) => /^\d+$/.test(n));
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
    const raiz = path.resolve(CFG.modsDir);

    const move = async (from, folderName) => {
      // Sin esto, un zip llamado '..zip' daba folderName '.', resolveInside
      // devolvia la propia carpeta mods/ y el rm -rf se la llevaba entera.
      if (!isSafeName(folderName)) {
        throw Object.assign(new Error(`nombre de carpeta invalido: ${folderName}`), { status: 400 });
      }
      const dest = resolveInside(CFG.modsDir, folderName);
      if (dest === raiz || path.dirname(dest) !== raiz) {
        throw Object.assign(new Error('destino invalido'), { status: 400 });
      }

      // La version anterior se aparta, no se borra: un mod subido a mano no
      // esta en el Workshop y no habria forma de recuperarlo.
      if (await exists(dest)) await quarantine(dest, CFG.modsTrashDir, 'sustituido');

      try {
        await fsp.rename(from, dest);
      } catch {
        await fsp.mkdir(dest, { recursive: true });
        const cp = await run('cp', ['-a', `${from}/.`, dest]);
        // antes no se miraba el rc: una copia parcial se daba por instalada
        if (cp.code !== 0) {
          throw Object.assign(
            new Error(`no se pudo instalar ${folderName}: ${cp.stderr.trim().slice(0, 160)}`),
            { status: 500 },
          );
        }
      }
      installed.push(folderName);
    };

    if (looksLikeModRoot(entries.map((e) => e.name))) {
      // el propio zip ES el mod: usamos el nombre del fichero como carpeta
      let base = path.basename(originalName || 'mod', '.zip').replace(/[^\w .\-]/g, '_');
      if (!isSafeName(base)) base = 'mod';
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
