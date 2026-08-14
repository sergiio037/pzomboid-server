'use strict';

/* ========================================================= utilidades === */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: opts.body && !(opts.body instanceof FormData)
      ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch { /* respuesta vacia */ }
  if (res.status === 401) { showLogin(); throw new Error('sesión expirada'); }
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
}

const jpost = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) });
const jdel  = (url) => api(url, { method: 'DELETE' });

/* --------------------------------------------------------------- toasts */

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0'; el.style.transform = 'translateX(14px)';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 6000 : 3400);
}

function confirmDialog(title, text, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-ok').textContent = okLabel;
    modal.classList.remove('hidden');

    const close = (v) => {
      modal.classList.add('hidden');
      $('#modal-ok').removeEventListener('click', onOk);
      $('#modal-cancel').removeEventListener('click', onCancel);
      resolve(v);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    $('#modal-ok').addEventListener('click', onOk);
    $('#modal-cancel').addEventListener('click', onCancel);
  });
}

/* ============================================================== login === */

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  if (ws) { try { ws.close(); } catch {} ws = null; }
  clearInterval(statusTimer); statusTimer = null;
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  boot();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn'), err = $('#login-error');
  err.hidden = true; btn.disabled = true; btn.textContent = 'Entrando…';
  try {
    await jpost('/api/login', { user: $('#login-user').value, pass: $('#login-pass').value });
    $('#login-pass').value = '';
    showApp();
  } catch (e2) {
    err.textContent = e2.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* =============================================================== nav ==== */

const TITLES = {
  overview: 'Resumen', console: 'Consola', mods: 'Mods',
  worlds: 'Mundos', settings: 'Ajustes', config: 'Configuración',
};

function goto(view) {
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((s) => s.classList.toggle('is-active', s.dataset.view === view));
  $('#view-title').textContent = TITLES[view] || view;
  location.hash = view;
  if (view === 'mods') loadMods();
  if (view === 'worlds') loadWorlds();
  if (view === 'settings') loadSettings();
  if (view === 'config') loadConfig(cfgKind);
  if (view === 'console') scrollConsole(true);
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (b) goto(b.dataset.view);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) goto(b.dataset.goto);
});

/* ==================================================== datos de conexion == */

let endpoint = { ip: null, port: '16261', hasPassword: false };

function paintEndpoint(ep) {
  endpoint = {
    // sin metadatos de GCP caemos al host del propio panel: es la misma maquina
    ip: (ep && ep.ip) || location.hostname,
    port: (ep && ep.port) || '16261',
    hasPassword: Boolean(ep && ep.hasPassword),
  };
  const addr = `${endpoint.ip}:${endpoint.port}`;
  $('#connect-addr').textContent = addr;
  $('#connect-note').textContent = endpoint.hasPassword
    ? 'Pégala en Unirse a servidor → Añadir servidor. El servidor pide contraseña.'
    : 'Pégala en el juego: Unirse a servidor → Añadir servidor';
}

/**
 * steam://connect/IP:PUERTO no sirve para Zomboid: Steam busca el servidor en
 * su lista maestra y, si no esta publicado, cierra la ventana sin hacer nada.
 * Copiamos la direccion y lanzamos el juego, que es lo unico fiable.
 */
$('#connect-steam').addEventListener('click', async () => {
  const addr = `${endpoint.ip}:${endpoint.port}`;
  const done = await copyText(addr);
  toast(done ? `${addr} copiado. Abriendo el juego…` : 'Abriendo el juego…', 'ok');
  window.location.href = 'steam://rungameid/108600';
});

/**
 * navigator.clipboard solo existe en contextos seguros (HTTPS o localhost).
 * Este panel va por HTTP sobre una IP, asi que hace falta el metodo antiguo.
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const done = document.execCommand('copy');
    ta.remove();
    return done;
  } catch { return false; }
}

async function copyAndTell(text) {
  const done = await copyText(text);
  toast(done ? `Copiado: ${text}` : 'No se pudo copiar, selecciónalo a mano', done ? 'ok' : 'err');
}

$('#copy-addr').addEventListener('click', () => copyAndTell(`${endpoint.ip}:${endpoint.port}`));
$('#copy-ip').addEventListener('click', () => copyAndTell(endpoint.ip));

/* ============================================================ estado ==== */

let statusTimer = null;
let lastRunning = null;

