import { SV, RULES, svDates } from './i18n-sv';

export type Lang = 'en' | 'sv';
export const LANG_COOKIE = 'probe-lang';

/** Cookie first (set when someone picks a language), then the account setting, then the browser's languages. */
export function pickLang(req: Request, cookie: string | undefined, account: string | null | undefined): Lang {
  if (cookie === 'sv' || cookie === 'en') return cookie;
  if (account === 'sv' || account === 'en') return account;
  const al = (req.headers.get('Accept-Language') || '').toLowerCase();
  // First listed language decides; Norwegian and Danish readers usually prefer Swedish over English too, but keep it strict.
  const first = al.split(',')[0]?.trim() || '';
  return first.startsWith('sv') ? 'sv' : 'en';
}

const ruleOne = (s: string): string | null => {
  const hit = SV[s];
  if (hit !== undefined) return hit;
  for (const [re, fn] of RULES) { const m = s.match(re); if (m) return fn(...m); }
  return null;
};

/** Translate one piece of visible text to Swedish; unknown text comes back unchanged (with dates translated). */
export function sv(text: string): string {
  const core = text.replace(/\s+/g, ' ').trim();
  if (!core || !/[A-Za-z]/.test(core)) return text;
  let out: string | null = SV[core] ?? null;
  if (out === null && core.includes('·')) {
    const parts = core.split(/(\s*·\s*)/);
    const tr = parts.map((p, i) => (i % 2 || !p ? p : ruleOne(p) ?? p));
    if (tr.some((t, i) => t !== parts[i])) out = tr.join('');
  }
  if (out === null) out = ruleOne(core);
  if (out === null) {
    const d = svDates(core);
    if (d === core) return text;
    out = d;
  } else out = svDates(out);
  const lead = text.match(/^\s*/)![0], trail = text.match(/\s*$/)![0];
  return lead + out + trail;
}

const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' } as any)[e]);
const encode = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c]);

const SKIP = 'script, style, textarea, code, pre, [data-no-i18n]';
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];

/** Rewrites an HTML response into Swedish while it streams. */
export function translateResponse(res: Response): Response {
  let skip = 0, buf = '';
  const rw = new HTMLRewriter()
    .on('html', { element(el) { el.setAttribute('lang', 'sv'); } })
    .on(SKIP, { element(el) { skip++; el.onEndTag?.(() => { skip--; }); } })
    .on('*', {
      element(el) {
        for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const t = sv(v); if (t !== v) el.setAttribute(a, t); } }
        if (el.tagName === 'input') { const ty = el.getAttribute('type'); const v = el.getAttribute('value'); if (v && (ty === 'submit' || ty === 'button')) el.setAttribute('value', sv(v)); }
      },
    })
    .onDocument({
      text(chunk) {
        if (skip > 0) return;
        buf += chunk.text;
        if (!chunk.lastInTextNode) { chunk.remove(); return; }
        const raw = buf; buf = '';
        const plain = decode(raw);
        const t = sv(plain);
        chunk.replace(t === plain ? raw : encode(t), { html: true });
      },
    });
  return rw.transform(res);
}
