// Small presentation helpers shared by the session views.
export const flag = (cc: string | null) =>
  cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';

const REGION = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
export const countryName = (cc: string | null) => { try { return cc ? REGION?.of(cc) ?? cc : ''; } catch { return cc ?? ''; } };

export const ago = (ts: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return '';
};

export const dayLabel = (ts: number, now = Date.now()) => {
  const d = (t: number) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  if (d(ts) === d(now)) return 'Today';
  if (d(ts) === d(now - 864e5)) return 'Yesterday';
  return new Date(ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Stockholm' });
};

export type Signal = { key: 'rage' | 'dead' | 'bounce' | 'engaged' | 'deep'; label: string };
export function signalsOf(s: { rage: number; dead?: number; pageviews: number; duration: number }, maxScroll = 0): Signal[] {
  const out: Signal[] = [];
  if (s.rage) out.push({ key: 'rage', label: s.rage === 1 ? 'Rage click' : `${s.rage} rage clicks` });
  if ((s.dead ?? 0) >= 1) out.push({ key: 'dead', label: s.dead === 1 ? 'Dead click' : `${s.dead} dead clicks` });
  if (s.pageviews <= 1 && s.duration < 10) out.push({ key: 'bounce', label: 'Quick exit' });
  if (s.duration >= 60 || maxScroll >= 75) out.push({ key: 'engaged', label: s.duration >= 60 ? 'Engaged' : 'Read to the end' });
  return out;
}
