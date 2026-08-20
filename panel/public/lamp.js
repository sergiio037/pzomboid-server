/* ============================================================================
   lamp.js · ESTACIÓN 47 — LÁMPARA DE TRABAJO + RED DE NODOS
   ----------------------------------------------------------------------------
   Autónomo: no lee ni escribe nada de app.js, no exporta nada, sin dependencias.
   Carga:  <script src="lamp.js" defer></script>   (después de app.js)

   DOS PIEZAS
     · LÁMPARA  capa CSS que sigue al cursor. La única escritura por frame es
       transform sobre un <div> vacío: 15 µs, sin recálculo de estilo ajeno.
       NUNCA se escribe una custom property (medido: 14 600 µs en :root).
     · NODOS    canvas detrás del contenido. Puntos que derivan despacio y se
       unen con filamentos cuando se acercan; el cursor los atrae y enlaza con
       los que tiene cerca. Todo el dibujo ocurre en el canvas, así que no toca
       el DOM: ni un recálculo de estilo ni un layout, pase lo que pase en la
       consola o en las 914 filas de ajustes.

   FRENOS DE RENDIMIENTO
     · Densidad por área, con tope duro. En 1920×1080 son ~62 nodos.
     · El emparejado es O(n²) sobre esos nodos: ~1900 comparaciones por frame,
       coste despreciable frente a los 16,6 ms de presupuesto.
     · Se detiene por completo con la pestaña oculta.
     · No arranca con prefers-reduced-motion ni en punteros gruesos (móvil).
   ========================================================================== */
