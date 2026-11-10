// Renders a stored page snapshot (or a neutral page when there is none) with an overlay drawn on top:
//  - heat:   click density, coloured with the logo gradient
//  - scroll: how many visitors reached each depth
//  - path:   one visit's clicks, numbered in order, with the part of the page it never saw dimmed
// Snapshots are uploaded by site visitors, so they are sanitised again here and shown in a frame
// without scripts (CSP + sandbox without allow-scripts). The frame keeps same-origin access only so the
// viewer can scroll it to the interesting spot.

type Heat = { mode: 'heat'; clicks: [number, number, number][]; fold: number };
type Scroll = { mode: 'scroll'; reach: number[]; fold?: number };
type PathO = { mode: 'path'; clicks: [number, number, number, number, number][]; seen: number; fold: number }; // x, y, rage, dead, number
export type SnapProps = {
  snapshot: string | null; // URL of the stored snapshot text
  W: number; H: number; // document size the overlay is drawn in
  viewW: number; viewH: number; // the visitor's viewport
  overlay: Heat | Scroll | PathO;
  title: string;
};

const STOPS: [number, number[]][] = [[0, [59, 120, 253]], [0.45, [255, 188, 64]], [1, [255, 82, 56]]];
function col(t: number) {
  for (let i = 1; i < STOPS.length; i++) if (t <= STOPS[i][0]) {
    const [a0, a] = STOPS[i - 1], [b0, b] = STOPS[i], k = (t - a0) / (b0 - a0);
    return a.map((v, j) => Math.round(v + (b[j] - v) * k));
  }
  return STOPS[STOPS.length - 1][1];
}

function drawHeat(ctx: CanvasRenderingContext2D, W: number, H: number, o: Heat) {
  const R = Math.max(18, W / 45), off = document.createElement('canvas');
  off.width = W; off.height = H;
  const c = off.getContext('2d')!;
  for (const [x, y, rage] of o.clicks) {
    const g = c.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, `rgba(0,0,0,${rage ? 0.16 : 0.08})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(x - R, y - R, R * 2, R * 2);
  }
  const img = c.getImageData(0, 0, W, H), px = img.data;
  let max = 0;
  for (let k = 3; k < px.length; k += 4) if (px[k] > max) max = px[k];
  const lut = Array.from({ length: 256 }, (_, v) => col(Math.min(1, v / (max || 1))));
  for (let m = 0; m < px.length; m += 4) {
    const a = px[m + 3];
    if (a < 4) { px[m + 3] = 0; continue; }
    const cc = lut[a]; px[m] = cc[0]; px[m + 1] = cc[1]; px[m + 2] = cc[2];
    px[m + 3] = Math.round(70 + 150 * Math.pow(a / (max || 1), 0.7));
  }
  ctx.putImageData(img, 0, 0);
  foldLine(ctx, W, o.fold, 'Average fold');
}

function drawScroll(ctx: CanvasRenderingContext2D, W: number, H: number, o: Scroll) {
  const step = H / 20;
  for (let i = 0; i < 20; i++) {
    const r = o.reach[i] || 0, c = col(r);
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.18 + 0.32 * r})`;
    ctx.fillRect(0, i * step, W, step + 1);
  }
  ctx.font = `600 ${Math.max(14, W / 70)}px Inter, system-ui, sans-serif`;
  for (let j = 1; j < 20; j += 2) {
    const y = j * step, label = `${Math.round((o.reach[j] || 0) * 100)}% reached here`;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(16, y - 14, ctx.measureText(label).width + 20, 28);
    ctx.fillStyle = '#fff'; ctx.fillText(label, 26, y + 6);
  }
  if (o.fold) foldLine(ctx, W, o.fold, 'Average fold');
}