function paintState(st) {
  const pill = $('#state-pill'), txt = $('#state-text');
  pill.classList.remove('on', 'busy', 'err');

  const map = {
    active:     ['on',   'En línea'],
    activating: ['busy', 'Arrancando…'],
    deactivating: ['busy', 'Parando…'],
    failed:     ['err',  'Fallo'],
    inactive:   ['',     'Apagado'],
  };
  const [cls, label] = map[st.state] || ['', st.state || 'desconocido'];
  if (cls) pill.classList.add(cls);
  txt.textContent = label;

  paintEndpoint(st.endpoint);

  $('#ov-state').textContent = label;
  $('#ov-substate').textContent = `systemd: ${st.state}`;
  $('#ov-mem').textContent = st.proc ? `${st.proc.memMB} MB` : '—';
  $('#ov-cpu').textContent = st.proc ? `${st.proc.cpu.toFixed(0)} %` : '—';
  $('#ov-uptime').textContent = st.proc ? `activo ${fmtDur(st.proc.uptimeSec)}` : 'sin arrancar';
  $('#ov-pid').textContent = st.pid || '—';
  $('#ov-world').textContent = st.serverName;
  $('#ov-branch').textContent = st.branch === 'unstable' ? 'unstable (B42)' : 'stable (B41)';
  $('#brand-server').textContent = st.serverName;

  const h = st.host || {};
  $('#ov-host-uptime').textContent = fmtDur(h.uptimeSec);
  $('#side-cpu').textContent = h.load1 != null ? `${h.load1.toFixed(2)} / ${h.cpuCount}` : '—';
  $('#side-mem').textContent = h.memTotal
    ? `${fmtBytes(h.memTotal - h.memFree)} / ${fmtBytes(h.memTotal)}` : '—';
  $('#side-disk').textContent = h.diskTotal
    ? `${fmtBytes(h.diskUsed)} / ${fmtBytes(h.diskTotal)}` : '—';

  $$('[data-power]').forEach((b) => {
    const a = b.dataset.power;
    b.disabled = (a === 'start' && st.running) || (a !== 'start' && !st.running);
  });

  // al pasar de apagado a encendido refrescamos jugadores
  if (lastRunning !== null && lastRunning !== st.running) {
    setTimeout(refreshPlayers, st.running ? 25000 : 500);
  }
  lastRunning = st.running;
}

async function refreshStatus() {
  try { paintState((await api('/api/status')).status); }
  catch { /* la sesion o la red pueden caer momentaneamente */ }
}

async function refreshPlayers() {
  try {
    const { players, offline } = await api('/api/players');
    if (offline || players.count == null) {
      $('#ov-players').textContent = offline ? '0' : '—';
      $('#ov-players-names').textContent = offline ? 'servidor apagado' : 'sin respuesta';
      return;
    }
    $('#ov-players').textContent = players.count;
    $('#ov-players-names').textContent = players.names.length
      ? players.names.join(', ') : 'nadie conectado';
  } catch { /* el servidor puede estar cargando el mapa */ }
}

$$('[data-power]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.power;
    const labels = { start: 'Encender', restart: 'Reiniciar', stop: 'Apagar' };
    if (action !== 'start') {
      const okGo = await confirmDialog(
        `${labels[action]} el servidor`,
        'Se guardará la partida y se expulsará a los jugadores conectados.',
        labels[action],
      );
      if (!okGo) return;
    }
    $$('[data-power]').forEach((b) => { b.disabled = true; });
    toast(`${labels[action]}…`, 'warn');
    try {
      await jpost('/api/power', { action });
      toast('Hecho', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    setTimeout(refreshStatus, 1200);
  });
});

