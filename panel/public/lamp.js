/* ============================================================================
   lamp.js · ESTACIÓN 47 — LÁMPARA DE TRABAJO + POLVO EN SUSPENSIÓN
   ----------------------------------------------------------------------------
   Autónomo: no lee ni escribe nada de app.js, no exporta nada, sin dependencias.
   Carga:  <script src="lamp.js" defer></script>   (después de app.js)

   CONTRATO DE RENDIMIENTO
     · La ÚNICA escritura por frame es  arm.style.transform  sobre cada
       #lamp-arm, un <div> vacío creado aquí. transform no se hereda: el
       recálculo de estilo abarca ese elemento y nada más.
     · NUNCA se escribe una custom property, ni en :root ni en ningún ancestro.
       Medido en este panel: escribir una custom property en :root cuesta
       14 600 µs de recálculo de estilo; escribir transform en una hoja, 15 µs.
     · El rAF se APAGA en cuanto el foco alcanza al cursor. Con el ratón quieto
       leyendo la consola, el coste por frame es exactamente cero.
     · Cero getBoundingClientRect en pointermove: el origen de cada anfitrión se
       cachea y sólo se recalcula al cambiar de tamaño, vía ResizeObserver.
     · El polvo es CSS puro: animaciones de transform y opacity, es decir sólo
       compositor. No cuesta nada por frame al hilo principal y sigue vivo
       aunque la lámpara esté apagada.

   DOS ANFITRIONES
     .main          el panel en sí
     .login-screen  la pantalla de acceso, que antes se quedaba sin fondo
   ========================================================================== */
(function () {
  'use strict';

  var FINE   = matchMedia('(hover:hover) and (pointer:fine)');
  var REDUCE = matchMedia('(prefers-reduced-motion:reduce)');

  var EASE  = 0.16;   // inercia del brazo: la lámpara pesa
  var IDLE  = 900;    // ms parado antes de empezar a respirar
  var MOTAS = 18;     // partículas por anfitrión

  var hosts = [];     // [{ el, lamp, arm, ox, oy, cx, cy, seen }]
  var ro = null, raf = 0, idle = 0;
  var tx = 0, ty = 0;                       // cursor en coordenadas de viewport

  function origin() {
    for (var i = 0; i < hosts.length; i++) {
      var r = hosts[i].el.getBoundingClientRect();
      hosts[i].ox = r.left; hosts[i].oy = r.top;
    }
  }

  function tick() {
    raf = 0;
    var vivo = false;
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      var dx = (tx - h.ox) - h.cx, dy = (ty - h.oy) - h.cy;
      h.cx += dx * EASE; h.cy += dy * EASE;
      h.arm.style.transform =
        'translate3d(' + h.cx.toFixed(1) + 'px,' + h.cy.toFixed(1) + 'px,0)';
      if (dx * dx + dy * dy > 0.25) vivo = true;
    }
    if (vivo) raf = requestAnimationFrame(tick);
  }

  function move(e) {
    if (e.pointerType === 'touch') return;    // híbridos: el dedo no enciende la lámpara
    tx = e.clientX; ty = e.clientY;
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (!h.seen) {                          // sin barrido inicial desde 0,0
        h.seen = true; h.cx = tx - h.ox; h.cy = ty - h.oy;
      }
      if (h.lamp.className) h.lamp.className = '';   // quita is-idle / is-away
    }
    clearTimeout(idle); idle = setTimeout(rest, IDLE);
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function marca(clase) {
    for (var i = 0; i < hosts.length; i++) hosts[i].lamp.className = clase;
  }

  function rest() { marca('is-idle'); }

  function away() {
    if (!hosts.length) return;
    clearTimeout(idle);
    marca('is-away');
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function hide() { if (document.hidden) away(); }

  /* Polvo: se monta SIEMPRE (no depende de la lámpara ni del puntero fino),
     porque es ambiente y funciona igual en el móvil. Cada mota lleva sus
     números en variables propias del elemento, escritas UNA vez al crearla:
     no hay escritura por frame, la animación la lleva el compositor. */
  function polvo(el) {
    if (el.querySelector('.dust')) return;
    var caja = document.createElement('div');
    caja.className = 'dust';
    caja.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < MOTAS; i++) {
      var m = document.createElement('i');
      m.style.setProperty('--x', (Math.random() * 100).toFixed(2) + '%');
      m.style.setProperty('--y', (Math.random() * 100).toFixed(2) + '%');
      m.style.setProperty('--d', (26 + Math.random() * 34).toFixed(1) + 's');
      m.style.setProperty('--t', (-Math.random() * 40).toFixed(1) + 's');
      m.style.setProperty('--s', (0.6 + Math.random() * 1.5).toFixed(2));
      m.style.setProperty('--dx', (Math.random() * 120 - 60).toFixed(0) + 'px');
      m.style.setProperty('--dy', (-40 - Math.random() * 140).toFixed(0) + 'px');
      caja.appendChild(m);
    }
    el.appendChild(caja);
  }

  function anfitriones() {
    var out = [];
    var m = document.querySelector('.main');
    var l = document.querySelector('.login-screen');
    if (m) out.push(m);
    if (l) out.push(l);
    return out;
  }

  function build() {
    if (hosts.length) return;
    var els = anfitriones();
    if (!els.length) return;

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var lamp = document.createElement('div');
      lamp.id = 'lamp';
      lamp.className = 'is-away';
      lamp.setAttribute('aria-hidden', 'true');
      var arm = document.createElement('div');
      arm.id = 'lamp-arm';
      var lens = document.createElement('div');
      lens.id = 'lamp-lens';
      arm.appendChild(lens); lamp.appendChild(arm); el.appendChild(lamp);
      el.classList.add('lamp-live');
      hosts.push({ el: el, lamp: lamp, arm: arm, ox: 0, oy: 0, cx: 0, cy: 0, seen: false });
    }
    origin();

    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerdown', move, { passive: true });
    addEventListener('resize', origin, { passive: true });
    document.addEventListener('pointerleave', away);
    document.addEventListener('visibilitychange', hide);
    if (window.ResizeObserver) {
      ro = new ResizeObserver(origin);
      for (var j = 0; j < hosts.length; j++) ro.observe(hosts[j].el);
    }
  }

  function destroy() {
    if (!hosts.length) return;
    removeEventListener('pointermove', move);
    removeEventListener('pointerdown', move);
    removeEventListener('resize', origin);
    document.removeEventListener('pointerleave', away);
    document.removeEventListener('visibilitychange', hide);
    if (ro) { ro.disconnect(); ro = null; }
    clearTimeout(idle);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    for (var i = 0; i < hosts.length; i++) {
      hosts[i].el.classList.remove('lamp-live');
      hosts[i].lamp.remove();
    }
    hosts = [];
  }

  function sync() {
    (FINE.matches && !REDUCE.matches) ? build() : destroy();
    // el polvo va aparte: sobrevive sin lámpara, sólo lo mata reduced-motion
    if (!REDUCE.matches) {
      var els = anfitriones();
      for (var i = 0; i < els.length; i++) polvo(els[i]);
    }
  }

  function watch(mq) {
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);      // Safari < 14
  }
  watch(FINE); watch(REDUCE);
  sync();
})();
