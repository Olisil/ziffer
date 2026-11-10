// Floor plan for a virtual tour: where visitors walked and looked, their routes, and one visit replayed.
// Ported from the Intus statistics page; colours follow Probe's light and dark themes.
type Room = { id: string; name: string; level: number; rects: number[][]; kind?: string; loops?: number[][][] };
type Level = { y: number; height?: number; image?: string; bounds?: number[] };
type Visit = { sid: string; dur: number; path: [number, number, number, number][] };
type Props = { angle: number; levels: Level[]; rooms: Room[]; walk: [string, number][]; look: [string, number][]; visits: Visit[]; imageBase: string | null; replay: string | null; labels: Record<string, { level: string; playing: string; of: string; noRoute: string }> };

const CELL = 0.25;
const RAMPS: Record<string, number[][]> = {
  walk: [[246, 214, 138], [240, 140, 60], [240, 80, 60], [212, 34, 74]],
  look: [[143, 227, 255], [90, 170, 255], [106, 92, 255], [190, 70, 255]],
};
const ramp = (name: string, t: number) => {
  const st = RAMPS[name]; t = Math.max(0, Math.min(1, t)) * (st.length - 1);
  const i = Math.min(st.length - 2, Math.floor(t)), f = t - i;
  return st[i].map((c, k) => Math.round(c + (st[i + 1][k] - c) * f));
};
const scaleOf = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return v.length ? Math.max(1e-6, v[Math.floor(v.length * 0.95)]) : 1; };
const toPlan = (a: number, x: number, z: number) => [Math.cos(a) * x - Math.sin(a) * z, Math.sin(a) * x + Math.cos(a) * z];
const fmtDur = (s: number) => { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };

// Outline loops of a union of axis-aligned rectangles [u0, v0, u1, v1].
function unionOutline(rects: number[][]) {
  rects = rects.filter((r) => r[2] > r[0] && r[3] > r[1]);
  if (!rects.length) return [];
  const us = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  const vs = [...new Set(rects.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
  const W = us.length - 1, H = vs.length - 1;
  const cell: boolean[][] = [];
  for (let i = 0; i < W; i++) { cell.push([]); for (let j = 0; j < H; j++) { const cu = (us[i] + us[i + 1]) / 2, cv = (vs[j] + vs[j + 1]) / 2; cell[i].push(rects.some((r) => cu > r[0] && cu < r[2] && cv > r[1] && cv < r[3])); } }
  const isIn = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && cell[i][j];
  const edges = new Map<string, number[][]>();
  const add = (a: number[], b: number[]) => { const k = a.join(); if (!edges.has(k)) edges.set(k, []); edges.get(k)!.push(b); };
  for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
    if (!cell[i][j]) continue;
    if (!isIn(i, j - 1)) add([i, j], [i + 1, j]);
    if (!isIn(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
    if (!isIn(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
    if (!isIn(i - 1, j)) add([i, j + 1], [i, j]);
  }
  const loops: number[][][] = [];
  while (edges.size) {
    const k0 = edges.keys().next().value as string;
    let cur = k0.split(',').map(Number);
    const loop: number[][] = [];
    for (let guard = 0; guard < 100000; guard++) {
      const k = cur.join(), outs = edges.get(k);
      if (!outs) break;
      const nxt = outs.pop()!;
      if (!outs.length) edges.delete(k);
      loop.push(cur); cur = nxt;
      if (cur.join() === k0 && !edges.has(k0)) break;
    }
    const pts = loop.map(([i, j]) => [us[i], vs[j]]);
    const out = pts.filter((p, n) => { const a = pts[(n - 1 + pts.length) % pts.length], b = pts[(n + 1) % pts.length]; return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1])); });
    if (out.length >= 3) loops.push(out);
  }
  const area = (l: number[][]) => l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  if (loops.length > 1) { const sign = Math.sign(area(loops.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a)))); return loops.filter((l) => Math.sign(area(l)) === sign); }
  return loops;
}
// Rooms are drawn a little apart, so a wall shows between neighbours.
function tightenRooms(rooms: Room[], wall = 0.12, reach = 0.7, sameReach = 1.5): Room[] {
  const out = rooms.map((r) => ({ ...r, rects: (r.rects || []).map((q) => [...q]) }));
  const items: { r: Room; q: number[]; o: number[] }[] = [];
  out.forEach((r, n) => { if (r.kind !== 'stairs') r.rects.forEach((q, k) => items.push({ r, q, o: [...rooms[n].rects[k]] })); });
  const EDGES = [[2, 0, 1, 1, 3], [0, 2, -1, 1, 3], [3, 1, 1, 0, 2], [1, 3, -1, 0, 2]];
  for (const A of items) for (const [e, f, sgn, s0, s1] of EDGES) {
    let best: { g: number; w: number } | null = null;
    for (const B of items) {
      if (B === A || B.r.level !== A.r.level) continue;
      const g = sgn * (B.o[f] - A.o[e]), overlap = Math.min(A.o[s1], B.o[s1]) - Math.max(A.o[s0], B.o[s0]), same = B.r === A.r;
      if (overlap < 0.25 || g < -1e-6 || g > (same ? sameReach : reach)) continue;
      const w = same ? 0 : wall;
      if (!best || g < best.g) best = { g, w };
    }
    if (best && best.g > best.w + 1e-4) A.q[e] = +(A.o[e] + (sgn * (best.g - best.w)) / 2).toFixed(3);
  }
  return out;
}

