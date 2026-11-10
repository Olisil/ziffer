/* Probe: a quiet "fabric" of dots drifting in the top-left corner (canvas, no dependencies).
   <script defer src="/app/fabric.js" data-strength="0.35"></script>  — strength 0..1.
   Still image with prefers-reduced-motion, paused while the tab is hidden. */
(function () {
  if (window.__probeFabric) return; window.__probeFabric = 1;
  var me = document.currentScript, strength = Math.max(0, Math.min(1, parseFloat((me && me.getAttribute('data-strength')) || '0.35')));
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
    c.style.cssText = 'position:fixed;top:0;left:0;width:min(1200px,100vw);height:min(760px,100vh);pointer-events:none;z-index:-1;' +
      '-webkit-mask-image:radial-gradient(120% 110% at 0 0,#000 0%,rgba(0,0,0,.55) 38%,transparent 72%);mask-image:radial-gradient(120% 110% at 0 0,#000 0%,rgba(0,0,0,.55) 38%,transparent 72%)';
    body.insertBefore(c, body.firstChild);
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)'), W = 0, H = 0, dpr = 1, rgb = '128,128,128', raf = 0, last = 0, lastColor = 0;
    var COLS = 90, ROWS = 44;
    function size() { dpr = Math.min(2, window.devicePixelRatio || 1); W = c.clientWidth; H = c.clientHeight; c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    function color() { var m = /(\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(body).color || ''); rgb = m ? m[1] + ',' + m[2] + ',' + m[3] : '128,128,128'; }
    function frame(t) {
      if (t - lastColor > 1000) { color(); lastColor = t; }
      var s = t / 1000, a = 0.10 + 0.55 * strength;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      // A sheet seen from above at an angle: rows recede towards the lower right, slow waves roll through it.
      var cols = COLS, rows = ROWS;
      for (var j = 0; j < rows; j++) {
        var d = j / (rows - 1), persp = 1 / (1 + d * 1.6);
        for (var i = 0; i < cols; i++) {
          var u = i / (cols - 1);
          var wave = Math.sin(u * 7.5 + s * 0.5 + d * 2.2) * 0.55 + Math.sin(u * 3.1 - d * 4.4 - s * 0.32) * 0.35 + Math.cos(u * 13 + d * 9 + s * 0.9) * 0.1;
          var gx = (u * 1.25 - 0.1) * W, gy = (d * 0.95) * H;
          var px = gx * (0.55 + 0.45 * persp) + d * W * 0.1;
          var py = gy * (0.75 + 0.25 * persp) - wave * 95 * persp + 60;
          if (px < -4 || py < -4 || px > W + 4 || py > H + 4) continue;
          var r = (0.8 + 1.2 * persp) * (1 + 0.35 * wave);
          var alpha = a * (0.35 + 0.65 * persp) * (0.25 + 0.75 * (wave + 1) / 2);
          ctx.fillStyle = 'rgba(' + rgb + ',' + alpha.toFixed(3) + ')';
          ctx.fillRect(px - r / 2, py - r / 2, r, r);
        }
      }
    }
    function loop(t) { raf = requestAnimationFrame(loop); if (t - last < 33) return; last = t; frame(t); }
    function run() { cancelAnimationFrame(raf); size(); color(); if (reduce && reduce.matches) frame(12000); else raf = requestAnimationFrame(loop); }
    window.addEventListener('resize', function () { size(); if (reduce && reduce.matches) frame(12000); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) cancelAnimationFrame(raf); else run(); });
    if (reduce && reduce.addEventListener) reduce.addEventListener('change', run);
    run();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
