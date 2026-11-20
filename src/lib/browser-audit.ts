// Accessibility and privacy tests that need a real browser (the other audits read plain HTML).
//
// This file only talks to a Puppeteer-style browser handed to it, so the same code runs on Cloudflare
// (Browser Rendering) and in a local test. Everything that runs inside the audited page is kept as a plain
// string: the build may rewrite functions in ways that break when they are sent to another page.

export type Level = 'A' | 'AA' | 'AAA';
export type A11yIssue = {
  id: string; level: Level; sc: string[]; impact: string; help: string; desc: string; url: string; n: number;
  nodes: { target: string; html: string; summary: string }[];
};
export type A11yResult = {
  score: number | null; url: string; ms: number;
  levels: Record<Level, { failed: number; passed: number }>;
  issues: A11yIssue[]; unsure: number;
};

export type PStatus = 'pass' | 'warn' | 'fail' | 'info';
export type PCheck = { id: string; title: string; weight: number; status: PStatus; found: string; why: string; fix: string };
export type Phase = { cookies: { name: string; domain: string }[]; storage: string[]; hosts: string[] };
export type ServiceRow = {
  id: string; name: string; kind: string; needs: 'yes' | 'advise' | 'no';
  before: string | null; reject: string | null; accept: string | null;
  verdict: 'ok' | 'bad' | 'warn' | 'info'; note: string;
};
export type DialogInfo = {
  found: boolean; tool: string | null; accept: string | null; reject: string | null;
  acceptSize: [number, number] | null; rejectSize: [number, number] | null;
  preticked: number; categories: number; policyInDialog: boolean; policyOnPage: boolean; reopen: boolean; settings: boolean;
};
export type PrivacyResult = {
  score: number | null; url: string; ms: number; dialog: DialogInfo;
  phases: { before: Phase | null; reject: Phase | null; accept: Phase | null };
  services: ServiceRow[]; checks: PCheck[]; otherHosts: string[];
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ProbeAudit/1.0 (+https://probe.nassau.se/app)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms))]);

/* ---------------- Opening a page ---------------- */

async function newContext(browser: any) {
  const make = browser.createBrowserContext ?? browser.createIncognitoBrowserContext;
  return make.call(browser);
}

/** A page that records which hosts it contacts, with a way to wait until the network has gone quiet. */
async function openPage(ctx: any) {
  const page = await ctx.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setBypassCSP(true);
  const state = { hosts: new Set<string>(), last: Date.now() };
  page.on('request', (r: any) => {
    state.last = Date.now();
    try { const u = new URL(r.url()); if (u.protocol.startsWith('http')) state.hosts.add(u.hostname + (u.pathname.length > 1 ? u.pathname : '')); } catch {}
  });
  const quiet = async (idle = 700, max = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < max && Date.now() - state.last < idle) await sleep(120);
  };
  const go = async (url: string) => {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 12000 }).catch(async (e: any) => {
      // A page that never finishes loading (a hanging tracker, an endless stream) is still worth testing.
      if (/timeout/i.test(String(e?.message)) && (await page.evaluate('document.readyState').catch(() => '')) !== 'loading') return null;
      throw e;
    });
    await quiet();
    return res;
  };
  return { page, state, quiet, go };
}

/* ---------------- Accessibility ---------------- */

