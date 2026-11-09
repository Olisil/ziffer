// SEO, AEO (answer-engine optimisation) and technical audits of single pages.
//
// Pages are fetched the way search and AI crawlers see them: plain HTML, no JavaScript. Every check has a
// weight, a status, what was found, why it matters and how to fix it, so a score can always be explained.
import { parse, type HTMLElement } from 'node-html-parser';
import { db, id } from './server';
import { bucket } from './snapshots';

export type Status = 'pass' | 'warn' | 'fail' | 'info';
export type Category = 'seo' | 'aeo' | 'tech';
export type Check = { id: string; cat: Category; title: string; weight: number; status: Status; found: string; why: string; fix: string; scope: 'page' | 'site' };
export type AuditRow = {
  id: string; env_id: string; path: string; status: 'pending' | 'done' | 'error'; trigger: string; queued: number; ran_at: number | null;
  version_id: string | null; seo: number | null; aeo: number | null; tech: number | null; overall: number | null;
  url: string | null; http_status: number | null; fetch_ms: number | null; bytes: number | null; results: string | null; error: string | null;
};

const UA = 'Mozilla/5.0 (compatible; ZifferAudit/1.0; +https://ziffer.webflow.io/app)';
const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'CCBot', 'Applebot-Extended'];
const QUESTION = /\?\s*$|^(how|what|why|when|where|who|which|can|does|do|is|are|should|vad|hur|varför|när|var|vem|vilken|vilka|kan|är|ska|wie|was|warum|wann|wo|wer)\b/i;

/* ---------------- Queue ---------------- */

export async function queueAudit(envId: string, path: string, trigger: string, versionId: string | null = null) {
  const DB = db();
  if (trigger === 'first') {
    const any = await DB.prepare('SELECT 1 FROM audits WHERE env_id = ? AND path = ? LIMIT 1').bind(envId, path).first();
    if (any) return null;
  }
  const pending = await DB.prepare("SELECT id FROM audits WHERE env_id = ? AND path = ? AND status = 'pending'").bind(envId, path).first<{ id: string }>();
  if (pending) {
    if (trigger !== 'first') await DB.prepare('UPDATE audits SET trigger = ?, version_id = COALESCE(?, version_id) WHERE id = ?').bind(trigger, versionId, pending.id).run();
    return pending.id;
  }
  const aid = id(10);
  await DB.prepare('INSERT INTO audits (id, env_id, path, status, trigger, queued, version_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(aid, envId, path, 'pending', trigger, Date.now(), versionId).run();
  return aid;
}

/** Run up to `max` waiting audits (for one environment, or any). Returns how many ran. */
export async function runPendingAudits(envId: string | null, max = 1) {
  const DB = db();
  const rows = (envId
    ? await DB.prepare("SELECT * FROM audits WHERE status = 'pending' AND env_id = ? ORDER BY queued LIMIT ?").bind(envId, max).all<AuditRow>()
    : await DB.prepare("SELECT * FROM audits WHERE status = 'pending' ORDER BY queued LIMIT ?").bind(max).all<AuditRow>()).results;
  for (const a of rows) {
    // Claim it so two requests don't run the same audit.
    const claimed = await DB.prepare("UPDATE audits SET status = 'running', ran_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), a.id).run();
    if (!claimed.meta.changes) continue;
    await runAudit(a).catch(async (e) => {
      await DB.prepare("UPDATE audits SET status = 'error', ran_at = ?, error = ? WHERE id = ?").bind(Date.now(), String(e?.message || e).slice(0, 300), a.id).run();
    });
  }
  // Audits stuck in 'running' (worker stopped mid-way) go back in the queue.
  await DB.prepare("UPDATE audits SET status = 'pending', ran_at = NULL WHERE status = 'running' AND ran_at < ?").bind(Date.now() - 10 * 60e3).run();
  return rows.length;
}

/* ---------------- Fetching ---------------- */

async function get(url: string, ms = 12000, maxBytes = 3_000_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: ctl.signal });
    const buf = await r.arrayBuffer();
    const text = new TextDecoder().decode(buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf);
    return { ok: r.ok, status: r.status, url: r.url || url, headers: r.headers, text, bytes: buf.byteLength, ms: Date.now() - t0, redirected: r.redirected };
  } finally { clearTimeout(timer); }
}

type SiteFiles = { robots: string | null; sitemapPaths: Set<string> | null; sitemapUrl: string | null; llms: boolean; fetched: number };
const siteCache = new Map<string, SiteFiles>();

