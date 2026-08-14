'use strict';

/**
 * Lectura y escritura de <servidor>_SandboxVars.lua.
 *
 * El fichero documenta cada ajuste en los comentarios que lo preceden:
 *
 *   -- The number of in-game minutes it takes to read one page of a skill
 *   -- book. Min: 0.00 Max: 60.00 Default: 2.00
 *   MinutesPerPage = 2.0,
 *
 *   -- How fast zombies move. Default = Random
 *   -- 1 = Sprinters
 *   -- 2 = Fast Shamblers
 *   Speed = 4,
 *
 * De ahi sacamos tipo, rango, valor por defecto, descripcion y la lista de
 * opciones. La interfaz se genera con eso, asi que se adapta sola a la version
 * del servidor y a los mods que añadan ajustes: aqui no hay nada hardcodeado.
 *
 * Al escribir solo se sustituye el valor en la linea exacta donde ya estaba.
 * Nunca se crea ni se borra nada, y comentarios, orden e indentacion quedan
 * intactos.
 */

const RE_COMMENT = /^--\s?(.*)$/;
const RE_TABLE_OPEN = /^([A-Za-z_]\w*)\s*=\s*\{$/;
const RE_TABLE_CLOSE = /^\},?$/;
const RE_ENTRY = /^([A-Za-z_]\w*)\s*=\s*(.+?),?$/;
const RE_OPTION = /^(\d+)\s*=\s*(.+)$/;
const RE_RANGE = /Min:\s*(-?[\d.]+)\s+Max:\s*(-?[\d.]+)\s+Default:\s*(-?[\d.]+)/;

/** Claves que nunca deben tocarse desde el panel. */
const LOCKED = new Set(['VERSION']);

function parseValue(raw) {
  if (raw === 'true' || raw === 'false') return { type: 'bool', value: raw === 'true' };
  if (/^-?\d+$/.test(raw)) return { type: 'int', value: Number(raw) };
  if (/^-?\d*\.\d+$/.test(raw)) return { type: 'float', value: Number(raw) };
  const s = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (s) return { type: 'string', value: s[1].replace(/\\"/g, '"') };
  return { type: 'raw', value: raw };
}

function parseComment(lines) {
  const options = [];
  const desc = [];
  let min; let max; let def;

  for (const line of lines) {
    const opt = RE_OPTION.exec(line);
    if (opt) { options.push({ v: opt[1], label: opt[2].trim() }); continue; }

    const range = RE_RANGE.exec(line);
    if (range) {
      min = Number(range[1]); max = Number(range[2]); def = Number(range[3]);
      const before = line.slice(0, range.index).trim();
      if (before) desc.push(before);
      continue;
    }
    desc.push(line);
  }

  return {
    desc: desc.join(' ')
      .replace(/<BHC>|<RGB:[^>]*>/g, ' ')     // marcado de color del juego
      .replace(/\s+/g, ' ')
      .trim(),
    options,
    min,
    max,
    def,
  };
}

/** Devuelve la lista de ajustes con su metadato y el numero de linea. */
function parseSandbox(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const stack = [];
  let comment = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    const c = RE_COMMENT.exec(t);
    if (c) { comment.push(c[1]); continue; }

    if (!t) { comment = []; continue; }

    if (RE_TABLE_CLOSE.test(t)) { stack.pop(); comment = []; continue; }

    const open = RE_TABLE_OPEN.exec(t);
    if (open) { stack.push(open[1]); comment = []; continue; }

    const entry = RE_ENTRY.exec(t);
    if (entry) {
      const key = entry[1];
      const parsed = parseValue(entry[2].trim());
      // el primer nivel es la propia tabla SandboxVars, no forma parte de la ruta
      const path = [...stack.slice(1), key].join('.');
      if (parsed.type !== 'raw' && !LOCKED.has(key)) {
        out.push({ path, key, line: i, ...parsed, ...parseComment(comment) });
      }
      comment = [];
      continue;
    }
    comment = [];
  }
  return out;
}

/** Formatea un valor respetando el tipo original y recortandolo al rango. */
function formatValue(item, raw) {
  if (item.type === 'bool') {
    return String(raw) === 'true' ? 'true' : 'false';
  }
  if (item.type === 'int' || item.type === 'float') {
    let n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    if (item.min != null) n = Math.max(item.min, n);
    if (item.max != null) n = Math.min(item.max, n);
    if (item.type === 'int') return String(Math.round(n));
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
  }
  if (item.type === 'string') {
    const clean = String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ');
    return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return null;
}

/**
 * Aplica {ruta: valor}. Solo reescribe el valor de lineas que ya existen;
 * cualquier ruta desconocida se devuelve en `skipped` sin tocar el fichero.
 */
function applySandbox(text, changes) {
  const lines = String(text || '').split(/\r?\n/);
  const byPath = new Map(parseSandbox(text).map((it) => [it.path, it]));
  const applied = [];
  const skipped = [];

  for (const [path, value] of Object.entries(changes || {})) {
    const item = byPath.get(path);
    if (!item) { skipped.push(path); continue; }

    const formatted = formatValue(item, value);
    if (formatted === null) { skipped.push(path); continue; }

    const m = /^(\s*[A-Za-z_]\w*\s*=\s*)(.*?)(,?)(\s*)$/.exec(lines[item.line]);
    if (!m) { skipped.push(path); continue; }

    lines[item.line] = m[1] + formatted + m[3] + m[4];
    applied.push(path);
  }

  return { text: lines.join('\n'), applied, skipped };
}

module.exports = { parseSandbox, applySandbox };
