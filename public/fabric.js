/* Probe: a slowly twisting ribbon of plus signs in the top-left corner (canvas, no dependencies).
   Load it with a script tag: defer, src="/app/fabric.js", data-strength="0.5".
   (No closing script tag may appear anywhere in this file: the app inlines it.)
     data-strength  0..1   how visible it is
     data-scale     0.5..1.5  size of the ribbon (default 1)
     data-mono      present = greyscale: text colour only, no heat colours (used inside the app, next to data)
   Near pluses are larger than far ones. Now and then a region warms up like a heatmap.
   Still image with prefers-reduced-motion, paused while the tab is hidden.
   The app inlines this file at the top of <body> (src/layouts/App.astro); the public site loads it with defer. */
(function () {
  if (window.__probeFabric) return; window.__probeFabric = (window.performance && performance.now()) || 1;
  var me = document.currentScript;
  var num = function (name, d) { var v = parseFloat((me && me.getAttribute(name)) || ''); return isFinite(v) ? v : d; };
  var strength = Math.max(0, Math.min(1, num('data-strength', 0.35)));
  var scale = Math.max(0.5, Math.min(1.5, num('data-scale', 1)));
  var mono = !!(me && me.hasAttribute('data-mono'));

  function start() {
    var root = document.documentElement, body = document.body;
    // Let the canvas sit behind the page: the page colour moves to <html>, <body> goes transparent.
    var bg = getComputedStyle(body).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      root.style.backgroundColor = getComputedStyle(root).getPropertyValue('--_theme---background') ? 'var(--_theme---background)' : bg;
      body.style.backgroundColor = 'transparent';
    }
    var c = document.createElement('canvas'), ctx = c.getContext('2d');
    if (!ctx) return;
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;top:0;left:0;width:min(' + Math.round(1040 * scale) + 'px,100vw);height:min(' + Math.round(820 * scale) + 'px,100vh);pointer-events:none;z-index:-1';
    body.insertBefore(c, body.firstChild);

    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
    var W = 0, H = 0, dpr = 1, raf = 0, last = 0, lastColor = 0;
    var U = 96, V = 20;                                   // plus signs along and across the ribbon
    var ink = [128, 128, 128], colA = [59, 91, 253], colB = [138, 108, 255];
    // Heat colours: the heatmaps' cool, warm and hot, with two in-between hues so a region reads as a heatmap.
    var HEAT = [[59, 120, 253], [53, 195, 232], [176, 214, 84], [255, 188, 64], [255, 82, 56]];
    function heat(e) { var x = Math.max(0, Math.min(0.9999, e)) * (HEAT.length - 1), i = Math.floor(x), k = x - i, a = HEAT[i], b = HEAT[i + 1]; return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
    function rnd(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
    // Hot regions: a few spots that appear somewhere on the ribbon, build up, and cool off again.
    var SPOTS = [{ every: 17, life: 10, shift: 0 }, { every: 23, life: 12, shift: 7 }, { every: 29, life: 11, shift: 15 }];
    var JIT = []; for (var n = 0; n < U * V; n++) JIT.push(rnd(n) - 0.5);
    var live = [];
    function spots(t) {
      live.length = 0;
      for (var k = 0; k < SPOTS.length; k++) {
        var sp = SPOTS[k], tt = t + sp.shift, cyc = Math.floor(tt / sp.every), ph = tt - cyc * sp.every;
        if (ph > sp.life) continue;
        var seed = k * 97 + cyc * 13.37, grow = Math.sin(Math.PI * ph / sp.life);
        live.push({ u: 0.14 + 0.66 * rnd(seed) + 0.02 * Math.sin(t * 0.3 + k), v: -0.6 + 1.2 * rnd(seed + 1), ru: 0.07 + 0.05 * rnd(seed + 2), rv: 0.5 + 0.35 * rnd(seed + 3), peak: (0.72 + 0.28 * rnd(seed + 4)) * Math.pow(grow, 0.8) });
      }
    }

    function rgbOf(s) {
      s = String(s || '').trim();
      var h = /^#([0-9a-f]{6})/i.exec(s); if (h) return [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)];
      var m = /(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null;
    }
    function colors() {
      ink = rgbOf(getComputedStyle(body).color) || ink;
      if (mono) return;
      var cs = getComputedStyle(root), dark = (ink[0] + ink[1] + ink[2]) / 3 > 128;
      colA = rgbOf(cs.getPropertyValue('--_theme---accent')) || (dark ? [125, 141, 255] : [59, 91, 253]);
      colB = rgbOf(cs.getPropertyValue('--z-agent')) || (dark ? [169, 149, 255] : [138, 108, 255]);
    }
    function size() { dpr = Math.min(2, window.devicePixelRatio || 1); W = c.clientWidth; H = c.clientHeight; c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }

    // The ribbon's spine: comes in over the top edge, curls through the corner and leaves over the left edge.
    function spine(u, t) {
      return [0.50 - 0.60 * u + 0.05 * Math.sin(u * 4.6 + t * 0.22), -0.09 + 0.56 * Math.pow(u, 1.2) + 0.05 * Math.sin(u * 3.4 - 0.5 + t * 0.17)];
    }

    function frame(ms) {
      if (ms - lastColor > 1000) { colors(); lastColor = ms; }
      // Time comes from the clock, not from when the page loaded, so the ribbon is in the same place on every page
      // and carries on where it was when you move between them. (Reduced motion: one fixed moment.)
      var t = reduce && reduce.matches ? 12 : (Date.now() % 86400000) / 1000, S = Math.max(420 * scale, Math.min(W, 1040 * scale)), base = 0.12 + 1.18 * strength;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); spots(t);
      ctx.lineCap = 'round';
      for (var i = 0; i < U; i++) {
        var u = i / (U - 1), p = spine(u, t), q = spine(u + 0.004, t);
        var tx = q[0] - p[0], ty = q[1] - p[1], tl = Math.sqrt(tx * tx + ty * ty) || 1, nx = -ty / tl, ny = tx / tl;
        var twist = 0.35 + u * 5.4 + 0.6 * Math.sin(t * 0.21 + u * 2.3);      // the sheet turns over as it travels
        var width = 0.07 + 0.07 * Math.sin(u * Math.PI) + 0.012 * Math.sin(u * 7 + t * 0.3);
        var fadeU = Math.min(1, u * 7) * Math.min(1, (1 - u) * 5);
        var mix = 0.5 + 0.5 * Math.sin(u * 3.1 + t * 0.12);
        for (var j = 0; j < V; j++) {
          var v = (j / (V - 1)) * 2 - 1;
          var ripple = 0.012 * Math.sin(u * 16 + v * 3 + t * 0.6);
          var off = (width * v + ripple) * Math.cos(twist), z = width * v * Math.sin(twist);  // z: towards (+) or away from (−) the viewer
          var k = 1 + z * 1.4;                                                // gentle perspective
          var px = (p[0] + nx * off) * S * k, py = (p[1] + ny * off) * S * k;
          if (px < -8 || py < -8 || px > W + 8 || py > H + 8) continue;
          var depth = 0.5 + 0.5 * v * Math.sin(twist);                         // 0 = far edge, 1 = near edge
          var edge = 1 - Math.pow(Math.abs(v), 3) * 0.55;
          var a = Math.min(1, base * fadeU * edge * (0.16 + 0.84 * depth));
          if (a < 0.012) continue;
          var r = ink[0], g = ink[1], b = ink[2];
          if (!mono) {
            var m = mix * (0.35 + 0.65 * depth);
            r = colA[0] + (colB[0] - colA[0]) * m; g = colA[1] + (colB[1] - colA[1]) * m; b = colA[2] + (colB[2] - colA[2]) * m;
            // far side of the sheet leans towards the text colour, so the turn-over reads as depth
            r += (ink[0] - r) * (1 - depth) * 0.45; g += (ink[1] - g) * (1 - depth) * 0.45; b += (ink[2] - b) * (1 - depth) * 0.45;
          }
          // Heat: strongest at a spot's centre, falling off outwards, and only on the side facing the viewer.
          var e = 0;
          for (var s2 = 0; s2 < live.length; s2++) { var sp = live[s2], du = (u - sp.u) / sp.ru, dv = (v - sp.v) / sp.rv, f = sp.peak * Math.exp(-(du * du + dv * dv) * 0.9); if (f > e) e = f; }
          if (e > 0.03) {
            e = Math.max(0, e + JIT[i * V + j] * 0.16 * e) * Math.min(1, Math.max(0, (depth - 0.25) * 2.2));
            if (mono) a = Math.min(1, a * (1 + 0.9 * e));                      // greyscale: a region only gets a little denser
            else { var hc = heat(e), w = Math.min(1, e * 2.2); r += (hc[0] - r) * w; g += (hc[1] - g) * w; b += (hc[2] - b) * w; a = Math.min(1, a + 0.6 * e); }
          } else e = 0;
          var near = Math.pow(depth, 1.7);
          var h = (0.8 + 6 * near + (mono ? 0.6 : 1.4) * e) * (0.7 + 0.3 * scale);
          ctx.strokeStyle = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a.toFixed(3) + ')';
          ctx.lineWidth = 0.7 + 1.1 * near + 0.3 * e;
          ctx.beginPath(); ctx.moveTo(px - h, py); ctx.lineTo(px + h, py); ctx.moveTo(px, py - h); ctx.lineTo(px, py + h); ctx.stroke();
        }
      }
    }
    function loop(t) { raf = requestAnimationFrame(loop); if (t - last < 33) return; last = t; frame(t); }
    function run() { cancelAnimationFrame(raf); size(); colors(); if (reduce && reduce.matches) frame(12000); else { frame(performance.now()); raf = requestAnimationFrame(loop); } }
    window.addEventListener('resize', function () { size(); if (reduce && reduce.matches) frame(12000); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) cancelAnimationFrame(raf); else run(); });
    if (reduce && reduce.addEventListener) reduce.addEventListener('change', run);
    run();
  }
  // Placed inline at the top of <body> (the app does this) it draws before the page's first paint, so moving
  // between pages shows no gap. Loaded with defer from <head> (the public site) it waits for the document.
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
