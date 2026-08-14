'use strict';

/**
 * Lectura y escritura puntual del .ini del servidor.
 *
 * Regla de oro: NUNCA se crea una clave que no exista ya en el fichero. Cada
 * version de Project Zomboid tiene su propio juego de opciones, e inventar una
 * linea que el servidor no reconoce es la forma rapida de romper el arranque.
 * Si una clave no esta, se ignora en silencio y el panel simplemente no la
 * muestra.
 */

/** Convierte el .ini en un objeto plano {clave: valor}. */
function parseIni(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Unicas claves que el panel puede CREAR si no estan en el fichero. Son
 * opciones estandar de Project Zomboid; el servidor genera su .ini sin algunas
 * de ellas y entonces usa su valor interno por defecto, asi que escribirlas es
 * la unica forma de cambiarlas.
 *
 * Esta lista es la frontera de seguridad y vive en el servidor a proposito: el
 * navegador puede pedir cualquier cosa, pero aqui solo pasan estas.
 */
const CREATABLE = new Set([
  'PublicName', 'PublicDescription', 'Password', 'MaxPlayers', 'Public', 'Open', 'PVP',
  'MapRemotePlayerVisibility', 'DisplayUserName', 'ShowFirstAndLastName', 'Faction',
  'AllowCoop', 'SafetySystem', 'AnnounceDeath', 'GlobalChat',
  'MinutesPerPage', 'HoursForLootRespawn', 'SpeedLimit', 'SleepAllowed', 'SleepNeeded',
  'NoFire', 'PauseEmpty',
  'SaveWorldEveryMinutes', 'BackupsCount', 'BackupsOnStart', 'BackupsOnVersionChange',
  'BackupsPeriod',
]);

/**
 * Aplica {clave: valor} sobre el texto del .ini reemplazando lineas completas.
 * Con opts.allowCreate, las claves de CREATABLE que falten se añaden al final.
 * Devuelve { text, applied, created, skipped }.
 */
function applyIni(text, changes, opts = {}) {
  const allowCreate = Boolean(opts.allowCreate);
  let out = String(text || '');
  const applied = [];
  const created = [];
  const skipped = [];

  for (const [key, rawVal] of Object.entries(changes || {})) {
    if (!KEY_RE.test(key)) { skipped.push(key); continue; }

    // un salto de linea partiria el fichero en dos ajustes distintos
    const value = String(rawVal == null ? '' : rawVal).replace(/[\r\n]+/g, ' ').trim();

    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(out)) {
      out = out.replace(re, `${key}=${value}`);
      applied.push(key);
      continue;
    }

    if (allowCreate && CREATABLE.has(key)) {
      out = `${out.replace(/\s*$/, '')}\n${key}=${value}\n`;
      created.push(key);
    } else {
      skipped.push(key);
    }
  }

  return { text: out, applied, created, skipped };
}

module.exports = { parseIni, applyIni, CREATABLE };