$('#btn-update').addEventListener('click', async () => {
  const okGo = await confirmDialog('Actualizar el servidor',
    'Se detendrá, se descargará la última versión con SteamCMD y volverá a arrancar. Puede tardar varios minutos.',
    'Actualizar');
  if (!okGo) return;
  toast('Actualizando, no cierres la página…', 'warn');
  try { await jpost('/api/update'); toast('Servidor actualizado', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
  refreshStatus();
});

/* ============================================================ consola === */

let ws = null;
const CMD_HISTORY = [];
let histIdx = -1;

const QUICK_CMDS = [
  'players', 'save', 'quit', 'checkModsNeedUpdate', 'reloadoptions',
  'servermsg "texto"', 'kick "user"', 'banuser "user"', 'unbanuser "user"',
  'addusertowhitelist "user"', 'grantadmin "user"', 'teleport "a" "b"',
  'alarm', 'chopper', 'gunshot', 'startrain', 'stoprain', 'startstorm',
];

function classify(line) {
  if (/^\[panel\]/.test(line) || /^> /.test(line)) return 'l-panel';
  if (/\b(ERROR|SEVERE|Exception|FATAL)\b/i.test(line)) return 'l-err';
  if (/\bWARN(ING)?\b/i.test(line)) return 'l-warn';
  if (/\b(SERVER STARTED|Ready|connected|LOG {2}: General)\b/i.test(line)) return 'l-ok';
  return '';
}

function appendLines(lines, target) {
  const box = $(target);
  if (!box) return;
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const span = document.createElement('span');
    const cls = classify(line);
    if (cls) span.className = cls;
    span.textContent = `${line}\n`;
    frag.appendChild(span);
  }
  box.appendChild(frag);
  // no dejamos crecer el DOM indefinidamente
  while (box.childNodes.length > 1200) box.removeChild(box.firstChild);
}

function scrollConsole(force) {
  const box = $('#console-out');
  if (!box) return;
  if (force || $('#autoscroll').checked) box.scrollTop = box.scrollHeight;
  const mini = $('#ov-console');
  if (mini) mini.scrollTop = mini.scrollHeight;
}

function pushLines(lines) {
  appendLines(lines, '#console-out');
  appendLines(lines, '#ov-console');
  scrollConsole(false);
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/`);

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello') {
      $('#console-out').textContent = '';
      $('#ov-console').textContent = '';
      pushLines(msg.lines || []);
      scrollConsole(true);
    } else if (msg.type === 'log') {
      pushLines(msg.lines || []);
    } else if (msg.type === 'event') {
      pushLines([msg.text]);
    }
  };
  ws.onclose = () => { ws = null; setTimeout(() => { if (!$('#app').classList.contains('hidden')) connectWs(); }, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

$('#console-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#console-cmd');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  CMD_HISTORY.push(cmd); histIdx = CMD_HISTORY.length;
  try { await jpost('/api/console', { cmd }); }
  catch (err) { toast(err.message, 'err'); }
});

$('#console-cmd').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!CMD_HISTORY.length) return;
  e.preventDefault();
  histIdx += e.key === 'ArrowUp' ? -1 : 1;
  histIdx = Math.max(0, Math.min(CMD_HISTORY.length, histIdx));
  e.target.value = CMD_HISTORY[histIdx] || '';
});

$('#console-clear').addEventListener('click', () => { $('#console-out').textContent = ''; });

$('#cmd-chips').innerHTML = QUICK_CMDS
  .map((c) => `<button class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
$('#cmd-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  $('#console-cmd').value = b.dataset.chip;
  $('#console-cmd').focus();
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cmd]');
  if (!b) return;
  try { await jpost('/api/console', { cmd: b.dataset.cmd }); toast(`Enviado: ${b.dataset.cmd}`, 'ok'); }
  catch (err) { toast(err.message, 'err'); }
  if (b.dataset.cmd === 'players') setTimeout(refreshPlayers, 300);
});

/* =============================================================== mods === */

const ICON_TRASH = `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`;

async function loadMods() {
  try { renderMods(await api('/api/mods')); }
  catch (e) { toast(e.message, 'err'); }
}

function renderMods(data) {
  const { mods = [], enabledIds = [], workshop = [] } = data;
  $('#mods-count').textContent = mods.length;

  $('#mod-list').innerHTML = mods.length ? mods.map((m) => {
    const first = m.entries[0];
    const title = first ? first.name : m.folder;
    const meta = m.valid
      ? `${m.ids.join(', ')} · ${fmtBytes(m.size)}`
      : `sin mod.info válido · ${fmtBytes(m.size)}`;
    return `
      <div class="mod ${m.valid ? '' : 'invalid'}">
        <label class="switch" title="${m.valid ? 'Activar / desactivar' : 'No se puede activar'}">
          <input type="checkbox" data-toggle="${esc(m.ids[0] || '')}"
                 ${m.enabled ? 'checked' : ''} ${m.valid ? '' : 'disabled'}>
          <i></i>
        </label>
        <div class="mod-main">
          <div class="mod-name">${esc(title)}</div>
          <div class="mod-meta">${esc(meta)}</div>
        </div>
        <button class="icon-btn" data-del-mod="${esc(m.folder)}" title="Borrar mod">${ICON_TRASH}</button>
      </div>`;
  }).join('') : '<p class="empty">No hay mods locales. Arrastra un .zip o una carpeta arriba.</p>';

  $('#ws-list').innerHTML = workshop.length ? workshop.map((id) => `
    <span class="tag">${esc(id)}<button data-del-ws="${esc(id)}" title="Quitar">×</button></span>`).join('')
    : '<p class="empty">Sin IDs del Workshop.</p>';

  $('#modid-list').innerHTML = enabledIds.length ? enabledIds.map((id) => `
    <span class="tag">${esc(id)}<button data-del-modid="${esc(id)}" title="Quitar">×</button></span>`).join('')
    : '<p class="empty">Ningún mod activo.</p>';

  window.__mods = data;
}