const normPath = (p: string) => { try { const x = decodeURI(p); return x.length > 1 ? x.replace(/\/+$/, '') : x; } catch { return p; } };

async function siteFiles(origin: string): Promise<SiteFiles> {
  const hit = siteCache.get(origin);
  if (hit && Date.now() - hit.fetched < 30 * 60e3) return hit;
  const robotsRes = await get(`${origin}/robots.txt`, 8000, 200_000).catch(() => null);
  const robots = robotsRes?.ok && !/<html/i.test(robotsRes.text.slice(0, 300)) ? robotsRes.text : null;
  const declared = robots?.match(/^\s*sitemap:\s*(\S+)/gim)?.map((l) => l.replace(/^\s*sitemap:\s*/i, '').trim()) ?? [];
  const candidates = declared.length ? declared.slice(0, 3) : [`${origin}/sitemap.xml`];
  let paths: Set<string> | null = null, sitemapUrl: string | null = null;
  for (const sm of candidates) {
    const r = await get(sm, 8000, 5_000_000).catch(() => null);
    if (!r?.ok || !/<(urlset|sitemapindex)/i.test(r.text)) continue;
    sitemapUrl = sm;
    paths ??= new Set();
    const locs = (t: string) => [...t.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex/i.test(r.text)) {
      for (const child of locs(r.text).slice(0, 5)) {
        const c = await get(child, 8000, 5_000_000).catch(() => null);
        if (c?.ok) for (const u of locs(c.text)) { try { paths.add(normPath(new URL(u).pathname)); } catch {} }
      }
    } else for (const u of locs(r.text)) { try { paths.add(normPath(new URL(u).pathname)); } catch {} }
  }
  const llmsRes = await get(`${origin}/llms.txt`, 6000, 200_000).catch(() => null);
  const llms = !!llmsRes?.ok && llmsRes.text.trim().length > 20 && !/<html/i.test(llmsRes.text.slice(0, 300));
  const files = { robots, sitemapPaths: paths, sitemapUrl, llms, fetched: Date.now() };
  siteCache.set(origin, files);
  return files;
}

/** Is `path` disallowed for `agent` by robots.txt? Longest matching rule wins; Allow beats Disallow on ties. */
export function robotsBlocks(robots: string | null, agent: string, path: string) {
  if (!robots) return false;
  type Group = { agents: string[]; rules: { allow: boolean; p: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null, lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (k === 'allow' || k === 'disallow') && v) cur.rules.push({ allow: k === 'allow', p: v });
    }
  }
  const a = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((x) => x !== '*' && a.includes(x))) ?? groups.find((g) => g.agents.includes('*'));
  if (!group) return false;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    const re = new RegExp('^' + r.p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.p.length > best.len || (r.p.length === best.len && r.allow))) best = { allow: r.allow, len: r.p.length };
  }
  return !!best && !best.allow;
}

/* ---------------- Analysis ---------------- */

const words = (t: string) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
const visibleText = (root: HTMLElement) => {
  const copy = parse(root.toString());
  copy.querySelectorAll('script, style, noscript, template, svg, iframe').forEach((n) => n.remove());
  return clean((copy.querySelector('body') ?? copy).textContent || '');
};
const short = (t: string, n = 90) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

function schemaTypes(nodes: unknown[]): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = n['@type'];
    if (typeof t === 'string') out.push(t); else if (Array.isArray(t)) out.push(...t.filter((x) => typeof x === 'string'));
    if (n['@graph']) walk(n['@graph']);
    for (const k of ['mainEntity', 'author', 'publisher', 'itemListElement', 'about']) if (n[k]) walk(n[k]);
  };
  nodes.forEach(walk);
  return [...new Set(out)];
}

