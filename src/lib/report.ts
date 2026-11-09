// Project reports: one block per chosen environment and period (a date range or a site version).
import { db, listEnvironments, type Environment } from './server';
import { dashboard, sessionSummary } from './stats';
import { listVersions, type VersionView } from './versions';

export const SECTIONS = [
  ['summary', 'Key figures', 'Visitors, sessions, engagement, scroll depth and rage clicks, compared with the period before'],
  ['traffic', 'Traffic over time', 'Sessions per day'],
  ['pages', 'Top pages', 'Most viewed pages with scroll depth'],
  ['sources', 'Sources and devices', 'Where visitors came from and what they used'],
  ['signals', 'Visit quality', 'Frustrated sessions, quick exits and engaged visits'],
  ['versions', 'Site versions', 'Versions in the period and how they compare'],
  ['audits', 'SEO / AEO / technical audits', 'Latest scores per page and what to fix'],
] as const;
export type Section = (typeof SECTIONS)[number][0];

export type Block = {
  env: Environment; label: string; from: number; to: number; days: number;
  dash: Awaited<ReturnType<typeof dashboard>>;
  signals: Awaited<ReturnType<typeof sessionSummary>>;
  versions: (VersionView & { sessions: number; engagement: number })[];
  audits: { path: string; seo: number | null; aeo: number | null; tech: number | null; ran_at: number; title: string; issues: string[] }[];
};

export type Choice = { envId: string; period: string }; // period: '7d' | '30d' | '90d' | 'v:<versionId>'

export async function buildReport(projectId: string, choices: Choice[]) {
  const envs = await listEnvironments(projectId);
  const blocks: Block[] = [];
  for (const c of choices.slice(0, 16)) {
    const env = envs.find((e) => e.id === c.envId && e.kind === 'web');
    if (!env) continue;
    const versions = await listVersions(env.id, env.name);
    let from: number, to: number, label: string;
    if (c.period.startsWith('v:')) {
      const v = versions.find((x) => x.id === c.period.slice(2));
      if (!v) continue;
      from = v.from; to = Number.isFinite(v.to) ? v.to : Date.now(); label = v.label;
    } else {
      const days = { '7d': 7, '30d': 30, '90d': 90 }[c.period as '7d'] ?? 30;
      to = Date.now(); from = to - days * 864e5; label = `Last ${days} days`;
    }
    const days = Math.max(1, Math.ceil((to - from) / 864e5));
    const [dash, signals] = await Promise.all([dashboard(env.id, from, to, from - (to - from), days), sessionSummary(env.id, from, to, {})]);
    const inRange = versions.filter((v) => v.from < to && v.to > from);
    const vstats = await Promise.all(inRange.map(async (v) => {
      const r = await db().prepare('SELECT COUNT(*) AS sessions, COALESCE(AVG(duration), 0) AS engagement FROM sessions WHERE env_id = ? AND started >= ? AND started < ?')
        .bind(env.id, v.from, Number.isFinite(v.to) ? v.to : Date.now() + 1).first<{ sessions: number; engagement: number }>();
      return { ...v, sessions: r?.sessions ?? 0, engagement: r?.engagement ?? 0 };
    }));
    const audits = (await db().prepare(
      `SELECT path, seo, aeo, tech, ran_at, results FROM audits a1 WHERE env_id = ? AND status = 'done' AND ran_at < ?
         AND ran_at = (SELECT MAX(ran_at) FROM audits a2 WHERE a2.env_id = a1.env_id AND a2.path = a1.path AND a2.status = 'done' AND a2.ran_at < ?)
       ORDER BY path LIMIT 40`,
    ).bind(env.id, to + 1, to + 1).all<{ path: string; seo: number; aeo: number; tech: number; ran_at: number; results: string }>()).results.map((a) => {
      let title = '', issues: string[] = [];
      try {
        const j = JSON.parse(a.results);
        title = j.title || '';
        issues = (j.checks || []).filter((c: any) => c.status === 'fail').sort((x: any, y: any) => y.weight - x.weight).slice(0, 3).map((c: any) => c.title);
      } catch {}
      return { path: a.path, seo: a.seo, aeo: a.aeo, tech: a.tech, ran_at: a.ran_at, title, issues };
    });
    blocks.push({ env, label, from, to, days, dash, signals, versions: vstats, audits });
  }
  return blocks;
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportCsv(projectName: string, blocks: Block[]) {
  const rows: unknown[][] = [['project', 'environment', 'domain', 'period', 'from', 'to', 'section', 'item', 'metric', 'value']];
  const d = (t: number) => new Date(t).toISOString().slice(0, 10);
  for (const b of blocks) {
    const base = [projectName, b.env.name, b.env.domain, b.label, d(b.from), d(b.to)];
    const n = b.dash.now;
    for (const [k, v] of Object.entries({ visitors: n.visitors, sessions: n.sessions, pageviews: n.pageviews, avg_engagement_s: Math.round(n.engagement), avg_scroll_pct: Math.round(n.scroll), rage_clicks: n.rage }))
      rows.push([...base, 'summary', '', k, v]);
    b.dash.counts.forEach((c, i) => rows.push([...base, 'traffic', d(b.from + i * b.dash.bucket), 'sessions', c]));
    for (const p of b.dash.pages) rows.push([...base, 'pages', p.path, 'views', p.n], [...base, 'pages', p.path, 'avg_scroll_pct', Math.round(p.scroll)]);
    for (const r of b.dash.referrers) rows.push([...base, 'sources', r.referrer || 'Direct', 'sessions', r.n]);
    for (const r of b.dash.devices) rows.push([...base, 'devices', r.device || 'desktop', 'sessions', r.n]);
    for (const [k, v] of Object.entries({ frustrated: b.signals.frustrated, quick_exits: b.signals.bounced, engaged: b.signals.engaged })) rows.push([...base, 'signals', '', k, v]);
    for (const v of b.versions) rows.push([...base, 'versions', v.label, 'appeared', d(v.from)], [...base, 'versions', v.label, 'sessions', v.sessions]);
    for (const a of b.audits) rows.push([...base, 'audits', a.path, 'seo', a.seo], [...base, 'audits', a.path, 'aeo', a.aeo], [...base, 'audits', a.path, 'technical', a.tech]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
