/* ============================================================================
   lamp.js · ESTACIÓN 47 — LÁMPARA DE TRABAJO
   ----------------------------------------------------------------------------
   Autónomo: no lee ni escribe nada de app.js, no exporta nada, sin dependencias.
   Carga:  <script src="lamp.js" defer></script>   (después de app.js)

   CONTRATO DE RENDIMIENTO
     · La ÚNICA escritura por frame es  arm.style.transform  sobre #lamp-arm,
       un <div> vacío creado aquí. transform no se hereda: el recálculo de
       estilo abarca ese elemento y nada más.
     · NUNCA se escribe una custom property, ni en :root ni en ningún ancestro.
       Medido en este panel: escribir una custom property en :root cuesta
       14 600 µs de recálculo de estilo; escribir transform en una hoja, 15 µs.
     · El rAF se APAGA en cuanto el foco alcanza al cursor. Con el ratón quieto
       leyendo la consola, el coste por frame es exactamente cero.
     · Cero getBoundingClientRect en pointermove: el origen de .main se cachea
       y sólo se recalcula cuando .main cambia de tamaño (login, resize,
       breakpoint), vía ResizeObserver.
   ========================================================================== */
(function () {
  'use strict';

  var FINE   = matchMedia('(hover:hover) and (pointer:fine)');
  var REDUCE = matchMedia('(prefers-reduced-motion:reduce)');

  var EASE = 0.16;   // inercia del brazo: la lámpara pesa
  var IDLE = 900;    // ms parado antes de empezar a respirar

  var main = document.querySelector('.main');
  var lamp = null, arm = null, ro = null;
  var raf = 0, idle = 0;
  var ox = 0, oy = 0;                      // origen de .main en el viewport
  var tx = 0, ty = 0, cx = 0, cy = 0, seen = false;

  function origin() {
    var r = main.getBoundingClientRect();
    ox = r.left; oy = r.top;
  }

  function tick() {
    raf = 0;
    var dx = tx - cx, dy = ty - cy;
    cx += dx * EASE; cy += dy * EASE;
    arm.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
    if (dx * dx + dy * dy > 0.25) raf = requestAnimationFrame(tick);
  }

  function move(e) {
    if (e.pointerType === 'touch') return;       // híbridos: el dedo no enciende la lámpara
    tx = e.clientX - ox; ty = e.clientY - oy;
    if (!seen) { seen = true; cx = tx; cy = ty; }   // sin barrido inicial desde 0,0
    if (lamp.className) lamp.className = '';        // quita is-idle / is-away
    clearTimeout(idle); idle = setTimeout(rest, IDLE);
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function rest() { if (lamp) lamp.className = 'is-idle'; }

  function away() {
    if (!lamp) return;
    clearTimeout(idle);
    lamp.className = 'is-away';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function hide() { if (document.hidden) away(); }

  function build() {
    if (lamp || !main) return;
    lamp = document.createElement('div');
    lamp.id = 'lamp';
    lamp.setAttribute('aria-hidden', 'true');
    arm = document.createElement('div');
    arm.id = 'lamp-arm';
    var lens = document.createElement('div');
    lens.id = 'lamp-lens';
    arm.appendChild(lens); lamp.appendChild(arm); main.appendChild(lamp);

    seen = false; origin();
    main.classList.add('lamp-live');

    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerdown', move, { passive: true });
    addEventListener('resize', origin, { passive: true });
    document.addEventListener('pointerleave', away);
    document.addEventListener('visibilitychange', hide);
    if (window.ResizeObserver) { ro = new ResizeObserver(origin); ro.observe(main); }
  }

  function destroy() {
    if (!lamp) return;
    removeEventListener('pointermove', move);
    removeEventListener('pointerdown', move);
    removeEventListener('resize', origin);
    document.removeEventListener('pointerleave', away);
    document.removeEventListener('visibilitychange', hide);
    if (ro) { ro.disconnect(); ro = null; }
    clearTimeout(idle);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    main.classList.remove('lamp-live');
    lamp.remove(); lamp = arm = null;
  }

  function sync() { (FINE.matches && !REDUCE.matches) ? build() : destroy(); }

  function watch(mq) {
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);      // Safari < 14
  }
  watch(FINE); watch(REDUCE);
  sync();
})();
