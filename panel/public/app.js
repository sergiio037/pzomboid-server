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
  $('#ov-branch').textContent = st.branch === 'unstable' ? 'unstable' : 'stable';
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

function renderModIssues(d) {
  const out = [];

  if (d.pendingWorkshop?.length) {
    out.push(`<div class="issue">
      <div class="issue-main">
        <div class="issue-title">${d.pendingWorkshop.length} mod(s) del Workshop sin descargar</div>
        <div class="issue-body">Están en <code>WorkshopItems=</code> pero no aparecen en disco:
          <code>${esc(d.pendingWorkshop.join(', '))}</code>.
          El servidor los baja al arrancar, así que reinicia y vuelve a mirar.</div>
      </div>
      <button class="btn btn-warn btn-sm" data-power="restart">Reiniciar</button>
    </div>`);
  }

  if (d.inactiveIds?.length) {
    const ids = d.inactiveIds.map((x) => x.id);
    out.push(`<div class="issue">
      <div class="issue-main">
        <div class="issue-title">${ids.length} mod(s) descargados pero sin activar</div>
        <div class="issue-body">Están en disco pero su Mod ID no está en <code>Mods=</code>, así que el
          servidor no los carga: <code>${esc(ids.join(', '))}</code></div>
      </div>
      <button class="btn btn-primary btn-sm" id="mods-enable-all">Activar todos</button>
    </div>`);
  }

  if (d.orphanIds?.length) {
    out.push(`<div class="issue err">
      <div class="issue-main">
        <div class="issue-title">${d.orphanIds.length} Mod ID activo(s) que no existen en disco</div>
        <div class="issue-body">Están en <code>Mods=</code> pero no hay ninguna carpeta con ese id:
          <code>${esc(d.orphanIds.join(', '))}</code>.
          Suele ser un id mal escrito, o falta su ID del Workshop. Con esto el servidor puede negarse a arrancar.</div>
      </div>
    </div>`);
  }

  $('#mod-issues').innerHTML = out.join('');
}

function renderMods(data) {
  const { mods = [], enabledIds = [], workshop = [] } = data;
  $('#mods-count').textContent = mods.length;
  renderModIssues(data);

  $('#mod-list').innerHTML = mods.length ? mods.map((m) => {
    const first = m.entries[0];
    const title = first ? first.name : m.folder;
    const badge = m.source === 'workshop'
      ? `<span class="mod-src ws" title="Descargado del Workshop">WS ${esc(m.workshopId)}</span>`
      : '<span class="mod-src local" title="Instalado a mano">manual</span>';
    const meta = m.valid
      ? `${m.ids.join(', ')} · ${fmtBytes(m.size)}`
      : `sin mod.info válido · ${fmtBytes(m.size)}`;
    // los del Workshop no se borran: el servidor los volveria a bajar al
    // arrancar. Se quitan retirando su ID de la lista del Workshop.
    const del = m.source === 'local'
      ? `<button class="icon-btn" data-del-mod="${esc(m.folder)}" title="Borrar mod">${ICON_TRASH}</button>`
      : '';
    return `
      <div class="mod ${m.valid ? '' : 'invalid'}">
        <label class="switch" title="${m.valid ? 'Activar / desactivar' : 'No se puede activar'}">
          <input type="checkbox" data-toggle="${esc(m.ids[0] || '')}"
                 ${m.enabled ? 'checked' : ''} ${m.valid ? '' : 'disabled'}>
          <i></i>
        </label>
        <div class="mod-main">
          <div class="mod-name">${esc(title)} ${badge}</div>
          <div class="mod-meta">${esc(meta)}</div>
        </div>
        ${del}
      </div>`;
  }).join('') : '<p class="empty">No se ha encontrado ningún mod, ni manual ni del Workshop.</p>';

  $('#ws-list').innerHTML = workshop.length ? workshop.map((id) => `
    <span class="tag">${esc(id)}<button data-del-ws="${esc(id)}" title="Quitar">×</button></span>`).join('')
    : '<p class="empty">Sin IDs del Workshop.</p>';

  $('#modid-list').innerHTML = enabledIds.length ? enabledIds.map((id) => `
    <span class="tag">${esc(id)}<button data-del-modid="${esc(id)}" title="Quitar">×</button></span>`).join('')
    : '<p class="empty">Ningún mod activo.</p>';

  window.__mods = data;
}