(function () {
  'use strict';

  var FINE   = matchMedia('(hover:hover) and (pointer:fine)');
  var REDUCE = matchMedia('(prefers-reduced-motion:reduce)');

  var EASE = 0.16;      // inercia del brazo de la lámpara
  var IDLE = 900;       // ms parado antes de respirar

  var DENSIDAD = 26000; // 1 nodo por cada N px²
  var MAX_NODOS = 70;
  var D_ENLACE = 132;   // distancia máxima para unir dos nodos
  var D_RATON  = 168;   // radio de influencia del cursor
  var GRAVEDAD = 0.52;  // tirón del cursor. Sube despacio: a 1 ya se nota "pegajoso"
  var VIDA_MIN = 1500;  // frames. A 60 fps son 25 s
  var VIDA_MAX = 4200;  // ~70 s
  var FUNDIDO  = 0.18;  // fracción de la vida que dura el entrar y el salir

  var hosts = [];
  var ro = null, rafLamp = 0, rafRed = 0, idle = 0;
  var tx = 0, ty = 0;   // cursor en viewport

  /* ---------------------------------------------------------------- lámpara */

  function origin() {
    for (var i = 0; i < hosts.length; i++) {
      var r = hosts[i].el.getBoundingClientRect();
      hosts[i].ox = r.left; hosts[i].oy = r.top;
    }
  }

  function tickLamp() {
    rafLamp = 0;
    var vivo = false;
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (!h.arm) continue;
      var dx = (tx - h.ox) - h.cx, dy = (ty - h.oy) - h.cy;
      h.cx += dx * EASE; h.cy += dy * EASE;
      h.arm.style.transform =
        'translate3d(' + h.cx.toFixed(1) + 'px,' + h.cy.toFixed(1) + 'px,0)';
      if (dx * dx + dy * dy > 0.25) vivo = true;
    }
    if (vivo) rafLamp = requestAnimationFrame(tickLamp);
  }

  function move(e) {
    if (e.pointerType === 'touch') return;
    tx = e.clientX; ty = e.clientY;
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (!h.seen) { h.seen = true; h.cx = tx - h.ox; h.cy = ty - h.oy; }
      if (h.lamp && h.lamp.className) h.lamp.className = '';
    }
    clearTimeout(idle); idle = setTimeout(rest, IDLE);
    if (!rafLamp) rafLamp = requestAnimationFrame(tickLamp);
  }

  function marca(c) {
    for (var i = 0; i < hosts.length; i++) if (hosts[i].lamp) hosts[i].lamp.className = c;
  }
  function rest() { marca('is-idle'); }
  function away() {
    if (!hosts.length) return;
    clearTimeout(idle); marca('is-away');
    if (rafLamp) { cancelAnimationFrame(rafLamp); rafLamp = 0; }
  }

  /* ------------------------------------------------------------------ nodos */

  /* Un nodo nuevo. `repartido` sólo en la siembra inicial: así los primeros
     no nacen todos a la vez y el relevo nunca se percibe como una tanda. */
  function nodo(w, hh, repartido) {
    var vida = VIDA_MIN + Math.random() * (VIDA_MAX - VIDA_MIN);
    return {
      x: Math.random() * w,
      y: Math.random() * hh,
      vx: (Math.random() - 0.5) * 0.16,
      vy: (Math.random() - 0.5) * 0.16,
      r: 0.8 + Math.random() * 1.5,
      vida: vida,
      edad: repartido ? Math.random() * vida : 0,
    };
  }

  /* Opacidad por edad: entra, vive y se va. Con FUNDIDO al 18 % de una vida de
     25-70 s, el fundido dura entre 4 y 12 segundos: imposible de pillar. */
  function fundido(a) {
    var t = a.edad / a.vida;
    if (t < FUNDIDO) return t / FUNDIDO;
    if (t > 1 - FUNDIDO) return (1 - t) / FUNDIDO;
    return 1;
  }

  function sembrar(h) {
    var w = h.cv.clientWidth, hh = h.cv.clientHeight;
    var n = Math.min(MAX_NODOS, Math.max(14, Math.round((w * hh) / DENSIDAD)));
    h.nodos = [];
    for (var i = 0; i < n; i++) h.nodos.push(nodo(w, hh, true));
  }

  function medirCanvas(h) {
    var dpr = Math.min(devicePixelRatio || 1, 2);
    var w = h.el.clientWidth, hh = h.el.clientHeight;
    if (!w || !hh) return;
    h.cv.width = Math.round(w * dpr);
    h.cv.height = Math.round(hh * dpr);
    h.cv.style.width = w + 'px';
    h.cv.style.height = hh + 'px';
    h.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!h.nodos || !h.nodos.length) sembrar(h);
  }

  function pintar() {
    rafRed = requestAnimationFrame(pintar);
    for (var k = 0; k < hosts.length; k++) {
      var h = hosts[k];
      if (!h.ctx) continue;

      /* AUTOCURACION. build() corre con .main Y .login-screen todavia en
         display:none (app.js no decide cual mostrar hasta que resuelve
         /api/session), asi que medirCanvas sale por su guarda y h.nodos queda
         null. El ResizeObserver deberia rescatarlo al des-ocultar, pero no lo
         hace: medido en Chrome, el canvas de .main seguia a 300x150 con el
         bitmap VACIO (suma de alfa 0) despues de entrar al panel — o sea, el
         dashboard no tenia ni un nodo. Solo un 'resize' de ventana lo salvaba.
         Aqui se remide en cuanto el anfitrion tiene caja, pase lo que pase con
         el observer. remedir() ademas recalcula origin(), que tambien estaba
         rancio (.main mide left=0 mientras esta oculto, pero ~232 despues, y
         el cursor tiraba de los nodos desplazado por esa diferencia).
         Un anfitrion oculto cuesta una lectura de clientWidth y se va. */
      if (!h.nodos) {
        if (!h.el.clientWidth || !h.el.clientHeight) continue;
        remedir();
        if (!h.nodos) continue;
      }

      var w = h.cv.clientWidth, hh = h.cv.clientHeight;
      if (!w || !hh) continue;

      var ctx = h.ctx, ns = h.nodos, i, j, a, b, dx, dy, d2, d;
      ctx.clearRect(0, 0, w, hh);

      // cursor en coordenadas del anfitrión; fuera de él, sin influencia
      var mx = tx - h.ox, my = ty - h.oy;
      var dentro = h.seen && mx > -D_RATON && my > -D_RATON
                          && mx < w + D_RATON && my < hh + D_RATON;

      for (i = 0; i < ns.length; i++) {
        a = ns[i];
        a.x += a.vx; a.y += a.vy;

        // envejece; al agotarse renace en otro sitio, ya desvanecido
        a.edad++;
        if (a.edad >= a.vida) ns[i] = a = nodo(w, hh, false);
        a.op = fundido(a);

        // el cursor tira suavemente de los nodos cercanos
        if (dentro) {
          dx = mx - a.x; dy = my - a.y; d2 = dx * dx + dy * dy;
          if (d2 < D_RATON * D_RATON && d2 > 1) {
            d = Math.sqrt(d2);
            var f = (1 - d / D_RATON) * GRAVEDAD;
            a.x += (dx / d) * f; a.y += (dy / d) * f;
          }
        }

        // rebote suave en los bordes: nunca desaparecen del lienzo
        if (a.x < 0 || a.x > w) { a.vx *= -1; a.x = a.x < 0 ? 0 : w; }
        if (a.y < 0 || a.y > hh) { a.vy *= -1; a.y = a.y < 0 ? 0 : hh; }
      }

      // filamentos entre nodos próximos
      ctx.lineWidth = 1;
      for (i = 0; i < ns.length; i++) {
        a = ns[i];
        for (j = i + 1; j < ns.length; j++) {
          b = ns[j];
          dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy;
          if (d2 > D_ENLACE * D_ENLACE) continue;
          d = Math.sqrt(d2);
          ctx.strokeStyle = 'rgba(180,210,74,'
            + ((1 - d / D_ENLACE) * 0.13 * a.op * b.op).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }

      // hilos al cursor: la interacción se ve, no se intuye
      if (dentro) {
        for (i = 0; i < ns.length; i++) {
          a = ns[i];
          dx = mx - a.x; dy = my - a.y; d2 = dx * dx + dy * dy;
          if (d2 > D_RATON * D_RATON) continue;
          d = Math.sqrt(d2);
          ctx.strokeStyle = 'rgba(92,200,255,'
            + ((1 - d / D_RATON) * 0.3 * a.op).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mx, my); ctx.stroke();
        }
      }

      // los nodos, encima de sus hilos
      for (i = 0; i < ns.length; i++) {
        a = ns[i];
        var cerca = 0;
        if (dentro) {
          dx = mx - a.x; dy = my - a.y; d2 = dx * dx + dy * dy;
          if (d2 < D_RATON * D_RATON) cerca = 1 - Math.sqrt(d2) / D_RATON;
        }
        ctx.fillStyle = cerca > 0.05
          ? 'rgba(92,200,255,' + ((0.24 + cerca * 0.5) * a.op).toFixed(3) + ')'
          : 'rgba(236,231,217,' + (0.24 * a.op).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r + cerca * 1.4, 0, 6.283);
        ctx.fill();
      }
    }
  }

  function arrancarRed() { if (!rafRed) rafRed = requestAnimationFrame(pintar); }
  function pararRed() { if (rafRed) { cancelAnimationFrame(rafRed); rafRed = 0; } }

  function visibilidad() {
    if (document.hidden) { pararRed(); away(); }
    else if (hosts.length) arrancarRed();
  }

  /* ------------------------------------------------------------- ensamblaje */

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
      lamp.id = 'lamp'; lamp.className = 'is-away';
      lamp.setAttribute('aria-hidden', 'true');
      var arm = document.createElement('div'); arm.id = 'lamp-arm';
      var lens = document.createElement('div'); lens.id = 'lamp-lens';
      arm.appendChild(lens); lamp.appendChild(arm); el.appendChild(lamp);

      var cv = document.createElement('canvas');
      cv.className = 'nodes';
      cv.setAttribute('aria-hidden', 'true');
      el.appendChild(cv);

      var h = { el: el, lamp: lamp, arm: arm, cv: cv, ctx: cv.getContext('2d'),
                nodos: null, ox: 0, oy: 0, cx: 0, cy: 0, seen: false };
      el.classList.add('lamp-live');
      hosts.push(h);
      medirCanvas(h);
    }
    origin();

    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerdown', move, { passive: true });
    addEventListener('resize', remedir, { passive: true });
    document.addEventListener('pointerleave', away);
    document.addEventListener('visibilitychange', visibilidad);
    if (window.ResizeObserver) {
      ro = new ResizeObserver(remedir);
      for (var j = 0; j < hosts.length; j++) ro.observe(hosts[j].el);
    }
    arrancarRed();
  }

  function remedir() {
    origin();
    for (var i = 0; i < hosts.length; i++) medirCanvas(hosts[i]);
  }

  function destroy() {
    if (!hosts.length) return;
    removeEventListener('pointermove', move);
    removeEventListener('pointerdown', move);
    removeEventListener('resize', remedir);
    document.removeEventListener('pointerleave', away);
    document.removeEventListener('visibilitychange', visibilidad);
    if (ro) { ro.disconnect(); ro = null; }
    clearTimeout(idle);
    if (rafLamp) { cancelAnimationFrame(rafLamp); rafLamp = 0; }
    pararRed();
    for (var i = 0; i < hosts.length; i++) {
      hosts[i].el.classList.remove('lamp-live');
      hosts[i].lamp.remove();
      hosts[i].cv.remove();
    }
    hosts = [];
  }

  function sync() { (FINE.matches && !REDUCE.matches) ? build() : destroy(); }

  function watch(mq) {
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);
  }
  watch(FINE); watch(REDUCE);
  sync();
})();