const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','wcag2aaa'] }, resultTypes: ['violations','incomplete','passes'] }).then(function (r) {
  var slim = function (list, withNodes) { return list.map(function (v) { return { id: v.id, impact: v.impact, tags: v.tags, help: v.help, description: v.description, helpUrl: v.helpUrl, n: v.nodes.length,
    nodes: withNodes ? v.nodes.slice(0, 6).map(function (n) { return { target: [].concat(n.target).join(' '), html: String(n.html || '').slice(0, 180), summary: String(n.failureSummary || '').split('\\n').slice(0, 5).join('\\n').slice(0, 420) }; }) : [] }; }); };
  return { url: location.href, violations: slim(r.violations, true), incomplete: slim(r.incomplete, false), passes: slim(r.passes, false) };
})`;

const levelOf = (tags: string[]): Level => (tags.includes('wcag2aaa') ? 'AAA' : tags.some((t) => /^wcag2\d?aa$/.test(t)) ? 'AA' : 'A');
const scOf = (tags: string[]) => tags.map((t) => /^wcag(\d)(\d)(\d+)$/.exec(t)).filter(Boolean).map((m) => `${m![1]}.${m![2]}.${m![3]}`);
const LOST: Record<string, number> = { critical: 8, serious: 6, moderate: 4, minor: 2 };

export async function a11yAudit(browser: any, url: string, axeSource: string): Promise<A11yResult> {
  const t0 = Date.now();
  const ctx = await newContext(browser);
  try {
    const { page, go } = await openPage(ctx);
    await go(url);
    await sleep(600);
    await page.addScriptTag({ content: axeSource });
    const r: any = await within(page.evaluate(AXE_RUN), 20000, 'The accessibility test');
    const levels: A11yResult['levels'] = { A: { failed: 0, passed: 0 }, AA: { failed: 0, passed: 0 }, AAA: { failed: 0, passed: 0 } };
    for (const v of r.violations) levels[levelOf(v.tags)].failed++;
    for (const v of r.passes) levels[levelOf(v.tags)].passed++;
    const order = { A: 0, AA: 1, AAA: 2 };
    const issues: A11yIssue[] = r.violations.map((v: any) => ({ id: v.id, level: levelOf(v.tags), sc: scOf(v.tags), impact: v.impact || 'moderate', help: v.help, desc: v.description, url: v.helpUrl, n: v.n, nodes: v.nodes }))
      .sort((a: A11yIssue, b: A11yIssue) => order[a.level] - order[b.level] || (LOST[b.impact] ?? 4) - (LOST[a.impact] ?? 4) || b.n - a.n);
    // The score covers levels A and AA: the share of checks that applied and passed, where a failed check weighs more the more serious it is.
    const passW = (levels.A.passed + levels.AA.passed) * 3;
    const lostW = issues.filter((i) => i.level !== 'AAA').reduce((s, i) => s + (LOST[i.impact] ?? 4), 0);
    return { score: passW + lostW ? Math.round((passW / (passW + lostW)) * 100) : null, url: r.url, ms: Date.now() - t0, levels, issues, unsure: r.incomplete.length };
  } finally { await ctx.close().catch(() => {}); }
}

/* ---------------- Privacy and consent ---------------- */

// Runs in the audited page. Finds the consent dialog, marks its Accept and Reject buttons so they can be pressed, and reports what it sees.
const FIND_DIALOG = `(function () {
  var vis = function (el) { if (!el) return false; var r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05; };
  var txt = function (el) { return (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(); };
  var q = function (root, sel) { try { return [].slice.call(root.querySelectorAll(sel)); } catch (e) { return []; } };
  var KNOWN = [
    ['Cookiebot', '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept', '#CybotCookiebotDialogBodyButtonDecline'],
    ['OneTrust', '#onetrust-banner-sdk', '#onetrust-accept-btn-handler', '#onetrust-reject-all-handler, .ot-pc-refuse-all-handler'],
    ['Finsweet Cookie Consent', '[fs-cc="banner"], [fs-consent-element="banner"]', '[fs-cc="allow"], [fs-consent-element="allow"]', '[fs-cc="deny"], [fs-consent-element="deny"]'],
    ['CookieYes', '.cky-consent-container', '.cky-btn-accept', '.cky-btn-reject'],
    ['Complianz', '.cmplz-cookiebanner', '.cmplz-accept', '.cmplz-deny'],
    ['Iubenda', '#iubenda-cs-banner, .iubenda-cs-container', '.iubenda-cs-accept-btn', '.iubenda-cs-reject-btn'],
    ['Didomi', '#didomi-notice, #didomi-popup', '#didomi-notice-agree-button', '#didomi-notice-disagree-button, .didomi-continue-without-agreeing'],
    ['Osano', '.osano-cm-dialog', '.osano-cm-accept-all, .osano-cm-accept', '.osano-cm-deny, .osano-cm-denyAll'],
    ['HubSpot', '#hs-eu-cookie-confirmation', '#hs-eu-confirmation-button', '#hs-eu-decline-button'],
    ['Klaro', '.klaro .cookie-notice, .klaro .cookie-modal', '.cm-btn-success, .cm-btn-accept-all', '.cn-decline, .cm-btn-decline'],
    ['Termly', '#termly-code-snippet-support [role="alertdialog"], .t-consentPrompt', '[data-tid="banner-accept"], .t-acceptAllButton', '[data-tid="banner-decline"], .t-declineButton'],
    ['CookieFirst', '.cookiefirst-root [data-cookiefirst-widget="banner"], .cookiefirst-root', '[data-cookiefirst-action="accept"]', '[data-cookiefirst-action="reject"]'],
    ['Cookie Information', '#coiOverlay, #cookie-information-template-wrapper', '#declineButton ~ #coiPage-1 .coi-banner__accept, .coi-banner__accept', '#declineButton, .coi-banner__decline'],
    ['Borlabs Cookie', '#BorlabsCookieBox', '[data-cookie-accept-all], .brlbs-btn-accept-all', '[data-cookie-refuse], .brlbs-btn-accept-only-essential'],
    ['Shopify', '#shopify-pc__banner', '#shopify-pc__banner__btn-accept', '#shopify-pc__banner__btn-decline'],
    ['Webflow consent', '[data-wf-consent="banner"], .w-consent-banner', '[data-wf-consent="allow"]', '[data-wf-consent="deny"]']
  ];
  var ACCEPT = /^(accept|agree|allow|i agree|i accept|yes|ok(ay)?\\b|got it|i understand|godkänn|acceptera|tillåt|jag (förstår|godkänner|accepterar)|okej|ja\\b|akzeptieren|alle akzeptieren|zustimmen|einverstanden|accepter|godta|aksepter|tillad|hyväksy)/i;
  var REJECT = /(reject|decline|deny|refuse|disagree|no,? thanks|(only|just) (the )?(necessary|essential|required|strictly)|(necessary|essential|required) (cookies )?only|continue without|avvisa|neka|avböj|nej tack|(endast|bara|enbart) (de )?nödvändiga|ablehnen|nur (notwendige|erforderliche|essenzielle)|afvis|avslå|kun nødvendige|hylkää|vain välttämättömät)/i;
  var SETTINGS = /(settings|preferences|customi[sz]e|manage|options|choose|inställningar|anpassa|hantera|välj|einstellungen|anpassen|indstillinger|innstillinger)/i;
  var WORD = /(cookie|kakor|consent|samtyck|gdpr|tracking|spårning)/i;
  var POLICY = /(privacy|integritet|personuppgift|datenschutz|data protection|dataskydd|gdpr|cookie ?(policy|notice)|kakpolicy|cookiepolicy)/i;
  var CLICK = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
  var root = null, tool = null, accept = null, reject = null;
  for (var i = 0; i < KNOWN.length && !root; i++) {
    var hit = q(document, KNOWN[i][1]).filter(vis)[0];
    if (hit) { root = hit; tool = KNOWN[i][0]; accept = q(document, KNOWN[i][2]).filter(vis)[0] || null; reject = q(document, KNOWN[i][3]).filter(vis)[0] || null; }
  }
  if (!root) {
    var cands = q(document, 'div, section, aside, dialog, form, footer, [role="dialog"], [role="alertdialog"], [role="region"]').filter(function (el) {
      if (!vis(el)) return false;
      var s = getComputedStyle(el), mark = (el.id + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      var placed = s.position === 'fixed' || s.position === 'sticky' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog' || el.tagName === 'DIALOG' || /(cookie|consent|gdpr|cmp|kakor|samtyck)/.test(mark);
      if (!placed) return false;
      var t = txt(el); if (t.length < 20 || t.length > 3000 || !WORD.test(t)) return false;
      return q(el, CLICK).filter(vis).some(function (b) { var bt = txt(b); return bt.length < 60 && (ACCEPT.test(bt) || REJECT.test(bt)); });
    });
    cands.sort(function (a, b) { return txt(a).length - txt(b).length; });
    if (cands.length) { root = cands[0]; tool = null; }
  }
  var policyOnPage = q(document, 'a[href]').some(function (a) { return POLICY.test(txt(a)) || POLICY.test(a.getAttribute('href') || ''); });
  var reopen = q(document, '[fs-cc="open-preferences"], [fs-consent-element="open-preferences"], .cky-btn-revisit, .cky-revisit-bottom-left, #ot-sdk-btn, .ot-sdk-show-settings, .cmplz-manage-consent, .iubenda-cs-preferences-link, .osano-cm-widget, [data-cc="show-preferencesModal"], [data-wf-consent="open-preferences"], a[href*="Cookiebot.renew"], a[href*="Cookiebot.show"]').length > 0
    || q(document, CLICK).some(function (b) { if (root && root.contains(b)) return false; var bt = txt(b); return bt.length < 60 && /((cookie|kak|samtyck|consent|privacy|integritet).{0,24}(settings|preferences|inställningar|choices|val)|(change|manage|ändra|hantera).{0,12}(cookies|consent|samtycke|kakor))/i.test(bt); });
  if (!root) return { found: false, tool: null, accept: null, reject: null, acceptSize: null, rejectSize: null, preticked: 0, categories: 0, policyInDialog: false, policyOnPage: policyOnPage, reopen: reopen, settings: false };
  var btns = q(root, CLICK).filter(vis).filter(function (b) { return txt(b).length < 60; });
  if (!accept) accept = btns.filter(function (b) { return ACCEPT.test(txt(b)) && !REJECT.test(txt(b)); }).sort(function (a, b) { return (/all|alla|alle/i.test(txt(b)) ? 1 : 0) - (/all|alla|alle/i.test(txt(a)) ? 1 : 0); })[0] || null;
  if (!reject) reject = btns.filter(function (b) { return REJECT.test(txt(b)); })[0] || null;
  var size = function (el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  if (accept) accept.setAttribute('data-probe-consent', 'accept');
  if (reject) reject.setAttribute('data-probe-consent', 'reject');
  var boxes = q(root, 'input[type="checkbox"]');
  return { found: true, tool: tool, accept: accept ? txt(accept).slice(0, 60) : null, reject: reject ? txt(reject).slice(0, 60) : null, acceptSize: size(accept), rejectSize: size(reject),
    preticked: boxes.filter(function (b) { return b.checked && !b.disabled; }).length, categories: boxes.length,
    policyInDialog: q(root, 'a[href]').some(function (a) { return POLICY.test(txt(a)) || POLICY.test(a.getAttribute('href') || ''); }), policyOnPage: policyOnPage, reopen: reopen,
    settings: btns.some(function (b) { return SETTINGS.test(txt(b)); }) };
})()`;

type Svc = { id: string; name: string; kind: string; needs: 'yes' | 'advise' | 'no'; host?: RegExp; cookie?: RegExp; note: string };
// What a host or cookie belongs to. `yes` = needs consent before it runs; `advise` = no cookie, but visitor data goes to another company.
const SERVICES: Svc[] = [
  { id: 'ga', name: 'Google Analytics', kind: 'Statistics', needs: 'yes', host: /(^|\.)google-analytics\.com|(^|\.)analytics\.google\.com|googletagmanager\.com\/gtag\/js\?id=G-|\/g\/collect/, cookie: /^_ga($|_)|^_gid$|^_gat/, note: '' },
  { id: 'gads', name: 'Google Ads', kind: 'Marketing', needs: 'yes', host: /doubleclick\.net|googleadservices\.com|googlesyndication\.com|google\.[a-z.]+\/(pagead|ads)|\/gtag\/js\?id=AW-/, cookie: /^_gcl_|^IDE$|^test_cookie$/, note: '' },
  { id: 'meta', name: 'Meta Pixel', kind: 'Marketing', needs: 'yes', host: /connect\.facebook\.net|facebook\.com\/tr/, cookie: /^_fbp$|^_fbc$/, note: '' },
  { id: 'linkedin', name: 'LinkedIn Insight', kind: 'Marketing', needs: 'yes', host: /snap\.licdn\.com|px\.ads\.linkedin\.com|linkedin\.com\/(px|collect)/, cookie: /^li_(sugr|fat_id|gc)$|^bcookie$|^lidc$|^UserMatchHistory$|^AnalyticsSyncHistory$/, note: '' },
  { id: 'hotjar', name: 'Hotjar', kind: 'Behaviour tracking', needs: 'yes', host: /(^|\.)hotjar\.(com|io)/, cookie: /^_hj/, note: '' },
  { id: 'clarity', name: 'Microsoft Clarity', kind: 'Behaviour tracking', needs: 'yes', host: /(^|\.)clarity\.ms/, cookie: /^_cl(ck|sk)$|^CLID$|^MUID$/, note: '' },
  { id: 'bing', name: 'Microsoft Advertising', kind: 'Marketing', needs: 'yes', host: /bat\.bing\.com/, cookie: /^_uet(sid|vid)$/, note: '' },
  { id: 'tiktok', name: 'TikTok Pixel', kind: 'Marketing', needs: 'yes', host: /analytics\.tiktok\.com/, cookie: /^_ttp$|^_tt_enable_cookie$/, note: '' },
  { id: 'pinterest', name: 'Pinterest Tag', kind: 'Marketing', needs: 'yes', host: /ct\.pinterest\.com|s\.pinimg\.com\/ct/, cookie: /^_pin_unauth$|^_pinterest_/, note: '' },
  { id: 'x', name: 'X (Twitter) Pixel', kind: 'Marketing', needs: 'yes', host: /static\.ads-twitter\.com|analytics\.twitter\.com|t\.co\/i\/adsct/, cookie: /^_twclid$|^muc_ads$|^personalization_id$/, note: '' },
  { id: 'snap', name: 'Snap Pixel', kind: 'Marketing', needs: 'yes', host: /sc-static\.net\/scevent|tr\.snapchat\.com/, cookie: /^_scid/, note: '' },
  { id: 'hubspot', name: 'HubSpot tracking', kind: 'Marketing', needs: 'yes', host: /js\.hs-scripts\.com|js\.hs-analytics\.net|track\.hubspot\.com|js\.hs-banner\.com/, cookie: /^__hs(tc|src|sc)$|^hubspotutk$/, note: '' },
  { id: 'matomo', name: 'Matomo', kind: 'Statistics', needs: 'yes', host: /matomo\.(js|php)|piwik\.(js|php)|(^|\.)matomo\.cloud/, cookie: /^_pk_(id|ses|ref)/, note: '' },
  { id: 'mixpanel', name: 'Mixpanel', kind: 'Statistics', needs: 'yes', host: /(^|\.)mixpanel\.com|(^|\.)mxpnl\.com/, cookie: /^mp_.*_mixpanel$/, note: '' },
  { id: 'segment', name: 'Segment', kind: 'Statistics', needs: 'yes', host: /cdn\.segment\.(com|io)|api\.segment\.io/, cookie: /^ajs_(anonymous|user)_id$/, note: '' },
  { id: 'amplitude', name: 'Amplitude', kind: 'Statistics', needs: 'yes', host: /(^|\.)amplitude\.com/, cookie: /^amp_|^AMP_/, note: '' },
  { id: 'youtube', name: 'YouTube video', kind: 'Embedded video', needs: 'yes', host: /(^|\.)youtube\.com\/(embed|iframe_api|youtubei|s\/player)/, cookie: /^VISITOR_INFO1_LIVE$|^YSC$|^VISITOR_PRIVACY_METADATA$/, note: '' },
  { id: 'vimeo', name: 'Vimeo video', kind: 'Embedded video', needs: 'yes', host: /player\.vimeo\.com/, cookie: /^vuid$/, note: '' },
  { id: 'intercom', name: 'Intercom chat', kind: 'Chat', needs: 'yes', host: /widget\.intercom\.io|(^|\.)intercomcdn\.com/, cookie: /^intercom-/, note: '' },
  { id: 'gtm', name: 'Google Tag Manager', kind: 'Tag manager', needs: 'no', host: /googletagmanager\.com\/gtm\.js/, note: 'Only a container. What counts is what it loads, shown in the other rows.' },
  { id: 'yt-nocookie', name: 'YouTube video (privacy mode)', kind: 'Embedded video', needs: 'advise', host: /youtube-nocookie\.com/, note: 'No cookie until play, but the visitor’s IP address goes to Google. Load the video on click.' },
  { id: 'gfonts', name: 'Google Fonts', kind: 'Fonts', needs: 'advise', host: /fonts\.googleapis\.com|fonts\.gstatic\.com/, note: 'The visitor’s IP address goes to Google on every page view. Host the fonts on the site itself.' },
  { id: 'typekit', name: 'Adobe Fonts', kind: 'Fonts', needs: 'advise', host: /use\.typekit\.net|p\.typekit\.net/, note: 'The visitor’s IP address goes to Adobe on every page view.' },
  { id: 'gmaps', name: 'Google Maps', kind: 'Map', needs: 'advise', host: /maps\.googleapis\.com|maps\.gstatic\.com|google\.com\/maps/, cookie: /^NID$/, note: 'Visitor data goes to Google. Load the map on click, or show a picture that links to it.' },
  { id: 'recaptcha', name: 'Google reCAPTCHA', kind: 'Spam protection', needs: 'advise', host: /google\.com\/recaptcha|gstatic\.com\/recaptcha|recaptcha\.net/, cookie: /^_GRECAPTCHA$/, note: 'Protects forms, but sends visitor data to Google on every page it loads on. Load it only on pages with a form.' },
  { id: 'spotify', name: 'Spotify player', kind: 'Embedded audio', needs: 'advise', host: /open\.spotify\.com\/embed/, note: 'Visitor data goes to Spotify. Load the player on click.' },
  { id: 'probe', name: 'Probe', kind: 'Statistics', needs: 'no', host: /probe\.nassau\.se\/app\/z\.js/, note: 'No cookie and no personal data. A random visit id is kept in the tab until it closes.' },
  { id: 'plausible', name: 'Plausible', kind: 'Statistics', needs: 'no', host: /plausible\.io/, note: 'Cookieless statistics.' },
  { id: 'fathom', name: 'Fathom', kind: 'Statistics', needs: 'no', host: /cdn\.usefathom\.com/, note: 'Cookieless statistics.' },
  { id: 'simple', name: 'Simple Analytics', kind: 'Statistics', needs: 'no', host: /simpleanalyticscdn\.com/, note: 'Cookieless statistics.' },
];
// Delivery networks and site builders: they serve files and are not what a privacy report is about.
const INFRA = /(^|\.)(jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|cloudfront\.net|website-files\.com|webflow\.com|webflow\.io|jquery\.com|cloudflare\.com|cloudflareinsights\.com|gstatic\.com|googleapis\.com|googletagmanager\.com|wp\.com|shopifycdn\.com|shopify\.com|squarespace-cdn\.com|wixstatic\.com|parastorage\.com|akamaized\.net|fastly\.net|bootstrapcdn\.com|fontawesome\.com|hsforms\.net|cookiebot\.com|cookielaw\.org|onetrust\.com|cookieyes\.com|iubenda\.com|finsweet\.com|usercentrics\.eu|didomi\.io|osano\.com|termly\.io|clerk\.com)$/;

const site2 = (h: string) => { const p = h.replace(/^www\./, '').split('.'); const n = p.length > 2 && /^(co|com|org|net|ac|gov)$/.test(p[p.length - 2]) ? 3 : 2; return p.slice(-n).join('.'); };

async function collect(page: any, hosts: Set<string>): Promise<Phase> {
  let cookies: { name: string; domain: string }[] = [];
  try {
    const client = await (page.createCDPSession ? page.createCDPSession() : page.target().createCDPSession());
    const all = await client.send('Network.getAllCookies');
    cookies = all.cookies.map((c: any) => ({ name: String(c.name).slice(0, 80), domain: String(c.domain).replace(/^\./, '') }));
    await client.detach().catch(() => {});
  } catch {
    cookies = (await page.cookies().catch(() => [])).map((c: any) => ({ name: String(c.name).slice(0, 80), domain: String(c.domain).replace(/^\./, '') }));
  }
  const storage: string[] = await page.evaluate(`(function () { var out = []; try { for (var k in localStorage) if (localStorage.hasOwnProperty(k)) out.push('local: ' + k); } catch (e) {} try { for (var s in sessionStorage) if (sessionStorage.hasOwnProperty(s)) out.push('session: ' + s); } catch (e) {} return out.slice(0, 60); })()`).catch(() => []);
  return { cookies: cookies.slice(0, 80), storage, hosts: [...hosts].slice(0, 400) };
}

/** One visit: load, optionally press Accept or Reject, load again, and report what is stored and contacted afterwards. */
async function visit(browser: any, url: string, press: 'accept' | 'reject' | null) {
  const ctx = await newContext(browser);
  try {
    const { page, state, quiet, go } = await openPage(ctx);
    const res = await go(url);
    await sleep(1500); // dialogs often slide in a moment after load
    const dialog = (await page.evaluate(FIND_DIALOG)) as DialogInfo;
    let pressed = false;
    if (press && dialog.found && dialog[press]) {
      pressed = await page.evaluate(`(function () { var b = document.querySelector('[data-probe-consent="${press}"]'); if (!b) return false; b.click(); return true; })()`).catch(() => false);
      if (pressed) {
        await sleep(1200); await quiet(700, 2500);
        // Load the page again: what runs now is what a visitor who made this choice gets on every later page.
        state.hosts.clear();
        await page.reload({ waitUntil: 'load', timeout: 12000 }).catch(() => null);
        await quiet(); await sleep(800);
      }
    }
    const phase = await collect(page, state.hosts);
    return { dialog, pressed, phase, finalUrl: page.url() as string, status: res ? (res.status() as number) : 0 };
  } finally { await ctx.close().catch(() => {}); }
}

export function judge(pageUrl: string, dialog: DialogInfo, before: Phase, reject: Phase | null, accept: Phase | null) {
  const self = site2(new URL(pageUrl).hostname);
  const seen = (p: Phase | null, s: Svc): string | null => {
    if (!p) return null;
    const c = s.cookie ? p.cookies.filter((x) => s.cookie!.test(x.name)).map((x) => x.name) : [];
    const h = s.host ? p.hosts.some((x) => s.host!.test(x)) : false;
    if (c.length) return [...new Set(c)].slice(0, 3).join(', ') + (c.length > 3 ? '…' : '');
    return h ? 'loaded' : null;
  };
  const services: ServiceRow[] = [];
  for (const s of SERVICES) {
    const b = seen(before, s), r = seen(reject, s), a = seen(accept, s);
    if (!b && !r && !a) continue;
    let verdict: ServiceRow['verdict'] = 'info', note = s.note;
    if (s.needs === 'yes') {
      if (b) { verdict = 'bad'; note = dialog.found ? 'Runs before the visitor has chosen.' : 'Runs without asking for consent.'; }
      else if (r) { verdict = 'bad'; note = 'Still runs after the visitor pressed Reject.'; }
      else { verdict = 'ok'; note = 'Only runs after Accept.'; }
    } else if (s.needs === 'advise') verdict = 'warn';
    services.push({ id: s.id, name: s.name, kind: s.kind, needs: s.needs, before: b, reject: reject ? r : null, accept: accept ? a : null, verdict, note });
  }
  // Cookies from other companies that the list above doesn't recognise.
  const known = (name: string) => SERVICES.some((s) => s.cookie?.test(name));
  const strangers = new Map<string, { b: boolean; r: boolean; a: boolean }>();
  const mark = (p: Phase | null, k: 'b' | 'r' | 'a') => { for (const c of p?.cookies ?? []) if (site2(c.domain) !== self && !known(c.name) && !INFRA.test(c.domain)) { const d = site2(c.domain); strangers.set(d, { ...(strangers.get(d) ?? { b: false, r: false, a: false }), [k]: true }); } };
  mark(before, 'b'); mark(reject, 'r'); mark(accept, 'a');
  for (const [d, v] of strangers) services.push({ id: `cookie:${d}`, name: d, kind: 'Unrecognised cookie', needs: 'yes', before: v.b ? 'cookie set' : null, reject: reject ? (v.r ? 'cookie set' : null) : null, accept: accept ? (v.a ? 'cookie set' : null) : null,
    verdict: v.b || v.r ? 'bad' : 'ok', note: v.b || v.r ? 'A cookie from another company is set without consent. Check what it is for.' : 'Only set after Accept.' });
  const rank = { bad: 0, warn: 1, ok: 2, info: 3 };
  services.sort((x, y) => rank[x.verdict] - rank[y.verdict]);

  const allUrls = [...before.hosts, ...(reject?.hosts ?? []), ...(accept?.hosts ?? [])];
  const claimed = new Set(allUrls.filter((u) => SERVICES.some((s) => s.host?.test(u))).map((u) => u.split('/')[0]));
  const otherHosts = [...new Set(allUrls.map((u) => u.split('/')[0]))].filter((h) => site2(h) !== self && !INFRA.test(h) && !claimed.has(h)).sort().slice(0, 30);

  const needing = services.filter((s) => s.needs === 'yes');
  const early = needing.filter((s) => s.before), afterNo = needing.filter((s) => !s.before && s.reject), advise = services.filter((s) => s.verdict === 'warn');
  const names = (l: ServiceRow[]) => l.map((s) => s.name).slice(0, 4).join(', ') + (l.length > 4 ? '…' : '');
  const checks: PCheck[] = [];
  const add = (c: PCheck) => checks.push(c);
  add({ id: 'priv.before', title: 'Nothing that needs consent runs before a choice', weight: 30, status: early.length ? 'fail' : 'pass',
    found: early.length ? `${early.length} ${early.length === 1 ? 'service starts' : 'services start'} as soon as the page loads: ${names(early)}` : needing.length ? 'Services that need consent wait for it' : 'No service that needs consent was found',
    why: 'Consent is required before anything non-essential is stored on, or read from, the visitor’s device. This is the first thing a regulator checks.',
    fix: 'Put these services under the consent tool so they load only after Accept, or remove them.' });
  if (needing.length && !dialog.found) add({ id: 'priv.dialog', title: 'A consent dialog is shown', weight: 15, status: 'fail', found: 'No dialog detected, but services that need consent are running',
    why: 'Visitors have to be asked before these services run. If the site has a dialog that Probe didn’t recognise, this check can be wrong.', fix: 'Add a consent dialog and connect the services to it.' });
  else add({ id: 'priv.dialog', title: 'A consent dialog is shown', weight: 0, status: dialog.found ? 'pass' : 'info', found: dialog.found ? (dialog.tool ? `Recognised as ${dialog.tool}` : 'Found (custom-built)') : 'No dialog detected, and none is needed for what was found',
    why: 'A dialog is only needed when the site uses something that requires consent.', fix: '' });
  if (dialog.found) {
    add({ id: 'priv.reject', title: 'Reject is respected', weight: 20, status: !dialog.reject ? 'info' : afterNo.length || early.length ? 'fail' : 'pass',
      found: !dialog.reject ? 'No Reject button to press, so this could not be tested' : afterNo.length || early.length ? `Still running after Reject: ${names([...early.filter((s) => s.reject), ...afterNo]) || names(early)}` : 'Nothing that needs consent ran after Reject',
      why: 'A “no” has to switch things off. Otherwise the dialog is only decoration.', fix: 'Check that every tracking script is controlled by the consent tool, including ones added by a tag manager or an embed.' });
    const aA = dialog.acceptSize ? dialog.acceptSize[0] * dialog.acceptSize[1] : 0, rA = dialog.rejectSize ? dialog.rejectSize[0] * dialog.rejectSize[1] : 0;
    add({ id: 'priv.reject-easy', title: 'Reject is as easy as Accept', weight: 10, status: !dialog.reject ? 'fail' : aA && rA && rA < aA * 0.5 ? 'warn' : 'pass',
      found: !dialog.reject ? `No Reject button on the first layer${dialog.settings ? ', only a settings link' : ''}${dialog.accept ? ` (Accept: “${dialog.accept}”)` : ''}`
        : `Accept “${dialog.accept ?? '?'}” ${dialog.acceptSize ? dialog.acceptSize.join(' × ') + ' px' : ''}, Reject “${dialog.reject}” ${dialog.rejectSize ? dialog.rejectSize.join(' × ') + ' px' : ''}`,
      why: 'Saying no must not take more effort than saying yes. A hidden or much smaller Reject is treated as invalid consent.', fix: 'Put a Reject button next to Accept, in the same size and one click away.' });
    add({ id: 'priv.preticked', title: 'No boxes are ticked in advance', weight: 5, status: dialog.preticked ? 'fail' : 'pass',
      found: dialog.preticked ? `${dialog.preticked} optional ${dialog.preticked === 1 ? 'category is' : 'categories are'} already ticked` : dialog.categories ? `${dialog.categories} ${dialog.categories === 1 ? 'checkbox' : 'checkboxes'}, no optional one ticked` : 'No checkboxes on the first layer',
      why: 'Consent has to be an active choice. Pre-ticked boxes don’t count.', fix: 'Leave every optional category off until the visitor turns it on.' });
    add({ id: 'priv.change', title: 'The choice can be changed later', weight: 5, status: dialog.reopen ? 'pass' : 'warn', found: dialog.reopen ? 'A link or button that reopens the settings was found' : 'No “Cookie settings” link found on the page',
      why: 'Withdrawing consent has to be as easy as giving it.', fix: 'Add a link in the footer that reopens the consent dialog.' });
  }
  add({ id: 'priv.policy', title: 'Privacy policy is linked', weight: 8, status: dialog.policyOnPage || dialog.policyInDialog ? 'pass' : 'warn',
    found: dialog.policyInDialog ? 'Linked from the consent dialog' : dialog.policyOnPage ? 'Linked from the page' : 'No link to a privacy or cookie policy found on this page',
    why: 'Visitors must be able to read what is collected and why, from every page.', fix: 'Link the privacy policy from the footer, and from the consent dialog if there is one.' });
  add({ id: 'priv.third', title: 'No visitor data sent to others without need', weight: 7, status: advise.length ? 'warn' : 'pass',
    found: advise.length ? `${names(advise)} ${advise.length === 1 ? 'is' : 'are'} loaded for every visitor` : 'No fonts, maps or players loaded from other companies',
    why: 'Loading a font, map or player from another company gives that company each visitor’s IP address, even without a cookie.', fix: 'Host fonts on the site itself, and load maps and players only when the visitor clicks them.' });
  const scored = checks.filter((c) => c.status !== 'info' && c.weight > 0);
  const total = scored.reduce((s, c) => s + c.weight, 0);
  const got = scored.reduce((s, c) => s + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  return { services, checks, otherHosts, score: total ? Math.round((got / total) * 100) : null };
}

export async function consentAudit(browser: any, url: string): Promise<PrivacyResult> {
  const t0 = Date.now();
  // Three separate visitors at the same time: one who does nothing, one who says no, one who says yes.
  const [b, r, a] = await Promise.all([
    within(visit(browser, url, null), 26000, 'The privacy test'),
    within(visit(browser, url, 'reject'), 26000, 'The Reject test').catch(() => null),
    within(visit(browser, url, 'accept'), 26000, 'The Accept test').catch(() => null),
  ]);
  const reject = r && r.pressed ? r.phase : null, accept = a && a.pressed ? a.phase : null;
  const j = judge(b.finalUrl, b.dialog, b.phase, reject, accept);
  return { score: j.score, url: b.finalUrl, ms: Date.now() - t0, dialog: b.dialog, phases: { before: b.phase, reject, accept }, services: j.services, checks: j.checks, otherHosts: j.otherHosts };
}
