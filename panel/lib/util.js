'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { execFile } = require('child_process');

/* ------------------------------------------------------------------ config */

const CFG = {
  port: parseInt(process.env.PANEL_PORT || '8080', 10),
  user: process.env.PANEL_USER || 'admin',
  passHash: process.env.PANEL_PASS_HASH || '',
  secret: process.env.PANEL_SECRET || crypto.randomBytes(32).toString('hex'),

  unit: process.env.PZ_UNIT || 'pzserver',
  sysUser: process.env.PZ_SYS_USER || 'pzuser',
  serverDir: process.env.PZ_SERVER_DIR || '/home/pzuser/pzserver',
  zomboidDir: process.env.PZ_ZOMBOID_DIR || '/home/pzuser/Zomboid',
  serverName: process.env.PZ_SERVER_NAME || 'pzserver',
  consoleLog: process.env.PZ_CONSOLE_LOG || '/opt/pzpanel/logs/console.log',
  binDir: process.env.PZ_BIN_DIR || '/opt/pzpanel/bin',
  backupDir: process.env.PZ_BACKUP_DIR || '/opt/pzpanel/backups',
  tmpDir: process.env.PZ_TMP_DIR || '/opt/pzpanel/tmp',
};

CFG.modsDir = path.join(CFG.zomboidDir, 'mods');
CFG.savesDir = path.join(CFG.zomboidDir, 'Saves', 'Multiplayer');
CFG.serverCfgDir = path.join(CFG.zomboidDir, 'Server');
CFG.iniFile = path.join(CFG.serverCfgDir, `${CFG.serverName}.ini`);
CFG.sandboxFile = path.join(CFG.serverCfgDir, `${CFG.serverName}_SandboxVars.lua`);

/* -------------------------------------------------------------- ejecucion */

/** execFile con promesa que NO rechaza: devuelve {code, stdout, stderr}. */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err || null,
        });
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- auth */

function verifyPassword(plain) {
  const [salt, hash] = String(CFG.passHash).split(':');
  if (!salt || !hash) return false;
  let calc;
  try {
    calc = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  } catch { return false; }
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ rutas */

/**
 * Convierte una ruta relativa recibida del cliente en algo seguro:
 * sin componentes vacios, sin '.', sin '..', sin raiz absoluta.
 */
function safeRelPath(input) {
  return String(input || '')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .filter((s) => !/^[A-Za-z]:$/.test(s))
    .join('/');
}

/** Nombre simple de carpeta (mundo, mod, backup). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.\-()[\]]{0,120}$/;

function isSafeName(name) {
  return SAFE_NAME.test(String(name || '')) && !String(name).includes('..');
}

/** Resuelve `name` dentro de `base` y garantiza que no se escapa del arbol. */
function resolveInside(base, name) {
  const full = path.resolve(base, safeRelPath(name));
  const root = path.resolve(base);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw Object.assign(new Error('ruta fuera del directorio permitido'), { status: 400 });
  }
  return full;
}

/* ---------------------------------------------------------------- ficheros */

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function dirSize(dir) {
  const r = await run('du', ['-sb', dir], { timeout: 60000 });
  const n = parseInt(r.stdout.trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : 0;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/* --------------------------------------------------------------- listas ini
 * Las claves 'Mods' y 'WorkshopItems' del .ini son listas separadas por ';'.
 * Se editan preservando el resto del fichero intacto.
 */

function iniGetList(text, key) {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  if (!m) return [];
  return m[1].split(';').map((s) => s.trim()).filter(Boolean);
}

function iniSetList(text, key, arr) {
  const line = `${key}=${arr.join(';')}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

function iniGet(text, key) {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

module.exports = {
  CFG, run, sleep,
  verifyPassword,
  safeRelPath, isSafeName, resolveInside,
  exists, dirSize, fmtBytes,
  iniGetList, iniSetList, iniGet,
};