function mount(root: HTMLElement) {
  if (root.dataset.mounted) return; root.dataset.mounted = '1';
  const p: Props = JSON.parse(root.querySelector('script[type="application/json"]')!.textContent!);
  const L = p.labels[document.documentElement.lang === 'sv' ? 'sv' : 'en'];
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const bg = $<HTMLCanvasElement>('.z-tplan-bg'), hc = $<HTMLCanvasElement>('.z-tplan-heat'), top = $<HTMLCanvasElement>('.z-tplan-top');
  const rooms = tightenRooms(p.rooms).map((r) => ({ ...r, loops: unionOutline(r.rects || []) }));
  const walk = new Map(p.walk), look = new Map(p.look);
  const layers: Record<string, boolean> = { walk: true, look: true, path: !!p.replay };
  let level = 0, view = { a: 0, s: 1, ox: 0, oy: 0 };
  const css = () => { const s = getComputedStyle(root); return { text: s.color, dark: document.documentElement.classList.contains('theme-dark') }; };

  const fitView = (w: number, h: number) => {
    const a = p.angle || 0;
    let pts: number[][] = [];
    for (const r of rooms) if (r.level === level) for (const q of r.rects) pts.push([q[0], q[1]], [q[2], q[3]]);
    if (!pts.length) for (const k of walk.keys()) { const [li, ix, iz] = k.split(':').map(Number); if (li === level) pts.push(toPlan(a, (ix + 0.5) * CELL, (iz + 0.5) * CELL)); }
    if (!pts.length) pts = [[-5, -5], [5, 5]];
    const u0 = Math.min(...pts.map((q) => q[0])) - 1, u1 = Math.max(...pts.map((q) => q[0])) + 1;
    const v0 = Math.min(...pts.map((q) => q[1])) - 1, v1 = Math.max(...pts.map((q) => q[1])) + 1;
    const s = Math.min(w / (u1 - u0), h / (v1 - v0));
    return { a, s, ox: w / 2 - (s * (u0 + u1)) / 2, oy: h / 2 - (s * (v0 + v1)) / 2 };
  };
  const toScreen = (x: number, z: number) => { const [u, v] = toPlan(view.a, x, z); return [view.ox + u * view.s, view.oy + v * view.s]; };
  const sizeCanvas = (c: HTMLCanvasElement) => {
    const dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    return ctx;
  };
  const imgs: Record<string, HTMLImageElement> = {};
  const planImage = (file?: string) => {
    if (!file || !p.imageBase) return null;
    if (!imgs[file]) { const im = new Image(); im.onload = () => draw(); im.src = `${p.imageBase}/${file}`; imgs[file] = im; }
    return imgs[file];
  };

  function draw() {
    const w = bg.clientWidth, h = bg.clientHeight; if (!w || !h) return;
    const { text, dark } = css();
    view = fitView(w, h);
    const ctx = sizeCanvas(bg);
    const lv = p.levels[level];
    const im = lv && planImage(lv.image);
    if (im && im.complete && im.naturalWidth && lv.bounds) {
      const [b0, b1, b2, b3] = lv.bounds;
      ctx.globalAlpha = dark ? 0.3 : 0.5;
      ctx.drawImage(im, view.ox + b0 * view.s, view.oy + b1 * view.s, (b2 - b0) * view.s, (b3 - b1) * view.s);
      ctx.globalAlpha = 1;
    }
    ctx.lineJoin = 'round';
    for (const r of rooms) {
      if (r.level !== level) continue;
      ctx.beginPath();
      for (const loop of r.loops!) { loop.forEach(([u, v], i) => { const x = view.ox + u * view.s, y = view.oy + v * view.s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
      ctx.globalAlpha = 0.06; ctx.fillStyle = text; ctx.fill();
      ctx.globalAlpha = 0.5; ctx.strokeStyle = text; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
    }
    const hctx = sizeCanvas(hc);
    const lvY = lv ? [lv.y - 0.3, lv.y + (lv.height || 2.5) + 0.3] : [-1e9, 1e9];
    const blobs = (entries: number[][], name: string, strength = 0.55) => {
      if (!entries.length) return;
      const max = scaleOf(entries.map((e) => e[2]));
      const off = document.createElement('canvas'); off.width = hc.width; off.height = hc.height;
      const o = off.getContext('2d')!; const dpr = hc.width / w; o.setTransform(dpr, 0, 0, dpr, 0, 0);
      const r = Math.max(6, view.s * CELL * 1.6);
      for (const [x, z, v] of entries) {
        const [sx, sy] = toScreen(x, z);
        const g = o.createRadialGradient(sx, sy, 0, sx, sy, r), a = Math.min(1, v / max) * strength;
        g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        o.fillStyle = g; o.fillRect(sx - r, sy - r, 2 * r, 2 * r);
      }
      const img = o.getImageData(0, 0, off.width, off.height), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const t = d[i + 3] / 255; if (!t) continue;
        const [cr, cg, cb] = ramp(name, Math.min(1, t * 1.25));
        d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = Math.min(255, t * 1.6 * 255) * 0.9;
      }
      o.putImageData(img, 0, 0);
      hctx.save(); hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.drawImage(off, 0, 0); hctx.restore();
    };
    if (layers.look) {
      const e: number[][] = [];
      for (const [k, v] of look) { const [ix, iy, iz] = k.split(':').map(Number), y = (iy + 0.5) * CELL; if (y >= lvY[0] && y <= lvY[1]) e.push([(ix + 0.5) * CELL, (iz + 0.5) * CELL, v]); }
      blobs(e, 'look', 0.32);
    }
    if (layers.walk) {
      const e: number[][] = [];
      for (const [k, v] of walk) { const [li, ix, iz] = k.split(':').map(Number); if (li === level) e.push([(ix + 0.5) * CELL, (iz + 0.5) * CELL, v]); }
      blobs(e, 'walk');
    }
    if (layers.path) {
      hctx.lineWidth = 1.2; hctx.globalAlpha = 0.28; hctx.strokeStyle = text; hctx.lineJoin = 'round';
      for (const v of p.visits) {
        hctx.beginPath(); let on = false;
        for (const [, x, z, li] of v.path) { if (li !== level) { on = false; continue; } const [sx, sy] = toScreen(x, z); on ? hctx.lineTo(sx, sy) : hctx.moveTo(sx, sy); on = true; }
        hctx.stroke();
      }
      hctx.globalAlpha = 1;
    }
    hctx.font = '500 12px Inter, system-ui, sans-serif'; hctx.textAlign = 'center'; hctx.textBaseline = 'middle';
    for (const r of rooms) {
      if (r.level !== level || !r.rects.length) continue;
      const big = [...r.rects].sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0];
      const x = view.ox + ((big[0] + big[2]) / 2) * view.s, y = view.oy + ((big[1] + big[3]) / 2) * view.s;
      const tw = hctx.measureText(r.name).width + 14;
      hctx.fillStyle = 'rgba(13,13,14,.78)'; hctx.beginPath(); (hctx as any).roundRect ? (hctx as any).roundRect(x - tw / 2, y - 10, tw, 20, 10) : hctx.rect(x - tw / 2, y - 10, tw, 20); hctx.fill();
      hctx.fillStyle = '#f4f1ec'; hctx.fillText(r.name, x, y + 0.5);
    }
  }

  // Levels
  const levelsEl = root.querySelector<HTMLElement>('.z-tplan-levels');
  const renderLevels = () => {
    if (levelsEl) {
      levelsEl.hidden = p.levels.length < 2;
      levelsEl.innerHTML = p.levels.map((_, i) => `<a href="#" role="button" data-level="${i}" aria-current="${i === level}">${L.level} ${i + 1}</a>`).join('');
    }
    draw();
  };
  levelsEl?.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-level]'); if (!b) return; e.preventDefault(); level = Number(b.dataset.level); renderLevels(); });
  root.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((c) => { c.checked = !!layers[c.dataset.layer!]; c.addEventListener('change', () => { layers[c.dataset.layer!] = c.checked; draw(); }); });

  // Replay one visit
  let raf = 0;
  const bar = root.querySelector<HTMLElement>('.z-tplan-replay'), barText = root.querySelector<HTMLElement>('.z-tplan-replay-text');
  const stop = () => { cancelAnimationFrame(raf); raf = 0; if (bar) bar.hidden = true; sizeCanvas(top); };
  root.querySelector('.z-tplan-replay-stop')?.addEventListener('click', (e) => { e.preventDefault(); stop(); });
  const replay = (v: Visit) => {
    cancelAnimationFrame(raf);
    if (!v.path.length) { if (bar && barText) { bar.hidden = false; barText.textContent = L.noRoute; } return; }
    if (bar) bar.hidden = false;
    const t0 = performance.now(), speed = 8, total = v.path[v.path.length - 1][0];
    const step = (now: number) => {
      const t = ((now - t0) / 1000) * speed;
      let i = v.path.findIndex((q) => q[0] > t); if (i < 0) i = v.path.length;
      const cur = v.path[Math.max(0, i - 1)];
      if (cur[3] !== level) { level = cur[3]; renderLevels(); }
      if (barText) barText.textContent = `${L.playing} · ${fmtDur(Math.min(t, total))} ${L.of} ${fmtDur(v.dur)}`;
      const ctx = sizeCanvas(top), { text } = css();
      ctx.lineWidth = 2.5; ctx.strokeStyle = text; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); let on = false;
      for (const [, x, z, li] of v.path.slice(0, i)) { if (li !== level) { on = false; continue; } const [sx, sy] = toScreen(x, z); on ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); on = true; }
      ctx.stroke();
      if (cur[3] === level) { const [sx, sy] = toScreen(cur[1], cur[2]); ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(13,13,14,.85)'; ctx.stroke(); }
      if (t < total + 1.5) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  root.querySelector('.z-tplan-replay-again')?.addEventListener('click', (e) => { e.preventDefault(); const v = p.visits.find((x) => x.sid === p.replay); if (v) replay(v); });

  new ResizeObserver(() => draw()).observe(root);
  new MutationObserver(() => draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  renderLevels();
  if (p.replay) { const v = p.visits.find((x) => x.sid === p.replay); if (v) { if (v.path[0]) level = v.path[0][3]; renderLevels(); replay(v); } }
}
document.querySelectorAll<HTMLElement>('[data-tour-plan]').forEach(mount);