export function analyse(input: {
  html: string; url: string; path: string; status: number; ms: number; bytes: number; headers: Headers; redirected: boolean;
  site: SiteFiles; renderedWords: number | null; otherTitles: Map<string, string>;
}): Check[] {
  const { html, url, path, site } = input;
  const root = parse(html, { comment: false, blockTextElements: { script: true, noscript: false, style: false, pre: true } });
  const head = root.querySelector('head') ?? root;
  const meta = (sel: string) => clean(root.querySelector(sel)?.getAttribute('content') || '');
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const title = clean(head.querySelector('title')?.textContent || '');
  const desc = meta('meta[name="description"]');
  const h = root.querySelectorAll('h1, h2, h3, h4, h5, h6').filter((e) => !e.closest('header, nav, footer, [role=navigation], [role=contentinfo]')).map((e) => ({ lvl: Number(e.tagName[1]), text: clean(e.textContent || ''), el: e }));
  const h1s = h.filter((x) => x.lvl === 1);
  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
  const robotsMeta = meta('meta[name="robots"]').toLowerCase();
  const xRobots = (input.headers.get('x-robots-tag') || '').toLowerCase();
  const lang = root.querySelector('html')?.getAttribute('lang') || '';
  const imgs = root.querySelectorAll('img');
  const altOk = imgs.filter((i) => i.hasAttribute('alt')).length;
  const ldRaw = root.querySelectorAll('script[type="application/ld+json"]').map((s) => s.textContent || s.rawText || '');
  const ld: unknown[] = []; let ldBroken = 0;
  for (const raw of ldRaw) { try { ld.push(JSON.parse(raw)); } catch { ldBroken++; } }
  const types = schemaTypes(ld);
  const body = visibleText(root);
  const wc = words(body);
  const host = new URL(url).host;
  const links = root.querySelectorAll('a[href]').map((a) => a.getAttribute('href') || '');
  const internal = links.filter((l) => { try { const u = new URL(l, url); return u.host === host && !l.startsWith('#'); } catch { return false; } });
  const ogTitle = meta('meta[property="og:title"]'), ogImage = meta('meta[property="og:image"]');
  const viewport = root.querySelector('meta[name="viewport"]');

  /* ----- SEO ----- */
  const tl = title.length;
  add({ id: 'seo.title', cat: 'seo', scope: 'page', title: 'Page title', weight: 10,
    status: !tl ? 'fail' : tl >= 30 && tl <= 65 ? 'pass' : tl >= 15 && tl <= 75 ? 'warn' : 'fail',
    found: tl ? `“${short(title)}” (${tl} characters)` : 'No <title>',
    why: 'The title is the blue link in search results and the label AI answers use when they cite a page. 30–65 characters fit without being cut.',
    fix: 'In Webflow: Page settings → SEO settings → Title tag. Lead with what the page is about, end with the brand.' });
  const dup = [...input.otherTitles.entries()].filter(([p, t]) => p !== path && t && t === title).map(([p]) => p);
  if (title) add({ id: 'seo.title-unique', cat: 'seo', scope: 'site', title: 'Unique title', weight: 4, status: dup.length ? 'warn' : 'pass',
    found: dup.length ? `Same title as ${dup.slice(0, 3).join(', ')}${dup.length > 3 ? '…' : ''}` : 'No other audited page shares this title',
    why: 'Pages with the same title compete with each other, and search engines may pick the wrong one.', fix: 'Give each page a title that says what is specific about it.' });
  const dl = desc.length;
  add({ id: 'seo.description', cat: 'seo', scope: 'page', title: 'Meta description', weight: 6,
    status: !dl ? 'fail' : dl >= 70 && dl <= 160 ? 'pass' : 'warn',
    found: dl ? `${dl} characters: “${short(desc, 120)}”` : 'Missing',
    why: 'Shown under the title in results and often used as the summary in link previews. 70–160 characters reads well.',
    fix: 'In Webflow: Page settings → SEO settings → Meta description. One or two sentences that answer “what will I get here?”.' });
  add({ id: 'seo.h1', cat: 'seo', scope: 'page', title: 'One main heading (H1)', weight: 8,
    status: h1s.length === 1 ? 'pass' : h1s.length > 1 ? 'warn' : 'fail',
    found: h1s.length ? h1s.map((x) => `“${short(x.text, 60)}”`).join(', ') : 'No H1 on the page',
    why: 'The H1 tells crawlers and screen readers what the page is about. More than one blurs the topic.',
    fix: 'In Webflow, select the main heading and set its tag to H1 in the settings panel; make other big headings H2.' });
  let skip = '';
  for (let i = 1; i < h.length; i++) if (h[i].lvl > h[i - 1].lvl + 1) { skip = `H${h[i - 1].lvl} → H${h[i].lvl} at “${short(h[i].text, 40)}”`; break; }
  add({ id: 'seo.headings', cat: 'seo', scope: 'page', title: 'Heading order', weight: 3, status: skip ? 'warn' : h.length ? 'pass' : 'warn',
    found: skip ? `Skips a level: ${skip}` : h.length ? `${h.length} headings in order` : 'No headings',
    why: 'Headings form the outline that search engines and answer engines read. Skipped levels make the outline ambiguous.',
    fix: 'Use H2 for sections and H3 inside them; choose the size with classes, not the heading level.' });
  let canonStatus: Status = 'warn', canonFound = 'Missing';
  if (canonical) {
    try {
      const cu = new URL(canonical, url);
      const same = cu.host === host && normPath(cu.pathname) === normPath(new URL(url).pathname);
      canonStatus = same ? 'pass' : 'warn';
      canonFound = same ? `Points to itself (${cu.href})` : `Points elsewhere: ${cu.href}`;
    } catch { canonStatus = 'fail'; canonFound = `Invalid: ${canonical}`; }
  }
  add({ id: 'seo.canonical', cat: 'seo', scope: 'page', title: 'Canonical URL', weight: 4, status: canonStatus, found: canonFound,
    why: 'Tells search engines which address is the real one when the same page is reachable in several ways (www, slashes, parameters).',
    fix: 'In Webflow: Site settings → SEO → Global canonical tag URL (for example https://www.yourdomain.se).' });
  const noindex = /noindex/.test(robotsMeta) || /noindex/.test(xRobots);
  const blockedG = robotsBlocks(site.robots, 'Googlebot', new URL(url).pathname);
  add({ id: 'seo.indexable', cat: 'seo', scope: 'page', title: 'Allowed in search results', weight: 12,
    status: noindex || blockedG ? 'fail' : 'pass',
    found: noindex ? `noindex in ${/noindex/.test(robotsMeta) ? 'meta robots' : 'X-Robots-Tag header'}` : blockedG ? 'Blocked for Googlebot in robots.txt' : 'Indexable',
    why: 'A page that is excluded can’t be found in search or used as a source by AI answers.',
    fix: noindex ? 'Remove the noindex (Webflow: Page settings → SEO → “Exclude from search results”).' : blockedG ? 'Remove the Disallow rule that matches this path in robots.txt (Webflow: Site settings → SEO).' : '—' });
  const altPct = imgs.length ? altOk / imgs.length : 1;
  add({ id: 'seo.alt', cat: 'seo', scope: 'page', title: 'Image descriptions (alt)', weight: 5,
    status: altPct >= 0.9 ? 'pass' : altPct >= 0.6 ? 'warn' : 'fail',
    found: imgs.length ? `${altOk} of ${imgs.length} images have alt text` : 'No images',
    why: 'Alt text is how images are understood by image search, AI and screen readers. Decorative images may have empty alt.',
    fix: 'In Webflow: select the image → settings → Alt text (or mark it decorative). For CMS images, bind alt to a field.' });
  add({ id: 'seo.content', cat: 'seo', scope: 'page', title: 'Amount of text', weight: 6,
    status: wc >= 300 ? 'pass' : wc >= 120 ? 'warn' : 'fail', found: `${wc} words in the HTML`,
    why: 'Pages with little text give search engines and AI little to understand, rank or quote.',
    fix: 'Add a short introduction and descriptive sections; describe images and projects in words.' });
  add({ id: 'seo.links', cat: 'seo', scope: 'page', title: 'Internal links', weight: 3, status: internal.length >= 3 ? 'pass' : 'warn',
    found: `${internal.length} links to other pages on ${host}`, why: 'Internal links help crawlers find pages and understand how they relate.',
    fix: 'Link to related pages from the body text, not only from the menu.' });
  add({ id: 'seo.lang', cat: 'seo', scope: 'site', title: 'Language set', weight: 3, status: lang ? 'pass' : 'warn', found: lang ? `lang="${lang}"` : 'No lang on <html>',
    why: 'Lets search engines show the page to people searching in that language and helps screen readers pronounce it.',
    fix: 'In Webflow: Site settings → Localization → primary locale, or set the lang attribute in the page’s custom code.' });
  add({ id: 'seo.social', cat: 'seo', scope: 'page', title: 'Share preview (Open Graph)', weight: 3,
    status: ogTitle && ogImage ? 'pass' : ogTitle || ogImage ? 'warn' : 'fail',
    found: [ogTitle ? 'og:title ✓' : 'og:title missing', ogImage ? 'og:image ✓' : 'og:image missing'].join(' · '),
    why: 'Controls how the page looks when shared on LinkedIn, Slack, Messages and in some AI tools.', fix: 'In Webflow: Page settings → Open Graph settings, add a title and a 1200×630 image.' });
  const p = new URL(url).pathname;
  const urlIssues = [p !== p.toLowerCase() && 'capital letters', /[_\s%]/.test(p) && 'underscores, spaces or encoded characters', p.length > 90 && 'longer than 90 characters'].filter(Boolean);
  add({ id: 'seo.url', cat: 'seo', scope: 'page', title: 'Readable address', weight: 2, status: urlIssues.length ? 'warn' : 'pass', found: urlIssues.length ? `Has ${urlIssues.join(', ')}` : p,
    why: 'Short, lowercase addresses with hyphens are easier to read, share and trust.', fix: 'Change the slug in Page settings; Webflow can add a 301 redirect from the old address.' });
  const inMap = site.sitemapPaths ? site.sitemapPaths.has(normPath(new URL(url).pathname)) : null;
  add({ id: 'seo.sitemap', cat: 'seo', scope: 'site', title: 'Listed in sitemap', weight: 4, status: inMap ? 'pass' : inMap === false ? 'warn' : 'fail',
    found: site.sitemapUrl ? (inMap ? `Listed in ${site.sitemapUrl}` : `Not in ${site.sitemapUrl}`) : 'No sitemap found',
    why: 'The sitemap is the list of pages you want found; pages missing from it are discovered slower.',
    fix: 'In Webflow: Site settings → SEO → Auto-generate sitemap. Check the page isn’t excluded from search.' });

  /* ----- AEO ----- */
  const rw = input.renderedWords;
  const ratio = rw && rw > 30 ? Math.min(1, wc / rw) : null;
  add({ id: 'aeo.no-js', cat: 'aeo', scope: 'page', title: 'Readable without JavaScript', weight: 12,
    status: ratio === null ? (wc >= 150 ? 'pass' : 'warn') : ratio >= 0.8 ? 'pass' : ratio >= 0.5 ? 'warn' : 'fail',
    found: ratio === null ? `${wc} words in the raw HTML (no page picture to compare with yet)` : `${Math.round(ratio * 100)}% of the text visitors see is in the HTML (${wc} of ~${rw} words)`,
    why: 'Most AI crawlers (ChatGPT, Claude, Perplexity) read the HTML without running scripts. Text that only appears through JavaScript is invisible to them.',
    fix: 'Keep important text in static Webflow elements or CMS fields instead of text injected by scripts, embeds or client-side widgets.' });
  const rich = types.filter((t) => /Organization|LocalBusiness|Person|WebSite|Article|BlogPosting|NewsArticle|Product|Service|FAQPage|HowTo|BreadcrumbList|Event|Recipe|SoftwareApplication|CreativeWork|Offer/i.test(t));
  add({ id: 'aeo.schema', cat: 'aeo', scope: 'page', title: 'Structured data (schema.org)', weight: 10,
    status: ldBroken ? 'fail' : rich.length ? 'pass' : types.length ? 'warn' : 'fail',
    found: ldBroken ? `${ldBroken} JSON-LD block${ldBroken > 1 ? 's' : ''} can’t be read (invalid JSON)` : types.length ? `Types: ${types.join(', ')}` : 'No JSON-LD',
    why: 'Structured data states facts — who you are, what the page offers, prices, dates — in a form answer engines and Google can quote reliably.',
    fix: 'Add JSON-LD in Page settings → Custom code (or the CMS template). Start with Organization + WebSite on the home page, Article/Service/Product on others.' });
  const qHeads = h.filter((x) => x.lvl >= 2 && QUESTION.test(x.text));
  const faqSchema = types.some((t) => /FAQPage|QAPage/i.test(t));
  add({ id: 'aeo.questions', cat: 'aeo', scope: 'page', title: 'Answers real questions', weight: 6,
    status: faqSchema || qHeads.length >= 2 ? 'pass' : qHeads.length === 1 ? 'warn' : 'warn',
    found: faqSchema ? 'FAQPage structured data' : qHeads.length ? `${qHeads.length} question headings, e.g. “${short(qHeads[0].text, 60)}”` : 'No headings phrased as questions',
    why: 'People ask AI assistants questions. Headings that match those questions, followed by direct answers, are what answer engines pick up.',
    fix: 'Add a few headings phrased the way customers ask (“What does X cost?”, “Hur lång tid tar …?”) with a short answer right below.' });
  const sections = h.filter((x) => x.lvl === 2 || x.lvl === 3);
  let answered = 0;
  for (const s of sections) {
    let n = s.el.nextElementSibling, tries = 0, ok = false;
    while (n && tries < 3 && !/^H[1-6]$/.test(n.tagName)) {
      const w = words(clean(n.textContent || ''));
      if (w >= 15 && w <= 120) { ok = true; break; }
      n = n.nextElementSibling; tries++;
    }
    if (ok) answered++;
  }
  const ansPct = sections.length ? answered / sections.length : 0;
  add({ id: 'aeo.answers', cat: 'aeo', scope: 'page', title: 'Short answer under each heading', weight: 6,
    status: !sections.length ? 'warn' : ansPct >= 0.5 ? 'pass' : ansPct >= 0.25 ? 'warn' : 'fail',
    found: sections.length ? `${answered} of ${sections.length} sections start with a 15–120 word paragraph` : 'No H2/H3 sections',
    why: 'Answer engines quote compact passages. A clear paragraph directly under a heading is easy to lift as an answer.',
    fix: 'Start each section with one or two plain sentences that answer the heading before details, images or lists.' });
  const lists = root.querySelectorAll('ul, ol').filter((l) => l.querySelectorAll('li').length >= 3 && !l.closest('nav, header, footer')).length;
  const tables = root.querySelectorAll('table').length;
  add({ id: 'aeo.structure', cat: 'aeo', scope: 'page', title: 'Lists and tables', weight: 3, status: lists || tables ? 'pass' : 'warn',
    found: `${lists} content lists, ${tables} tables`, why: 'Steps, features and comparisons in lists or tables are easy for AI to extract correctly.',
    fix: 'Use real list and table elements (Webflow List, Rich Text lists or a Table embed) for steps, specs and comparisons.' });
  const blockedBots = AI_BOTS.filter((b) => robotsBlocks(site.robots, b, new URL(url).pathname));
  add({ id: 'aeo.crawlers', cat: 'aeo', scope: 'site', title: 'AI crawlers allowed', weight: 8,
    status: !blockedBots.length ? 'pass' : blockedBots.length < AI_BOTS.length ? 'warn' : 'fail',
    found: blockedBots.length ? `Blocked in robots.txt: ${blockedBots.join(', ')}` : site.robots ? 'No AI crawler is blocked' : 'No robots.txt (everything allowed)',
    why: 'Blocked crawlers can’t read the page, so it won’t be used or cited in that assistant’s answers. Blocking can be a deliberate choice.',
    fix: 'If you want to appear in AI answers, remove Disallow rules for these user agents in robots.txt (Webflow: Site settings → SEO → robots.txt).' });
  add({ id: 'aeo.llms', cat: 'aeo', scope: 'site', title: 'llms.txt guide', weight: 2, status: site.llms ? 'pass' : 'warn',
    found: site.llms ? '/llms.txt found' : 'No /llms.txt',
    why: 'An emerging convention: a short Markdown file that tells language models what the site is and links to the key pages. Cheap to add, small effect today.',
    fix: 'Publish /llms.txt with a one-paragraph description and a list of your most important pages (Webflow can host it via a redirect to an asset or a page).' });
  const entity = types.some((t) => /Organization|LocalBusiness|Person|Corporation/i.test(t));
  const aboutLink = internal.some((l) => /about|om-oss|om_oss|omoss|kontakt|contact|team/i.test(l));
  add({ id: 'aeo.entity', cat: 'aeo', scope: 'site', title: 'Clear who is behind it', weight: 5,
    status: entity ? 'pass' : aboutLink ? 'warn' : 'fail',
    found: entity ? 'Organization/Person in structured data' : aboutLink ? 'About/contact page linked, but no Organization data' : 'No organisation data and no about/contact link',
    why: 'Answer engines prefer sources whose author or company is clear and consistent across the web (name, logo, address, profiles).',
    fix: 'Add Organization JSON-LD with name, logo, url and sameAs links (LinkedIn, Instagram) to the home page.' });
  const dated = types.length && /datePublished|dateModified/.test(ldRaw.join(' ')) || root.querySelector('time[datetime]') || meta('meta[property="article:modified_time"]');
  add({ id: 'aeo.fresh', cat: 'aeo', scope: 'page', title: 'Shows when it was updated', weight: 3, status: dated ? 'pass' : 'warn',
    found: dated ? 'Has a publish/update date' : 'No machine-readable date',
    why: 'Assistants favour content they can tell is current, especially for prices, services and news.',
    fix: 'Add dateModified to the page’s JSON-LD or a <time datetime> element; in CMS templates bind it to the Updated On field.' });
  const intro = root.querySelectorAll('main p, article p, p').map((x) => clean(x.textContent || '')).find((t) => words(t) >= 12) || '';
  add({ id: 'aeo.intro', cat: 'aeo', scope: 'page', title: 'Summary near the top', weight: 4,
    status: (desc && words(desc) >= 10) || words(intro) >= 25 ? 'pass' : 'warn',
    found: intro ? `First paragraph: “${short(intro, 110)}”` : 'No introductory paragraph found',
    why: 'A one-paragraph summary early on is what answer engines most often reuse to describe a page.',
    fix: 'Open the page with 2–3 sentences that say what it offers, for whom, and where.' });

  /* ----- Technical ----- */
  add({ id: 'tech.status', cat: 'tech', scope: 'page', title: 'Responds correctly', weight: 12,
    status: input.status >= 200 && input.status < 300 ? (input.redirected ? 'warn' : 'pass') : 'fail',
    found: `HTTP ${input.status}${input.redirected ? ` after a redirect to ${url}` : ''}`,
    why: 'Errors drop pages from search; redirects are fine but cost a round-trip and should point straight to the final address.',
    fix: input.redirected ? 'Link to the final address (for example with or without www) everywhere.' : 'Fix the error page or restore the page.' });
  add({ id: 'tech.https', cat: 'tech', scope: 'site', title: 'Secure connection (HTTPS)', weight: 8, status: url.startsWith('https://') ? 'pass' : 'fail', found: url.startsWith('https://') ? 'HTTPS' : 'Plain HTTP',
    why: 'Browsers flag HTTP pages as not secure and search engines rank them lower.', fix: 'In Webflow: Hosting → SSL, and redirect HTTP to HTTPS.' });
  add({ id: 'tech.speed', cat: 'tech', scope: 'page', title: 'Server response time', weight: 6, status: input.ms <= 800 ? 'pass' : input.ms <= 2000 ? 'warn' : 'fail',
    found: `${input.ms} ms to fetch the HTML (from Ziffer’s server)`, why: 'Slow responses delay everything else and crawlers visit fewer pages of slow sites.',
    fix: 'Webflow serves from a CDN; slow times usually come from heavy CMS pages or many embeds. Paginate long collection lists.' });
  const kb = Math.round(input.bytes / 1024);
  add({ id: 'tech.weight', cat: 'tech', scope: 'page', title: 'HTML size', weight: 4, status: kb <= 400 ? 'pass' : kb <= 1200 ? 'warn' : 'fail', found: `${kb} KB of HTML`,
    why: 'Very large HTML is slow on phones and crawlers may stop reading before the end.', fix: 'Remove hidden duplicate sections, large inline SVGs and embeds that inline lots of code.' });
  add({ id: 'tech.viewport', cat: 'tech', scope: 'site', title: 'Mobile-ready', weight: 6, status: viewport ? 'pass' : 'fail', found: viewport ? 'Viewport meta present' : 'No viewport meta',
    why: 'Without it, phones render the desktop layout zoomed out — and Google indexes the mobile version first.', fix: 'Webflow adds this automatically; check custom code doesn’t replace the <head>.' });
  add({ id: 'tech.robots', cat: 'tech', scope: 'site', title: 'robots.txt', weight: 3, status: site.robots ? 'pass' : 'warn', found: site.robots ? 'Found' : 'Missing (crawlers assume everything is allowed)',
    why: 'robots.txt tells crawlers what to skip and where the sitemap is.', fix: 'In Webflow: Site settings → SEO → robots.txt. At least: “User-agent: *”, “Allow: /” and a Sitemap line.' });
  add({ id: 'tech.schema-valid', cat: 'tech', scope: 'page', title: 'Valid structured data', weight: 3, status: ldBroken ? 'fail' : 'pass',
    found: ldBroken ? `${ldBroken} invalid JSON-LD block${ldBroken > 1 ? 's' : ''}` : ldRaw.length ? `${ldRaw.length} valid block${ldRaw.length > 1 ? 's' : ''}` : 'None to validate',
    why: 'Broken JSON-LD is ignored completely.', fix: 'Paste the block into validator.schema.org and fix the reported error (often a trailing comma or an unescaped quote).' });
  return checks;
}