$('#mods-refresh').addEventListener('click', loadMods);

$('#mod-list').addEventListener('change', async (e) => {
  const cb = e.target.closest('[data-toggle]');
  if (!cb) return;
  try {
    renderMods(await jpost('/api/mods/toggle', { id: cb.dataset.toggle, enabled: cb.checked }));
    toast(cb.checked ? 'Mod activado (reinicia para aplicar)' : 'Mod desactivado', 'ok');
  } catch (err) { toast(err.message, 'err'); loadMods(); }
});

$('#mod-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-mod]');
  if (!b) return;
  const folder = b.dataset.delMod;
  if (!await confirmDialog('Borrar mod', `Se eliminará la carpeta "${folder}" y se desactivará en el .ini.`, 'Borrar')) return;
  try { renderMods(await jdel(`/api/mods/${encodeURIComponent(folder)}`)); toast('Mod borrado', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});

$('#ws-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#ws-id');
  const id = input.value.trim();
  if (!/^\d{4,12}$/.test(id)) return toast('El ID del Workshop debe ser numérico', 'err');
  const ids = [...(window.__mods?.workshop || []), id];
  try { renderMods(await jpost('/api/mods/workshop', { ids })); input.value = ''; toast('Añadido', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});

$('#ws-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-ws]');
  if (!b) return;
  const ids = (window.__mods?.workshop || []).filter((x) => x !== b.dataset.delWs);
  try { renderMods(await jpost('/api/mods/workshop', { ids })); }
  catch (err) { toast(err.message, 'err'); }
});

$('#modid-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#modid-input');
  const id = input.value.trim();
  if (!id) return;
  const ids = [...(window.__mods?.enabledIds || []), id];
  try { renderMods(await jpost('/api/mods/enabled', { ids })); input.value = ''; toast('Añadido', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});

$('#modid-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-modid]');
  if (!b) return;
  const ids = (window.__mods?.enabledIds || []).filter((x) => x !== b.dataset.delModid);
  try { renderMods(await jpost('/api/mods/enabled', { ids })); }
  catch (err) { toast(err.message, 'err'); }
});

/* ------------------------------------------------------- subida de mods */

/**
 * Recorre lo soltado en el dropzone. Si el navegador expone la API de
 * entradas (Chrome/Edge/Firefox actuales) recuperamos carpetas completas
 * conservando su ruta relativa; si no, caemos a la lista plana de ficheros.
 */
async function collectDropped(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);

  if (!entries.length) {
    for (const f of dt.files) out.push({ file: f, path: f.name });
    return out;
  }

  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, `${prefix + entry.name}/`);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

function uploadMods(items) {
  if (!items.length) return;

  const fd = new FormData();
  // todos los 'paths' primero: multer conserva el orden y asi el backend
  // puede emparejar cada fichero con su ruta relativa
  for (const it of items) fd.append('paths', it.path);
  for (const it of items) fd.append('files', it.file, it.file.name);

  const bar = $('#upload-progress');
  const fill = bar.firstElementChild;
  bar.hidden = false; fill.style.width = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/mods/upload');
  xhr.withCredentials = true;

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) fill.style.width = `${(e.loaded / e.total * 100).toFixed(1)}%`;
  };
  xhr.onload = () => {
    bar.hidden = true;
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 401) return showLogin();
    if (xhr.status >= 400) return toast(data.error || `error ${xhr.status}`, 'err');
    renderMods(data);
    const n = (data.installed || []).length;
    toast(n ? `Instalado: ${data.installed.join(', ')}` : 'Subida completada', 'ok');
  };
  xhr.onerror = () => { bar.hidden = true; toast('Fallo de red durante la subida', 'err'); };

  toast(`Subiendo ${items.length} archivo(s)…`);
  xhr.send(fd);
}

