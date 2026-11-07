/*! Ziffer tracker — cookieless page views, engaged time, scroll depth, clicks and occasional page-layout snapshots for heatmaps. Form input is never recorded. */
(function (w, d) {
  if (w.__ziffer || w.top !== w.self || navigator.webdriver) return; // not inside Ziffer's heatmap preview iframes or bots
  var s = d.currentScript, key = s && s.getAttribute('data-site');
  if (!key) return;
  w.__ziffer = 1;
  var api = new URL('api/collect', s.src).href;
  var q = [], pv = null, recent = [], firstPv = true, sid;
  function rid() { var a = new Uint8Array(12); (w.crypto || w.msCrypto).getRandomValues(a); for (var o = '', i = 0; i < a.length; i++) o += ('0' + a[i].toString(16)).slice(-2); return o; }
  try { sid = sessionStorage.getItem('zf_sid'); if (!sid) { sid = rid(); sessionStorage.setItem('zf_sid', sid); } } catch (e) { sid = rid(); }
  function dims() { var e = d.documentElement, b = d.body || e; return { vw: w.innerWidth, vh: w.innerHeight, dw: Math.max(e.scrollWidth, b.scrollWidth), dh: Math.max(e.scrollHeight, b.scrollHeight) }; }
  function refHost() { try { var h = new URL(d.referrer).hostname; return h === location.hostname ? '' : h; } catch (e) { return ''; } }
  function engaged() { return pv ? pv.vis + (pv.since ? Date.now() - pv.since : 0) : 0; }
  function onScroll() { if (!pv) return; var g = dims(), p = g.dh > 0 ? Math.min(100, ((w.scrollY + g.vh) / g.dh) * 100) : 100; if (p > pv.scroll) pv.scroll = p; }
  function end() { if (!pv) return; q.push({ t: 'end', id: pv.id, dur: Math.round(engaged() / 100) / 10, sc: Math.round(pv.scroll), dh: dims().dh }); }
  function start() {
    if (pv && pv.path === location.pathname) return;
    if (pv) end();
    var g = dims(), now = Date.now();
    pv = { id: rid(), path: location.pathname, vis: 0, since: d.visibilityState === 'visible' ? now : 0, scroll: 0 };
    // Query strings and hashes are dropped on purpose — they often carry personal data.
    q.push({ t: 'pv', id: pv.id, p: pv.path, ti: d.title.slice(0, 140), r: firstPv ? refHost() : '', vw: g.vw, vh: g.vh, dw: g.dw, dh: g.dh, ts: now });
    firstPv = false;
    onScroll(); flush();
    whenSettled(maybeSnapshot);
  }

  /* ---- Page snapshot for heatmaps --------------------------------------------------------------
     About once every few days per page, Ziffer asks the visitor's browser for a copy of the page
     layout, so heatmaps can be drawn on the real page even when the site can't be framed.
     Scripts, form values and anything marked data-ziffer-mask are removed before sending. */
  var snapApi = new URL('api/snap', s.src).href;
  function whenSettled(fn) {
    var go = function () { setTimeout(function () { (w.requestIdleCallback || setTimeout)(fn, { timeout: 1500 }); }, 900); };
    if (d.readyState === 'complete') go(); else w.addEventListener('load', go, { once: true });
  }
  function maybeSnapshot() {
    if (!pv || !w.fetch || !w.DOMParser) return;
    var path = pv.path, g = dims();
    if (g.vw < 200 || g.vh < 200) return;
    var flag = 'zf_snap:' + (g.vw < 768 ? 'm' : 'd') + path;
    try { if (sessionStorage.getItem(flag)) return; sessionStorage.setItem(flag, '1'); } catch (e) {}
    fetch(snapApi + '?k=' + encodeURIComponent(key) + '&p=' + encodeURIComponent(path) + '&vw=' + g.vw, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : { need: false }; })
      .then(function (j) {
        if (!j.need || !pv || pv.path !== path) return;
        var html = snapshotHtml();
        if (!html || html.length > 3e6) return;
        var g2 = dims();
        fetch(snapApi, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ k: key, p: path, vw: g2.vw, vh: g2.vh, dw: g2.dw, dh: g2.dh, html: html }) });
      })['catch'](function () {});
  }
  function snapshotHtml() {
    var live = d.documentElement, all = live.querySelectorAll('*'), i;
    // Mark live elements so the clone can be matched up with computed state.
    var canv = live.querySelectorAll('canvas'), sizes = [];
    for (i = 0; i < canv.length; i++) { var rc = canv[i].getBoundingClientRect(); sizes.push([rc.width, rc.height]); }
    var sheets = [];
    for (i = 0; i < d.styleSheets.length; i++) {
      var sh = d.styleSheets[i], own = sh.ownerNode;
      // CSS injected through the CSSOM (CSS-in-JS) isn't in the markup, so copy its rules.
      try { if (own && own.tagName === 'STYLE' && !own.textContent.trim() && sh.cssRules.length) sheets.push([i, Array.prototype.map.call(sh.cssRules, function (r) { return r.cssText; }).join('\n')]); } catch (e) {}
    }
    var c = live.cloneNode(true);
    var drop = c.querySelectorAll('script, noscript, iframe, object, embed, template, link[rel=preload], link[rel=modulepreload], link[rel=prefetch], meta[http-equiv], base');
    for (i = 0; i < drop.length; i++) {
      var el = drop[i];
      if (el.tagName === 'IFRAME' || el.tagName === 'OBJECT' || el.tagName === 'EMBED') {
        var ph = d.createElement('div'); ph.setAttribute('style', (el.getAttribute('style') || '') + ';background:#d9d9d9;width:' + (el.getAttribute('width') ? el.getAttribute('width') + 'px' : '100%') + ';height:' + (el.getAttribute('height') ? el.getAttribute('height') + 'px' : '100%'));
        ph.className = el.className || '';
        el.parentNode.replaceChild(ph, el);
      } else el.parentNode && el.parentNode.removeChild(el);
    }
    var cc = c.querySelectorAll('canvas');
    for (i = 0; i < cc.length; i++) { var cd = d.createElement('div'); cd.className = cc[i].className || ''; cd.setAttribute('style', (cc[i].getAttribute('style') || '') + ';background:#cfcfcf;width:' + Math.round(sizes[i] ? sizes[i][0] : 0) + 'px;height:' + Math.round(sizes[i] ? sizes[i][1] : 0) + 'px'); cc[i].parentNode.replaceChild(cd, cc[i]); }
    var els = c.querySelectorAll('*');
    for (i = 0; i < els.length; i++) {
      var e = els[i], t = e.tagName;
      for (var a = e.attributes.length - 1; a >= 0; a--) {
        var n = e.attributes[a].name, v = e.attributes[a].value;
        if (/^on/i.test(n) || (/^(href|src|action|formaction|xlink:href)$/i.test(n) && /^\s*javascript:/i.test(v))) e.removeAttribute(n);
      }
      if (t === 'INPUT') { e.removeAttribute('value'); e.removeAttribute('checked'); }
      if (t === 'TEXTAREA') e.textContent = '';
      if (t === 'OPTION') e.removeAttribute('selected');
      if (t === 'VIDEO' || t === 'AUDIO') { e.removeAttribute('autoplay'); }
      if (t === 'IMG' || t === 'SOURCE') {
        e.setAttribute('loading', 'eager');
        var ds = e.getAttribute('data-src'), dss = e.getAttribute('data-srcset');
        if (ds && !/^(https?:|\/)/i.test(e.getAttribute('src') || '')) e.setAttribute('src', ds);
        if (dss && !e.getAttribute('srcset')) e.setAttribute('srcset', dss);
      }
      // Scroll-in animations (Webflow interactions, AOS) leave unseen content invisible — show it in its final state.
      if (e.hasAttribute('data-w-id') && e.style) { e.style.removeProperty('opacity'); e.style.removeProperty('transform'); e.style.removeProperty('visibility'); e.style.removeProperty('filter'); }
      if (e.hasAttribute('data-aos')) e.classList.add('aos-animate');
      if (e.hasAttribute('data-ziffer-mask')) { e.textContent = ''; e.setAttribute('style', (e.getAttribute('style') || '') + ';background:#bbb'); }
    }
    var head = c.querySelector('head');
    if (head) {
      for (i = 0; i < sheets.length; i++) { var st = d.createElement('style'); st.textContent = sheets[i][1]; head.appendChild(st); }
      var base = d.createElement('base'); base.setAttribute('href', location.href.split('#')[0].split('?')[0]); head.insertBefore(base, head.firstChild);
    }
    var dt = d.doctype ? '<!DOCTYPE ' + d.doctype.name + '>' : '<!DOCTYPE html>';
    return dt + c.outerHTML;
  }
  function sel(el) {
    for (var parts = [], n = 0; el && el.nodeType === 1 && n < 4; n++, el = el.parentElement) {
      var p = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(p + '#' + el.id.slice(0, 40)); break; }
      var c = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).slice(0, 2).join('.');
      parts.unshift(c ? p + '.' + c : p);
    }
    return parts.join('>').slice(0, 200);
  }
  function onClick(e) {
    if (!pv) return;
    var g = dims(), x = e.pageX, y = e.pageY, now = Date.now();
    recent = recent.filter(function (c) { return now - c.t < 800 && Math.abs(c.x - x) < 30 && Math.abs(c.y - y) < 30; });
    recent.push({ t: now, x: x, y: y });
    var rage = recent.length >= 3 ? 1 : 0; if (rage) recent = [];
    q.push({ t: 'c', id: pv.id, p: pv.path, xr: Math.round((x / Math.max(1, g.dw)) * 1e4) / 1e4, y: Math.round(y), vw: g.vw, dw: g.dw, dh: g.dh, s: sel(e.target), rg: rage, ts: now });
    if (q.length > 40) flush();
  }
  function flush() {
    if (!q.length) return;
    var body = JSON.stringify({ k: key, sid: sid, ev: q.splice(0, 200) });
    try { if (navigator.sendBeacon && navigator.sendBeacon(api, new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
    try { fetch(api, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
  }
  d.addEventListener('visibilitychange', function () {
    if (!pv) return;
    if (d.visibilityState === 'hidden') { if (pv.since) { pv.vis += Date.now() - pv.since; pv.since = 0; } end(); flush(); }
    else pv.since = Date.now();
  });
  w.addEventListener('pagehide', function () { end(); flush(); });
  w.addEventListener('scroll', onScroll, { passive: true });
  d.addEventListener('click', onClick, true);
  ['pushState', 'replaceState'].forEach(function (m) { var o = history[m]; history[m] = function () { var r = o.apply(this, arguments); if (live) setTimeout(start, 0); return r; }; });
  w.addEventListener('popstate', function () { if (live) start(); });
  setInterval(flush, 5000);
  // Count a page only once it is really shown: not while Chrome prerenders it, and not while it sits in a
  // background tab with no layout yet (its width would read as 0 and look like a tiny mobile screen).
  var live = false;
  function shown() { return !d.prerendering && d.visibilityState === 'visible' && w.innerWidth > 0; }
  function go() {
    if (live) return;
    if (d.readyState === 'loading' || !shown()) return;
    live = true; start();
  }
  d.addEventListener('DOMContentLoaded', go);
  d.addEventListener('visibilitychange', go);
  d.addEventListener('prerenderingchange', go);
  w.addEventListener('resize', go);
  go();
})(window, document);