export function scoreOf(checks: Check[], cat?: Category) {
  const list = checks.filter((c) => (!cat || c.cat === cat) && c.status !== 'info');
  const total = list.reduce((a, c) => a + c.weight, 0);
  if (!total) return null;
  const got = list.reduce((a, c) => a + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  return Math.round((got / total) * 100);
}

/* ---------------- Running one audit ---------------- */

// The address the site really answers on (nassau.se → https://www.nassau.se), so the usual www/https
// redirect isn't counted against every page.
const originCache = new Map<string, { o: string; t: number }>();
async function canonicalOrigin(domain: string) {
  if (import.meta.env.DEV && domain === 'localhost') return 'http://localhost:8080'; // local test site
  const hit = originCache.get(domain);
  if (hit && Date.now() - hit.t < 30 * 60e3) return hit.o;
  const r = await get(`https://${domain}/`, 10000, 50_000).catch(() => null);
  const o = r ? new URL(r.url).origin : `https://${domain}`;
  originCache.set(domain, { o, t: Date.now() });
  return o;
}

async function renderedWordsFor(envId: string, path: string) {
  const snap = await db().prepare("SELECT r2_key FROM snapshots WHERE env_id = ? AND path = ? ORDER BY device = 'desktop' DESC, ts DESC LIMIT 1")
    .bind(envId, path).first<{ r2_key: string }>();
  const obj = snap && (await bucket()?.get(snap.r2_key));
  if (!obj) return null;
  return words(visibleText(parse(await obj.text(), { comment: false })));
}

export async function runAudit(a: AuditRow) {
  const DB = db();
  const env = await DB.prepare('SELECT domain FROM environments WHERE id = ?').bind(a.env_id).first<{ domain: string | null }>();
  if (!env?.domain) throw new Error('This environment has no domain to audit.');
  const origin = await canonicalOrigin(env.domain);
  const target = new URL(a.path, origin).href;
  const res = await get(target);
  const finalOrigin = new URL(res.url).origin;
  const [site, renderedWords, titles] = await Promise.all([
    siteFiles(finalOrigin),
    renderedWordsFor(a.env_id, a.path).catch(() => null),
    DB.prepare(`SELECT path, json_extract(results, '$.title') AS title FROM audits a1 WHERE env_id = ? AND status = 'done'
                 AND ran_at = (SELECT MAX(ran_at) FROM audits a2 WHERE a2.env_id = a1.env_id AND a2.path = a1.path AND a2.status = 'done')`).bind(a.env_id).all<{ path: string; title: string | null }>(),
  ]);
  const checks = /html/i.test(res.headers.get('content-type') || 'text/html')
    ? analyse({ html: res.text, url: res.url, path: a.path, status: res.status, ms: res.ms, bytes: res.bytes, headers: res.headers, redirected: res.redirected, site, renderedWords, otherTitles: new Map(titles.results.map((r) => [r.path, r.title || ''])) })
    : [];
  const pageTitle = clean(parse(res.text.slice(0, 200_000)).querySelector('title')?.textContent || '');
  const seo = scoreOf(checks, 'seo'), aeo = scoreOf(checks, 'aeo'), tech = scoreOf(checks, 'tech');
  const overall = seo === null ? null : Math.round(((seo ?? 0) + (aeo ?? 0) + (tech ?? 0)) / 3);
  const version = a.version_id ?? (await DB.prepare('SELECT id FROM site_versions WHERE env_id = ? AND merged_into IS NULL ORDER BY detected_at DESC LIMIT 1').bind(a.env_id).first<{ id: string }>())?.id ?? null;
  await DB.prepare(`UPDATE audits SET status = 'done', ran_at = ?, version_id = ?, seo = ?, aeo = ?, tech = ?, overall = ?, url = ?, http_status = ?, fetch_ms = ?, bytes = ?, results = ?, error = NULL WHERE id = ?`)
    .bind(Date.now(), version, seo, aeo, tech, overall, res.url, res.status, res.ms, res.bytes, JSON.stringify({ title: pageTitle, checks }), a.id).run();
}

/* ---------------- Reading ---------------- */

export async function latestAudits(envId: string) {
  return (await db().prepare(
    `SELECT * FROM audits a1 WHERE env_id = ? AND status = 'done'
       AND ran_at = (SELECT MAX(ran_at) FROM audits a2 WHERE a2.env_id = a1.env_id AND a2.path = a1.path AND a2.status = 'done')
     ORDER BY path`,
  ).bind(envId).all<AuditRow>()).results;
}

export async function auditSummary(envIds: string[]) {
  if (!envIds.length) return new Map<string, { seo: number; aeo: number; tech: number; pages: number }>();
  const ph = envIds.map(() => '?').join(',');
  const rows = (await db().prepare(
    `SELECT env_id, ROUND(AVG(seo)) AS seo, ROUND(AVG(aeo)) AS aeo, ROUND(AVG(tech)) AS tech, COUNT(*) AS pages FROM audits a1
      WHERE env_id IN (${ph}) AND status = 'done'
        AND ran_at = (SELECT MAX(ran_at) FROM audits a2 WHERE a2.env_id = a1.env_id AND a2.path = a1.path AND a2.status = 'done')
      GROUP BY env_id`,
  ).bind(...envIds).all<{ env_id: string; seo: number; aeo: number; tech: number; pages: number }>()).results;
  return new Map(rows.map((r) => [r.env_id, r]));
}