function drawPath(ctx: CanvasRenderingContext2D, W: number, H: number, o: PathO) {
  const s = Math.max(1, W / 1280); // keep markers readable on wide pages
  if (o.seen > 0 && o.seen < H) {
    ctx.fillStyle = 'rgba(12,12,16,.58)'; ctx.fillRect(0, o.seen, W, H - o.seen);
    ctx.setLineDash([10 * s, 8 * s]); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.moveTo(0, o.seen); ctx.lineTo(W, o.seen); ctx.stroke(); ctx.setLineDash([]);
    label(ctx, 'Not seen in this visit', 16 * s, o.seen + 28 * s, s, 'rgba(12,12,16,.85)');
  }
  foldLine(ctx, W, o.fold, 'Fold');
  // Path between clicks, then numbered markers on top.
  ctx.strokeStyle = 'rgba(59,120,253,.75)'; ctx.lineWidth = 3 * s; ctx.lineJoin = 'round';
  ctx.beginPath();
  o.clicks.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (o.clicks.length > 1) ctx.stroke();
  o.clicks.forEach(([x, y, rage, dead, num], i) => {
    const r = 15 * s;
    ctx.beginPath(); ctx.arc(x, y, r + 6 * s, 0, Math.PI * 2);
    ctx.fillStyle = rage ? 'rgba(255,82,56,.28)' : dead ? 'rgba(255,188,64,.3)' : 'rgba(59,120,253,.25)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = rage ? '#FF5238' : dead ? '#E9A21F' : '#3B78FD'; ctx.fill();
    ctx.lineWidth = 2.5 * s; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `700 ${13 * s}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(num || i + 1), x, y + 0.5);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  });
}

function foldLine(ctx: CanvasRenderingContext2D, W: number, y: number, text: string) {
  if (!y) return;
  const s = Math.max(1, W / 1280);
  // Dark line with a light edge, so it reads on both light and dark pages.
  ctx.setLineDash([10 * s, 7 * s]);
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  ctx.strokeStyle = 'rgba(12,12,16,.85)'; ctx.lineWidth = 2 * s; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `600 ${13 * s}px Inter, system-ui, sans-serif`;
  const t = `${text} · ${Math.round(y)} px`, w = ctx.measureText(t).width;
  ctx.fillStyle = 'rgba(12,12,16,.88)'; ctx.fillRect(W - w - 36 * s, y - 28 * s, w + 20 * s, 26 * s);
  ctx.fillStyle = '#fff'; ctx.fillText(t, W - w - 26 * s, y - 10 * s);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: number, bg: string) {
  ctx.font = `600 ${14 * s}px Inter, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = bg; ctx.fillRect(x - 10 * s, y - 20 * s, w + 20 * s, 30 * s);
  ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
}

function sanitize(html: string, overlayPng: string, W: number, H: number) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, frame, frameset, meta[http-equiv], link[rel=import], link[rel=preload], link[rel=prefetch], link[rel=modulepreload], form').forEach((n) => {
    if (n.tagName === 'FORM') { const d = doc.createElement('div'); d.className = (n as HTMLElement).className; while (n.firstChild) d.appendChild(n.firstChild); n.replaceWith(d); } else n.remove();
  });
  const bases = doc.querySelectorAll('base');
  bases.forEach((b, i) => { if (i > 0 || !/^https:\/\//i.test(b.getAttribute('href') || '')) b.remove(); });
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || a.name === 'srcdoc' || a.name === 'autofocus' ||
        (/^(href|src|action|formaction|xlink:href|poster|background)$/i.test(a.name) && /^\s*(javascript|vbscript):/i.test(a.value))) el.removeAttribute(a.name);
    }
  });
  const head = doc.head || doc.documentElement;
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri https:");
  head.insertBefore(csp, head.firstChild);
  const st = doc.createElement('style');
  // The page is for looking at: no link clicks, no smooth-scroll lock-ups from scroll libraries.
  st.textContent = 'a,button,input,select,textarea,label,summary{pointer-events:none!important}html{scroll-behavior:auto!important}html,body{overflow-y:auto!important}html.lenis-stopped,html.lenis-stopped body{overflow:auto!important}';
  head.appendChild(st);
  const img = doc.createElement('img');
  img.setAttribute('alt', ''); img.setAttribute('src', overlayPng); img.id = 'zf-overlay';
  img.setAttribute('style', `position:absolute!important;left:0!important;top:0!important;width:${W}px!important;height:${H}px!important;max-width:none!important;max-height:none!important;pointer-events:none!important;z-index:2147483647!important;opacity:1!important;transform:none!important;margin:0!important;border:0!important;filter:none!important`);
  doc.documentElement.appendChild(img);
  return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

function mount(root: HTMLElement) {
  if (root.dataset.mounted) return;
  root.dataset.mounted = '1';
  const p: SnapProps = JSON.parse(root.querySelector('script[type="application/json"]')!.textContent!);
  const stage = root.querySelector<HTMLElement>('.z-snap-stage')!;
  const W = Math.max(1, Math.round(p.W)), H = Math.max(1, Math.min(Math.round(p.H), 30000));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  if (p.overlay.mode === 'heat') drawHeat(ctx, W, H, p.overlay);
  else if (p.overlay.mode === 'scroll') drawScroll(ctx, W, H, p.overlay);
  else drawPath(ctx, W, H, p.overlay);

  const fit = () => {
    const avail = root.clientWidth - 2, s = Math.min(1, avail / p.viewW);
    stage.style.transform = `scale(${s})`;
    stage.style.marginBottom = `${p.viewH * s - p.viewH}px`;
    stage.style.marginRight = `${p.viewW * s - p.viewW}px`;
    stage.style.marginLeft = `${Math.max(0, (avail - p.viewW * s) / 2)}px`;
  };
  fit();
  new ResizeObserver(fit).observe(root);

  const firstY = p.overlay.mode === 'path' && p.overlay.clicks.length ? p.overlay.clicks[0][1] : 0;
  const neutral = () => {
    const box = document.createElement('div');
    box.className = 'z-snap-scroll';
    const page = document.createElement('div');
    page.className = 'z-snap-page'; page.style.width = `${W}px`; page.style.height = `${H}px`;
    cv.className = 'z-snap-canvas'; page.appendChild(cv); box.appendChild(page);
    stage.replaceChildren(box);
    if (firstY > p.viewH * 0.6) box.scrollTop = Math.max(0, firstY - p.viewH / 3);
  };
  if (!p.snapshot) return neutral();

  const frame = document.createElement('iframe');
  frame.title = p.title;
  // No allow-scripts: nothing in the snapshot can run. allow-same-origin only lets this page scroll the frame.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.className = 'z-snap-frame';
  fetch(p.snapshot, { credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
    .then((html) => {
      frame.srcdoc = sanitize(html, cv.toDataURL('image/png'), W, H);
      frame.addEventListener('load', () => {
        try { if (firstY > p.viewH * 0.6) frame.contentWindow!.scrollTo(0, Math.max(0, firstY - p.viewH / 3)); } catch {}
      }, { once: true });
      stage.replaceChildren(frame);
    })
    .catch(neutral);
}

export function mountSnapshotViews() {
  document.querySelectorAll<HTMLElement>('[data-snap-view]').forEach(mount);
}
