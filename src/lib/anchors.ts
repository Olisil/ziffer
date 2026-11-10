// Click anchors for the page-picture viewer: which element a click hit and where inside it.
// Selectors repeat a lot, so they are sent once and referred to by index.
type C = { sel?: string | null; ei?: number | null; ex?: number | null; ey?: number | null };
export type Anchor = [number, number, number, number] | null; // selector index, element index (-1 unknown), ex, ey (-1 unknown)
export function anchorsOf(clicks: C[]) {
  const sels: string[] = [], idx = new Map<string, number>();
  const anchors: Anchor[] = clicks.map((c) => {
    if (!c.sel) return null;
    let i = idx.get(c.sel);
    if (i === undefined) { i = sels.length; sels.push(c.sel); idx.set(c.sel, i); }
    return [i, c.ei ?? -1, c.ex ?? -1, c.ey ?? -1];
  });
  return { sels, anchors };
}