$('#mods-refresh').addEventListener('click', loadMods);

$('#mod-issues').addEventListener('click', async (e) => {
  if (!e.target.closest('#mods-enable-all')) return;
  const add = (window.__mods?.inactiveIds || []).map((x) => x.id);
  if (!add.length) return;
  try {
    renderMods(await jpost('/api/mods/enabled', {
      ids: [...(window.__mods?.enabledIds || []), ...add],
    }));
    toast(`${add.length} mod(s) activados. Reinicia para aplicarlo.`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

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
      { key: 'PublicName', type: 'text', label: 'Nombre del servidor', def: 'My PZ Server',
        hint: 'Cómo aparece en la lista de servidores' },
      { key: 'PublicDescription', type: 'text', label: 'Descripción', def: '' },
      { key: 'Password', type: 'text', label: 'Contraseña de acceso', def: '',
        placeholder: 'sin contraseña', hint: 'Vacío = puede entrar cualquiera' },
      { key: 'MaxPlayers', type: 'range', label: 'Jugadores máximos', def: '32',
        min: 1, max: 64, step: 1, hint: 'Con 8 GB de RAM, 16 va sobrado' },
      { key: 'Public', type: 'bool', label: 'Listar públicamente', def: 'false',
        hint: 'Aparece en Unirse a servidor → Internet' },
      { key: 'Open', type: 'bool', label: 'Entrada libre', def: 'true',
        hint: 'Si lo apagas, solo entra quien esté en la lista blanca' },
      { key: 'PingLimit', type: 'range', label: 'Ping máximo permitido', def: '0',
        min: 0, max: 1000, step: 50, unit: 'ms', hint: '0 = sin límite' },
      { key: 'MaxAccountsPerUser', type: 'range', label: 'Cuentas por usuario', def: '0',
        min: 0, max: 10, step: 1, hint: '0 = sin límite' },
      { key: 'DenyLoginOnOverloadedServer', type: 'bool', label: 'Rechazar si va saturado', def: 'true' },
      { key: 'LoginQueueEnabled', type: 'bool', label: 'Cola de entrada', def: 'false' },
      { key: 'DisableScoreboard', type: 'bool', label: 'Ocultar marcador', def: 'false',
        hint: 'La lista de conectados que se ve con Tab' },
      { key: 'HideAdminsInPlayerList', type: 'bool', label: 'Ocultar admins de la lista', def: 'false' },
      { key: 'ServerWelcomeMessage', type: 'textarea', label: 'Mensaje de bienvenida', def: '',
        hint: 'Usa <LINE> para saltos de línea' },
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
      { key: 'MouseOverToSeeDisplayName', type: 'bool', label: 'Solo al pasar el ratón', def: 'true',
        hint: 'El nombre aparece únicamente al apuntar' },
      { key: 'ShowFirstAndLastName', type: 'bool', label: 'Nombre y apellido', def: 'false' },
      { key: 'HidePlayersBehindYou', type: 'bool', label: 'Ocultar a los de tu espalda', def: 'true' },
      { key: 'ShowCoordinates', type: 'bool', label: 'Mostrar coordenadas', def: 'false' },
      { key: 'AllowCoop', type: 'bool', label: 'Pantalla dividida', def: 'true' },
      { key: 'Faction', type: 'bool', label: 'Permitir facciones', def: 'true' },
      { key: 'FactionDaySurvivedToCreate', type: 'range', label: 'Días para crear facción', def: '0',
        min: 0, max: 30, step: 1, unit: 'd', hint: '0 = desde el primer momento' },
      { key: 'AnnounceDeath', type: 'bool', label: 'Anunciar muertes', def: 'false' },
      { key: 'AnnounceAnimalDeath', type: 'bool', label: 'Anunciar muerte de animales', def: 'false' },
      { key: 'GlobalChat', type: 'bool', label: 'Chat global', def: 'true' },
      { key: 'ChatMessageCharacterLimit', type: 'range', label: 'Límite de caracteres en el chat',
        def: '200', min: 50, max: 1000, step: 50 },
      { key: 'VoiceEnable', type: 'bool', label: 'Chat de voz', def: 'true' },
      { key: 'Voice3D', type: 'bool', label: 'Voz posicional', def: 'true',
        hint: 'Se oye según la distancia y dirección' },
      { key: 'VoiceMaxDistance', type: 'range', label: 'Alcance de la voz', def: '100.0',
        min: 10, max: 300, step: 10, unit: 'm' },
    ],
  },
  {
    group: 'PvP',
    items: [
      { key: 'PVP', type: 'bool', label: 'PvP activado', def: 'true',
        hint: 'Si lo apagas, nadie puede dañar a otro jugador' },
      { key: 'SafetySystem', type: 'bool', label: 'Sistema de seguridad', def: 'true',
        hint: 'Hay que activar el modo PvP antes de poder golpear' },
      { key: 'ShowSafety', type: 'bool', label: 'Mostrar icono de seguridad', def: 'true' },
      { key: 'SafetyToggleTimer', type: 'range', label: 'Tiempo para activar PvP', def: '2',
        min: 0, max: 10, step: 1, unit: 's' },
      { key: 'SafetyCooldownTimer', type: 'range', label: 'Enfriamiento del PvP', def: '3',
        min: 0, max: 30, step: 1, unit: 's' },
      { key: 'PVPMeleeDamageModifier', type: 'range', label: 'Daño cuerpo a cuerpo', def: '30.0',
        min: 0, max: 200, step: 5, unit: '%', hint: '100 = daño completo' },
      { key: 'PVPFirearmDamageModifier', type: 'range', label: 'Daño de armas de fuego', def: '50.0',
        min: 0, max: 200, step: 5, unit: '%' },
      { key: 'PVPMeleeWhileHitReaction', type: 'bool', label: 'Golpear mientras te aturden', def: 'false' },
      { key: 'PlayerBumpPlayer', type: 'bool', label: 'Empujarse entre jugadores', def: 'false' },
      { key: 'KnockedDownAllowed', type: 'bool', label: 'Permitir derribos', def: 'false' },
      { key: 'AllowDestructionBySledgehammer', type: 'bool', label: 'Demoler con mazo', def: 'true' },
      { key: 'SledgehammerOnlyInSafehouse', type: 'bool', label: 'Mazo solo en refugio propio', def: 'false' },
    ],
  },
  {
    group: 'Mundo',
    items: [
      { key: 'Map', type: 'text', label: 'Mapas cargados', def: 'Muldraugh, KY',
        hint: 'Separados por ; · los mods de mapa se añaden aquí' },
      { key: 'SpawnItems', type: 'text', label: 'Objetos iniciales', def: '',
        placeholder: 'Base.Axe;Base.Bag_BigHikingBag',
        hint: 'Lo que aparece en el inventario al empezar' },
      { key: 'SpeedLimit', type: 'range', label: 'Velocidad máxima de vehículos', def: '70.0',
        min: 10, max: 150, step: 5, unit: 'km/h' },
      { key: 'CarEngineAttractionModifier', type: 'range', label: 'Ruido del motor', def: '0.5',
        min: 0, max: 5, step: 0.1, hint: 'Cuánto atraen los coches a los zombis' },
      { key: 'FastForwardMultiplier', type: 'range', label: 'Velocidad de avance rápido', def: '40.0',
        min: 1, max: 100, step: 1, unit: '×' },
      { key: 'SleepAllowed', type: 'bool', label: 'Permitir dormir', def: 'false' },
      { key: 'SleepNeeded', type: 'bool', label: 'El cansancio afecta', def: 'false' },
      { key: 'PauseEmpty', type: 'bool', label: 'Pausar con el servidor vacío', def: 'true',
        hint: 'El tiempo no corre si no hay nadie conectado' },
      { key: 'NoFire', type: 'bool', label: 'Desactivar el fuego', def: 'false',
        hint: 'Impide incendios que arrasen el mapa' },
      { key: 'BloodSplatLifespanDays', type: 'range', label: 'Días que dura la sangre', def: '0',
        min: 0, max: 60, step: 1, unit: 'd', hint: '0 = no se limpia nunca' },
      { key: 'ItemNumbersLimitPerContainer', type: 'range', label: 'Objetos por contenedor', def: '0',
        min: 0, max: 200, step: 10, hint: '0 = sin límite' },
      { key: 'RemovePlayerCorpsesOnCorpseRemoval', type: 'bool',
        label: 'Borrar también cadáveres de jugador', def: 'false' },
      { key: 'TrashDeleteAll', type: 'bool', label: 'La papelera borra del todo', def: 'false' },
    ],
  },
  {
    group: 'Refugios',
    items: [
      { key: 'PlayerSafehouse', type: 'bool', label: 'Los jugadores pueden reclamar refugio', def: 'false' },
      { key: 'AdminSafehouse', type: 'bool', label: 'Solo los admins pueden reclamar', def: 'false' },
      { key: 'SafehouseDaySurvivedToClaim', type: 'range', label: 'Días para poder reclamar', def: '0',
        min: 0, max: 30, step: 1, unit: 'd' },
      { key: 'SafeHouseRemovalTime', type: 'range', label: 'Caduca sin visitar', def: '144',
        min: 0, max: 720, step: 24, unit: 'h', hint: '0 = no caduca nunca' },
      { key: 'SafehouseAllowLoot', type: 'bool', label: 'Los miembros pueden saquear', def: 'true' },
      { key: 'SafehouseAllowRespawn', type: 'bool', label: 'Reaparecer en el refugio', def: 'false' },
      { key: 'SafehouseAllowTrepass', type: 'bool', label: 'Permitir que entren extraños', def: 'true' },
      { key: 'SafehouseAllowFire', type: 'bool', label: 'Permitir fuego dentro', def: 'true' },
      { key: 'SafehouseAllowNonResidential', type: 'bool', label: 'Reclamar edificios no residenciales', def: 'false' },
      { key: 'SafehousePreventsLootRespawn', type: 'bool', label: 'Sin reaparición de loot dentro', def: 'true' },
      { key: 'DisableSafehouseWhenOwnerConnected', type: 'bool',
        label: 'Desactivar si el dueño está conectado', def: 'false' },
      { key: 'MaxSafezoneSize', type: 'range', label: 'Tamaño máximo de zona segura', def: '20000',
        min: 100, max: 50000, step: 1000 },
    ],
  },
  {
    group: 'Guardado',
    items: [
      { key: 'SaveWorldEveryMinutes', type: 'range', label: 'Guardar el mundo cada', def: '0',
        min: 0, max: 120, step: 5, unit: 'min', hint: '0 = solo al apagar' },
      { key: 'BackupsCount', type: 'range', label: 'Copias a conservar', def: '5',
        min: 0, max: 50, step: 1 },
      { key: 'BackupsPeriod', type: 'range', label: 'Copia automática cada', def: '0',
        min: 0, max: 1440, step: 30, unit: 'min', hint: '0 = desactivado' },
      { key: 'BackupsOnStart', type: 'bool', label: 'Copia al arrancar', def: 'true' },
      { key: 'BackupsOnVersionChange', type: 'bool', label: 'Copia al cambiar de versión', def: 'true' },
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

/** Valor actual de un control, siempre como texto (lo que va al .ini). */
function ctlValue(el) {
  return el.dataset.type === 'bool' ? String(el.checked) : el.value.trim();
}

function settingRow(it, raw, missing) {
  const id = `set-${it.key}`;
  const val = String(raw);
  const attrs = `id="${id}" data-key="${esc(it.key)}" data-type="${it.type}"`
    + ` data-orig="${esc(val)}"${missing ? ' data-missing="1"' : ''}`;
  let control;

  if (it.type === 'bool') {
    const on = val.trim().toLowerCase() === 'true';
    control = `<label class="switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><i></i></label>`;

  } else if (it.type === 'select') {
    control = `<select class="set-input" ${attrs}>${it.options.map((o) => `
      <option value="${esc(o.v)}"${val === String(o.v) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>`;

  } else if (it.type === 'range') {
    // el number lleva el data-key (es la fuente de verdad); el slider solo lo empuja
    control = `<div class="set-range">
      <input type="range" data-slider="${esc(it.key)}" value="${esc(val)}"
             min="${it.min}" max="${it.max}" step="${it.step || 1}">
      <input class="set-input set-num" type="number" ${attrs} value="${esc(val)}"
             min="${it.min}" max="${it.max}" step="${it.step || 1}">
      ${it.unit ? `<span class="set-unit">${esc(it.unit)}</span>` : '<span class="set-unit"></span>'}
    </div>`;

  } else if (it.type === 'textarea') {
    control = `<textarea class="set-input" ${attrs} placeholder="${esc(it.placeholder || '')}">${esc(val)}</textarea>`;

  } else {
    control = `<input class="set-input" type="text" ${attrs} value="${esc(val)}"
      placeholder="${esc(it.placeholder || '')}">`;
  }

  const search = `${it.label} ${it.key} ${it.hint || ''}`.toLowerCase();

  return `<div class="set-row${missing ? ' is-missing' : ''}" data-search="${esc(search)}">
    <div class="set-main">
      <label class="set-label" for="${id}">${esc(it.label)}${
        missing ? '<span class="set-new" title="No está en tu .ini; se añadirá si lo cambias">nuevo</span>' : ''}</label>
      ${it.hint ? `<div class="set-hint">${esc(it.hint)}</div>` : ''}
      <code class="set-key">${esc(it.key)}</code>
    </div>
    <div class="set-ctl">
      <button class="set-reset" data-reset="${esc(it.key)}" title="Volver al valor guardado">&#8635;</button>
      ${control}
    </div>
  </div>`;
}

function renderSettings(values) {
  $('#settings-groups').innerHTML = SETTINGS.map((g) => {
    const rows = g.items.map((it) => {
      const missing = !(it.key in values);
      return settingRow(it, missing ? it.def : values[it.key], missing);
    }).join('');
    return `<div class="card" data-cat="${esc(g.group)}">
      <div class="card-head"><h3>${esc(g.group)}</h3></div>
      <div class="set-list">${rows}</div>
    </div>`;
  }).join('');

  renderCats(SETTINGS.map((g) => ({ name: g.group, n: g.items.length })));
  refreshDirty();
  applySettingsFilter();
}

/* ------------------------------------------------ ajustes de partida (lua) */

/**
 * Agrupacion de los SandboxVars segun la estructura de tablas del propio
 * fichero. No hay lista de ajustes: se generan a partir de lo que trae el
 * archivo, con sus rangos y opciones sacados de sus comentarios.
 */
const SB_GROUPS = [
  { group: 'General', match: (p) => !p.includes('.') },
  { group: 'Zombis', match: (p) => p.startsWith('ZombieLore.') },
  { group: 'Población', match: (p) => p.startsWith('ZombieConfig.') },
  { group: 'Habilidades', match: (p) => p.startsWith('MultiplierConfig.') },
  { group: 'Mapa', match: (p) => p.startsWith('Map.') },
  { group: 'Sótanos', match: (p) => p.startsWith('Basement.') },
];

/** Los que casi todo el mundo quiere tocar, con etiqueta en castellano. */
const SB_FEATURED = {
  MinutesPerPage: 'Minutos por página de libro',
  LiteratureCooldown: 'Días para releer un libro con provecho',
  'MultiplierConfig.Global': 'Multiplicador de experiencia',
  Zombies: 'Cantidad de zombis',
  'ZombieLore.Speed': 'Velocidad de los zombis',
  'ZombieLore.Strength': 'Fuerza de los zombis',
  'ZombieLore.Toughness': 'Resistencia de los zombis',
  'ZombieLore.Cognition': 'Inteligencia de los zombis',
  'ZombieLore.Transmission': 'Cómo se transmite la infección',
  'ZombieLore.Mortality': 'Rapidez de la infección',
  ZombieRespawn: 'Reaparición de zombis',
  'ZombieConfig.PopulationMultiplier': 'Multiplicador de población',
  DayLength: 'Duración del día',
  StartMonth: 'Mes de inicio',
  NightLength: 'Duración de la noche',
  NightDarkness: 'Oscuridad nocturna',
  WaterShut: 'Cuándo se corta el agua',
  ElecShut: 'Cuándo se corta la luz',
  HoursForLootRespawn: 'Horas para que reaparezca el loot',
  StarterKit: 'Empezar con kit básico',
  CharacterFreePoints: 'Puntos extra al crear personaje',
  LockedHouses: 'Casas cerradas con llave',
  Alarm: 'Frecuencia de alarmas',
  Helicopter: 'Helicóptero',
  MetaEvent: 'Eventos que atraen zombis',
  EnableVehicles: 'Vehículos activados',
  CarSpawnRate: 'Cantidad de vehículos',
  FoodRotSpeed: 'Velocidad a la que se pudre la comida',
  StatsDecrease: 'Velocidad de hambre, sed y cansancio',
  Temperature: 'Temperatura global',
  Rain: 'Frecuencia de lluvia',
};

function sandboxRow(it) {
  const id = `sb-${it.path.replace(/\./g, '-')}`;
  const featured = Object.prototype.hasOwnProperty.call(SB_FEATURED, it.path);
  const label = featured ? SB_FEATURED[it.path] : it.key;
  const val = it.type === 'bool' ? String(it.value) : String(it.value);
  const attrs = `id="${id}" data-key="${esc(it.path)}" data-type="${it.type}" data-orig="${esc(val)}"`;
  let control;

  if (it.type === 'bool') {
    control = `<label class="switch"><input type="checkbox" ${attrs} ${it.value ? 'checked' : ''}><i></i></label>`;

  } else if (it.options && it.options.length) {
    control = `<select class="set-input" ${attrs}>${it.options.map((o) => `
      <option value="${esc(o.v)}"${val === String(o.v) ? ' selected' : ''}>${esc(o.v)} · ${esc(o.label)}</option>`).join('')}
    </select>`;

  } else if ((it.type === 'int' || it.type === 'float') && it.min != null && it.max != null
             && (it.max - it.min) <= 100000) {
    const step = it.type === 'int' ? 1 : Math.max(0.01, Number(((it.max - it.min) / 100).toFixed(2)));
    control = `<div class="set-range">
      <input type="range" data-slider="${esc(it.path)}" value="${esc(val)}"
             min="${it.min}" max="${it.max}" step="${step}">
      <input class="set-input set-num" type="number" ${attrs} value="${esc(val)}"
             min="${it.min}" max="${it.max}" step="${step}">
      <span class="set-unit"></span>
    </div>`;

  } else if (it.type === 'int' || it.type === 'float') {
    control = `<input class="set-input set-num" type="number" ${attrs} value="${esc(val)}">`;

  } else {
    control = `<input class="set-input" type="text" ${attrs} value="${esc(val)}">`;
  }

  const defTxt = it.def != null ? ` · por defecto ${it.def}` : '';
  const search = `${label} ${it.path} ${it.desc || ''}`.toLowerCase();

  return `<div class="set-row" data-search="${esc(search)}"${featured ? ' data-featured="1"' : ''}>
    <div class="set-main">
      <label class="set-label" for="${id}">${esc(label)}${
        featured ? '<span class="set-star" title="Ajuste destacado">★</span>' : ''}</label>
      ${it.desc ? `<div class="set-hint">${esc(it.desc)}</div>` : ''}
      <code class="set-key">${esc(it.path)}${esc(defTxt)}</code>
    </div>
    <div class="set-ctl">
      <button class="set-reset" data-reset="${esc(it.path)}" title="Volver al valor guardado">&#8635;</button>
      ${control}
    </div>
  </div>`;
}

function renderSandbox(items) {
  const cats = [];
  $('#settings-groups').innerHTML = SB_GROUPS.map((g) => {
    const rows = items.filter((it) => g.match(it.path));
    if (!rows.length) return '';
    cats.push({ name: g.group, n: rows.length });
    return `<div class="card" data-cat="${esc(g.group)}">
      <div class="card-head"><h3>${esc(g.group)}</h3><span class="count">${rows.length}</span></div>
      <div class="set-list">${rows.map(sandboxRow).join('')}</div>
    </div>`;
  }).join('');

  const featured = items.filter((it) => it.path in SB_FEATURED).length;
  renderCats(cats, featured);
  refreshDirty();
  applySettingsFilter();
}

/* ------------------------------------------------------- cambios sueltos */

function refreshDirty() {
  let n = 0;
  $$('#settings-groups [data-key]').forEach((el) => {
    const dirty = ctlValue(el) !== el.dataset.orig;
    el.closest('.set-row').classList.toggle('is-dirty', dirty);
    if (dirty) n += 1;
  });

  const label = $('#settings-count');
  label.textContent = n ? `${n} sin guardar` : 'sin cambios';
  label.classList.toggle('on', n > 0);
  $('#settings-save').disabled = n === 0;
  $('#settings-reload').disabled = n === 0;
  if ($('#settings-onlydirty').checked) applySettingsFilter();
}

$('#settings-groups').addEventListener('input', (e) => {
  // el slider empuja al number, y el number al slider
  const slider = e.target.closest('[data-slider]');
  if (slider) {
    const num = $(`[data-key="${CSS.escape(slider.dataset.slider)}"]`);
    if (num) num.value = slider.value;
  } else if (e.target.dataset.key) {
    const s = $(`[data-slider="${CSS.escape(e.target.dataset.key)}"]`);
    if (s) s.value = e.target.value;
  }
  refreshDirty();
});
$('#settings-groups').addEventListener('change', refreshDirty);

$('#settings-groups').addEventListener('click', (e) => {
  const b = e.target.closest('[data-reset]');
  if (!b) return;
  const el = $(`[data-key="${CSS.escape(b.dataset.reset)}"]`);
  if (!el) return;
  if (el.dataset.type === 'bool') el.checked = el.dataset.orig.toLowerCase() === 'true';
  else el.value = el.dataset.orig;
  const s = $(`[data-slider="${CSS.escape(b.dataset.reset)}"]`);
  if (s) s.value = el.dataset.orig;
  refreshDirty();
});

/* ------------------------------------------------------------- filtros */

let settingsCat = 'Todos';
let settingsSource = 'ini';

/** Pastillas de categoria. `featured` > 0 añade la de destacados. */
function renderCats(cats, featured = 0) {
  const all = cats.reduce((a, c) => a + c.n, 0);
  const list = [{ name: 'Todos', n: all }, ...cats];
  if (featured) list.unshift({ name: 'Destacados', n: featured });
  if (!list.some((c) => c.name === settingsCat)) settingsCat = list[0].name;

  $('#settings-cats').innerHTML = list.map((c) => `
    <button class="set-cat${c.name === settingsCat ? ' is-active' : ''}"
            data-cat="${esc(c.name)}">${esc(c.name)}<i>${c.n}</i></button>`).join('');
}

function applySettingsFilter() {
  const q = $('#settings-search').value.trim().toLowerCase();
  const onlyDirty = $('#settings-onlydirty').checked;
  let total = 0;

  $$('#settings-groups .card').forEach((card) => {
    const inCat = settingsCat === 'Todos'
      || settingsCat === 'Destacados'
      || card.dataset.cat === settingsCat;
    let shown = 0;
    $$('.set-row', card).forEach((row) => {
      const show = inCat
        && (settingsCat !== 'Destacados' || row.dataset.featured === '1')
        && (!q || row.dataset.search.includes(q))
        && (!onlyDirty || row.classList.contains('is-dirty'));
      row.classList.toggle('hidden', !show);
      if (show) shown += 1;
    });
    card.classList.toggle('hidden', shown === 0);
    total += shown;
  });

  $('#settings-empty').classList.toggle('hidden', total > 0);
}

$('#settings-cats').addEventListener('click', (e) => {
  const b = e.target.closest('.set-cat');
  if (!b) return;
  settingsCat = b.dataset.cat;
  $$('.set-cat').forEach((x) => x.classList.toggle('is-active', x === b));
  applySettingsFilter();
});

$('#settings-search').addEventListener('input', applySettingsFilter);
$('#settings-onlydirty').addEventListener('change', applySettingsFilter);

$('#settings-src').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t || t.dataset.src === settingsSource) return;
  settingsSource = t.dataset.src;
  settingsCat = 'Todos';
  $$('#settings-src .tab').forEach((x) => x.classList.toggle('is-active', x === t));
  loadSettings();
});

/* -------------------------------------------------------- carga y guardado */

async function loadSettings() {
  $('#settings-groups').innerHTML = '<p class="empty">cargando…</p>';
  try {
    if (settingsSource === 'sandbox') renderSandbox((await api('/api/sandbox')).items);
    else renderSettings((await api('/api/settings')).values);
  } catch (e) {
    $('#settings-groups').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    $('#settings-cats').innerHTML = '';
  }
}

$('#settings-reload').addEventListener('click', loadSettings);

$('#settings-save').addEventListener('click', async () => {
  // solo se envia lo que ha cambiado: una fila intacta nunca se escribe,
  // asi que las "nuevas" no ensucian el .ini repitiendo su valor por defecto
  const changes = {};
  $$('#settings-groups [data-key]').forEach((el) => {
    const value = ctlValue(el);
    if (value !== el.dataset.orig) changes[el.dataset.key] = value;
  });
  if (!Object.keys(changes).length) return toast('No hay nada que guardar', 'warn');

  const btn = $('#settings-save');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    if (settingsSource === 'sandbox') {
      const r = await jpost('/api/sandbox', { changes });
      renderSandbox(r.items);
      toast(`${r.applied.length} ajuste(s) de partida guardados. Reinicia para aplicarlos.`, 'ok');
      if (r.skipped.length) toast(`Sin efecto: ${r.skipped.join(', ')}`, 'warn');
    } else {
      const r = await jpost('/api/settings', { changes });
      renderSettings(r.values);
      toast(`${r.applied.length + r.created.length} ajuste(s) guardados. Reinicia para aplicarlos.`, 'ok');
      if (r.skipped.length) toast(`Sin efecto: ${r.skipped.join(', ')}`, 'warn');
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.textContent = 'Guardar';
    refreshDirty();
  }
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
