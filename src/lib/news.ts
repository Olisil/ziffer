// "What's new": a short note shown once to each person after a larger update.
// To announce an update, add a release to the top of RELEASES; nothing else needs to change.
// Only things that concern ordinary users belong here, never admin features.
// Texts are written in English; add the Swedish in src/lib/i18n-sv.ts.
import { db, url, type Project } from './server';
import { planState } from './plans';
import type { User } from './users';

type Need = 'edit' | 'agents';
type Item = { title: string; text: string; link?: { label: string; path: (projectId: string) => string }; needs?: Need };
type Release = { id: string; label: string; from: number; items: Item[] };

export const RELEASES: Release[] = [
  {
    id: '2026-11',
    label: 'November 2026',
    from: Date.UTC(2026, 10, 17),
    items: [
      { title: 'Your data is now stored in the EU', text: 'Statistics and page snapshots are kept in data centres inside the EU.' },
      { title: 'Plans per project', text: 'Accounts are free. Each project has its own plan: Free, Starter or Studio. Invite as many people as you like.',
        link: { label: 'See the project’s plan', path: (p) => `p/${p}/settings#plan` }, needs: 'edit' },
      { title: 'Statistics for virtual tours', text: 'Visits, time per room and a heatmap on the floor plan for Intus tours.' },
      { title: 'Let your AI read the statistics', text: 'Create a read-only key in the project’s settings and connect Claude or another agent.',
        link: { label: 'Create a key', path: (p) => `p/${p}/settings#agents` }, needs: 'agents' },
    ],
  },
];

export const latestRelease = () => RELEASES[0] ?? null;

export type NewsView = { id: string; label: string; items: { title: string; text: string; href?: string; linkLabel?: string }[] };

/** The note to show this person now, or null. People who joined after a release never see it. */
export async function newsFor(user: User | null, projects: Project[]): Promise<NewsView | null> {
  const r = latestRelease();
  if (!user || !r || user.news_seen === r.id || user.created >= r.from) return null;
  const editable = projects.filter((p) => p.access === 'pro');
  let agentProject: string | null = null;
  for (const p of editable.slice(0, 8)) { if ((await planState(p.id)).limits.agents) { agentProject = p.id; break; } }
  const items: NewsView['items'] = [];
  for (const it of r.items) {
    if (it.needs === 'agents' && !agentProject) continue;
    const target = it.needs === 'agents' ? agentProject : editable[0]?.id ?? null;
    const linked = it.link && target;
    items.push({ title: it.title, text: it.text, ...(linked ? { href: url(it.link!.path(target!)), linkLabel: it.link!.label } : {}) });
  }
  return items.length ? { id: r.id, label: r.label, items } : null;
}

export async function markNewsSeen(userId: string) {
  const r = latestRelease();
  if (r) await db().prepare('UPDATE users SET news_seen = ? WHERE id = ?').bind(r.id, userId).run();
}