const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation(); dz.classList.add('is-over');
}));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation();
  if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return;
  dz.classList.remove('is-over');
}));
dz.addEventListener('drop', async (e) => {
  try { uploadMods(await collectDropped(e.dataTransfer)); }
  catch (err) { toast(`No se pudo leer lo soltado: ${err.message}`, 'err'); }
});
// el navegador abre el fichero si se suelta fuera de la zona
['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => {
  if (!dz.contains(e.target)) e.preventDefault();
}));

$('#pick-file').addEventListener('click', () => $('#file-input').click());
$('#pick-dir').addEventListener('click', () => $('#dir-input').click());

$('#file-input').addEventListener('change', (e) => {
  uploadMods([...e.target.files].map((f) => ({ file: f, path: f.name })));
  e.target.value = '';
});
$('#dir-input').addEventListener('change', (e) => {
  uploadMods([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
  e.target.value = '';
});

/* ============================================================= mundos === */

async function loadWorlds() {
  try { renderWorlds(await api('/api/worlds')); }
  catch (e) { toast(e.message, 'err'); }
}

function renderWorlds(d) {
  const { worlds = [], backups = [], running, activeWorld } = d;

  $('#worlds-hint').textContent = running
    ? 'El servidor está en marcha: para borrar un mundo apágalo primero.'
    : `Mundo que usará el servidor al arrancar: "${activeWorld}".`;

  $('#world-list').innerHTML = worlds.length ? worlds.map((w) => `
    <div class="trow ${w.active ? 'active' : ''}">
      <div>
        <div class="tname">${esc(w.name)} ${w.active ? '<span class="badge">ACTIVO</span>' : ''}</div>
        <div class="tmeta">${fmtBytes(w.size)} · modificado ${fmtDate(w.mtime)}</div>
      </div>
      <div class="tactions">
        <button class="btn btn-ghost btn-sm" data-backup="${esc(w.name)}">Backup</button>
        <button class="btn btn-danger btn-sm" data-del-world="${esc(w.name)}"
                ${running ? 'disabled title="Apaga el servidor primero"' : ''}>Borrar</button>
      </div>
    </div>`).join('') : '<p class="empty">Todavía no hay partidas guardadas.</p>';

  $('#backup-list').innerHTML = backups.length ? backups.map((b) => `
    <div class="trow">
      <div>
        <div class="tname">${esc(b.name)}</div>
        <div class="tmeta">${fmtBytes(b.size)} · ${fmtDate(b.mtime)}</div>
      </div>
      <div class="tactions">
        <a class="btn btn-ghost btn-sm" href="/api/backups/${encodeURIComponent(b.name)}/download">Descargar</a>
        <button class="btn btn-danger btn-sm" data-del-backup="${esc(b.name)}">Borrar</button>
      </div>
    </div>`).join('') : '<p class="empty">Sin copias de seguridad.</p>';
}

$('#worlds-refresh').addEventListener('click', loadWorlds);

$('#world-list').addEventListener('click', async (e) => {
  const bk = e.target.closest('[data-backup]');
  if (bk) {
    bk.disabled = true; bk.textContent = 'Comprimiendo…';
    try {
      const r = await jpost(`/api/worlds/${encodeURIComponent(bk.dataset.backup)}/backup`);
      toast(`Backup creado (${fmtBytes(r.backup.size)})`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
    loadWorlds();
    return;
  }

  const del = e.target.closest('[data-del-world]');
  if (!del) return;
  const name = del.dataset.delWorld;
  if (!await confirmDialog('Borrar mundo',
    `Se eliminará la partida "${name}" de forma permanente. Haz un backup antes si tienes dudas.`,
    'Borrar para siempre')) return;
  try { await jdel(`/api/worlds/${encodeURIComponent(name)}`); toast('Mundo borrado', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
  loadWorlds();
});

$('#backup-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-backup]');
  if (!b) return;
  if (!await confirmDialog('Borrar copia', `Se eliminará "${b.dataset.delBackup}".`, 'Borrar')) return;
  try { await jdel(`/api/backups/${encodeURIComponent(b.dataset.delBackup)}`); }
  catch (err) { toast(err.message, 'err'); }
  loadWorlds();
});

/* ============================================================ ajustes === */

/**
 * Ajustes que el panel muestra con controles. `def` es el valor por defecto de
 * Project Zomboid, y se usa cuando la clave no esta escrita en el .ini: el
 * servidor genera el fichero sin algunas opciones y entonces tira de su valor
 * interno. Esas filas salen marcadas como "nuevo" y solo se escriben en el
 * fichero si de verdad las cambias.
 */
const SETTINGS = [
  {
    group: 'Servidor',
    items: [
      { key: 'PublicName', type: 'text', label: 'Nombre público', def: 'My PZ Server',
        hint: 'Cómo aparece en la lista de servidores' },
      { key: 'PublicDescription', type: 'text', label: 'Descripción', def: '' },
      { key: 'Password', type: 'text', label: 'Contraseña del servidor', def: '',
        hint: 'Vacío = entra cualquiera', placeholder: 'sin contraseña' },
      { key: 'MaxPlayers', type: 'number', label: 'Jugadores máximos', def: '32', min: 1, max: 100,
        hint: 'Con 8 GB de RAM, 16 va sobrado' },
      { key: 'Public', type: 'bool', label: 'Listar públicamente', def: 'false',
        hint: 'Aparece en Unirse a servidor → Internet' },
      { key: 'Open', type: 'bool', label: 'Entrada libre', def: 'true',
        hint: 'Si lo apagas, solo entra quien esté en la lista blanca' },
      { key: 'PVP', type: 'bool', label: 'PvP entre jugadores', def: 'true' },
    ],
  },
  {
    group: 'Jugadores',
    items: [
      { key: 'MapRemotePlayerVisibility', type: 'select', label: 'Verse en el mapa', def: '1',
        hint: 'Marcadores del resto al abrir el mapa con M',
        options: [
          { v: '1', label: 'Nadie' },
          { v: '2', label: 'Solo facción' },
          { v: '3', label: 'Todos' },
        ] },
      { key: 'DisplayUserName', type: 'bool', label: 'Nombre sobre el personaje', def: 'true' },
      { key: 'ShowFirstAndLastName', type: 'bool', label: 'Nombre y apellido', def: 'false' },
      { key: 'Faction', type: 'bool', label: 'Permitir facciones', def: 'true' },
      { key: 'AllowCoop', type: 'bool', label: 'Pantalla dividida', def: 'true' },
      { key: 'SafetySystem', type: 'bool', label: 'Sistema de seguridad PvP', def: 'true',
        hint: 'Evita golpear a otros sin activarlo antes' },
      { key: 'AnnounceDeath', type: 'bool', label: 'Anunciar muertes en el chat', def: 'false' },
      { key: 'GlobalChat', type: 'bool', label: 'Chat global', def: 'true' },
    ],
  },
  {
    group: 'Partida',
    items: [
      { key: 'MinutesPerPage', type: 'number', label: 'Minutos por página de libro',
        def: '1.0', step: 0.1, min: 0, max: 60,
        hint: '1 es lo normal · 0.5 el doble de rápido · 0.1 casi instantáneo' },
      { key: 'HoursForLootRespawn', type: 'number', label: 'Horas para que reaparezca el loot',
        def: '0', min: 0, hint: '0 = nunca reaparece' },
      { key: 'SpeedLimit', type: 'number', label: 'Velocidad máxima de vehículos',
        def: '70.0', min: 10, max: 150, hint: 'En km/h' },
      { key: 'SleepAllowed', type: 'bool', label: 'Permitir dormir', def: 'false' },
      { key: 'SleepNeeded', type: 'bool', label: 'El cansancio afecta', def: 'false' },
      { key: 'NoFire', type: 'bool', label: 'Desactivar el fuego', def: 'false',
        hint: 'Impide incendios que arrasen el mapa' },
      { key: 'PauseEmpty', type: 'bool', label: 'Pausar si no hay nadie', def: 'true',
        hint: 'El tiempo no corre con el servidor vacío' },
    ],
  },
  {
    group: 'Guardado y copias',
    items: [
      { key: 'SaveWorldEveryMinutes', type: 'number', label: 'Guardar cada X minutos',
        def: '0', min: 0 },
      { key: 'BackupsCount', type: 'number', label: 'Copias a conservar',
        def: '5', min: 0, max: 50 },
      { key: 'BackupsOnStart', type: 'bool', label: 'Copia al arrancar', def: 'true' },
      { key: 'BackupsOnVersionChange', type: 'bool', label: 'Copia al cambiar de versión', def: 'true' },
      { key: 'BackupsPeriod', type: 'number', label: 'Copia periódica (minutos)', def: '0', min: 0 },
    ],
  },
];

const COMMANDS = [
  { c: 'players', d: 'Lista los jugadores conectados' },
  { c: 'save', d: 'Guarda el mundo ahora mismo' },
  { c: 'servermsg "texto"', d: 'Mensaje en pantalla para todos' },
  { c: 'kick "usuario"', d: 'Expulsa a un jugador' },
  { c: 'banuser "usuario"', d: 'Banea por nombre de usuario' },
  { c: 'unbanuser "usuario"', d: 'Le quita el baneo' },
  { c: 'grantadmin "usuario"', d: 'Le da permisos de administrador' },
  { c: 'removeadmin "usuario"', d: 'Le quita los permisos' },
  { c: 'addusertowhitelist "usuario"', d: 'Lo añade a la lista blanca' },
  { c: 'teleport "origen" "destino"', d: 'Lleva un jugador junto a otro' },
  { c: 'additem "usuario" "Base.Axe"', d: 'Le da un objeto' },
  { c: 'godmod "usuario"', d: 'Invulnerabilidad on/off' },
  { c: 'invisible "usuario"', d: 'Los zombis dejan de verlo' },
  { c: 'noclip "usuario"', d: 'Atravesar paredes' },
  { c: 'alarm', d: 'Dispara la alarma del edificio donde estés' },
  { c: 'chopper', d: 'Lanza el evento del helicóptero' },
  { c: 'gunshot', d: 'Suena un disparo y atrae zombis' },
  { c: 'startrain', d: 'Empieza a llover' },
  { c: 'stoprain', d: 'Deja de llover' },
  { c: 'startstorm', d: 'Desata una tormenta' },
  { c: 'checkModsNeedUpdate', d: 'Comprueba si hay mods desactualizados' },
  { c: 'reloadoptions', d: 'Recarga parte del .ini sin reiniciar' },
  { c: 'showoptions', d: 'Muestra todas las opciones actuales' },
  { c: 'quit', d: 'Guarda y apaga el servidor' },
];

function settingRow(it, raw, missing) {
  const id = `set-${it.key}`;
  const attrs = `id="${id}" data-key="${esc(it.key)}" data-type="${it.type}"`
    + ` data-def="${esc(it.def)}"${missing ? ' data-missing="1"' : ''}`;
  let control;

  if (it.type === 'bool') {
    const on = String(raw).trim().toLowerCase() === 'true';
    control = `<label class="switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><i></i></label>`;
  } else if (it.type === 'select') {
    control = `<select class="set-input" ${attrs}>${it.options.map((o) => `
      <option value="${esc(o.v)}" ${String(raw) === String(o.v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>`;
  } else if (it.type === 'number') {
    control = `<input class="set-input set-num" type="number" ${attrs} value="${esc(raw)}"
      ${it.step ? `step="${it.step}"` : ''} ${it.min != null ? `min="${it.min}"` : ''} ${it.max != null ? `max="${it.max}"` : ''}>`;
  } else {
    control = `<input class="set-input" type="text" ${attrs} value="${esc(raw)}"
      placeholder="${esc(it.placeholder || '')}">`;
  }

  return `<div class="set-row${missing ? ' is-missing' : ''}">
    <div class="set-main">
      <label class="set-label" for="${id}">${esc(it.label)}${
        missing ? '<span class="set-new" title="No está en tu .ini; se añadirá si lo cambias">nuevo</span>' : ''}</label>
      ${it.hint ? `<div class="set-hint">${esc(it.hint)}</div>` : ''}
      <code class="set-key">${esc(it.key)}</code>
    </div>
    <div class="set-ctl">${control}</div>
  </div>`;
}

function renderSettings(values) {
  const html = SETTINGS.map((g) => {
    const rows = g.items.map((it) => {
      const missing = !(it.key in values);
      return settingRow(it, missing ? it.def : values[it.key], missing);
    }).join('');
    return `<div class="card">
      <div class="card-head"><h3>${esc(g.group)}</h3></div>
      <div class="set-list">${rows}</div>
    </div>`;
  }).join('');

  $('#settings-groups').innerHTML = html;
}

async function loadSettings() {
  try {
    renderSettings((await api('/api/settings')).values);
  } catch (e) {
    $('#settings-groups').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

$('#settings-reload').addEventListener('click', loadSettings);

$('#settings-save').addEventListener('click', async () => {
  const changes = {};
  $$('#settings-groups [data-key]').forEach((el) => {
    const value = el.dataset.type === 'bool' ? String(el.checked) : el.value.trim();
    // una fila "nueva" sin tocar no se escribe: no ensuciamos el .ini con
    // lineas que solo repiten el valor por defecto del servidor
    if (el.dataset.missing === '1' && value === el.dataset.def) return;
    changes[el.dataset.key] = value;
  });
  if (!Object.keys(changes).length) return toast('No hay nada que guardar', 'warn');

  try {
    const r = await jpost('/api/settings', { changes });
    renderSettings(r.values);
    const n = r.applied.length + r.created.length;
    toast(`${n} ajustes guardados. Reinicia para aplicarlos.`, 'ok');
    if (r.created.length) toast(`Añadidos al .ini: ${r.created.join(', ')}`, 'ok');
    if (r.skipped.length) toast(`Sin efecto: ${r.skipped.join(', ')}`, 'warn');
  } catch (e) { toast(e.message, 'err'); }
});

$('#cmd-reference').innerHTML = COMMANDS.map((k) => `
  <button class="cmd" data-run="${esc(k.c)}"><b>${esc(k.c)}</b><span>${esc(k.d)}</span></button>`).join('');

$('#cmd-reference').addEventListener('click', (e) => {
  const b = e.target.closest('[data-run]');
  if (!b) return;
  goto('console');
  const input = $('#console-cmd');
  input.value = b.dataset.run;
  input.focus();
  // dejamos el cursor listo para rellenar el primer argumento entrecomillado
  const q = input.value.indexOf('"');
  if (q !== -1) input.setSelectionRange(q + 1, input.value.indexOf('"', q + 1));
});

/* ======================================================= configuracion == */

let cfgKind = 'ini';

async function loadConfig(kind) {
  cfgKind = kind;
  $$('#cfg-tabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.cfg === kind));
  const box = $('#cfg-text');
  box.value = 'cargando…'; box.disabled = true;
  try {
    const r = await api(`/api/config/${kind}`);
    box.value = r.text; box.disabled = false;
    $('#cfg-path').textContent = r.file;
  } catch (e) {
    box.value = ''; box.disabled = true;
    $('#cfg-path').textContent = e.message;
    toast(e.message, 'err');
  }
}

/**
 * Buscador del editor. Ctrl+F del navegador no encuentra texto dentro de un
 * <textarea>, y el .ini tiene mas de cien lineas. Enter repetido salta a la
 * siguiente coincidencia y al llegar al final vuelve a empezar.
 */
let findPos = 0;

function cfgFind(term) {
  const box = $('#cfg-text');
  const needle = String(term || '').trim().toLowerCase();
  if (!needle || box.disabled) return;

  const hay = box.value.toLowerCase();
  let i = hay.indexOf(needle, findPos);
  if (i === -1) i = hay.indexOf(needle, 0);
  if (i === -1) { toast(`No encontrado: ${term}`, 'warn'); return; }

  findPos = i + needle.length;
  box.focus();
  box.setSelectionRange(i, i + needle.length);

  // centramos a mano: el scroll automatico hacia la seleccion no es fiable
  const line = box.value.slice(0, i).split('\n').length - 1;
  const lineH = parseFloat(getComputedStyle(box).lineHeight) || 18;
  box.scrollTop = Math.max(0, line * lineH - box.clientHeight / 2);
}

$('#cfg-find').addEventListener('input', () => { findPos = 0; });
$('#cfg-find').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  cfgFind(e.target.value);
});

$('#cfg-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) loadConfig(t.dataset.cfg);
});
$('#cfg-reload').addEventListener('click', () => loadConfig(cfgKind));
$('#cfg-save').addEventListener('click', async () => {
  try {
    await jpost(`/api/config/${cfgKind}`, { text: $('#cfg-text').value });
    toast('Guardado. Reinicia el servidor para aplicarlo.', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

/* ============================================================== arranque */

function boot() {
  connectWs();
  refreshStatus();
  refreshPlayers();
  clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 5000);
  setInterval(() => { if (!document.hidden) refreshPlayers(); }, 45000);

  const initial = (location.hash || '').replace('#', '');
  goto(TITLES[initial] ? initial : 'overview');
}

(async () => {
  try {
    const me = await api('/api/me');
    if (me.auth) showApp(); else showLogin();
  } catch { showLogin(); }
})();
