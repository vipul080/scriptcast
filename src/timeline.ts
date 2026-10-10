// Shared types for what happened during a recording. All times are in seconds
// on the same clock as the screencast frame timestamps.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TimelineEvent =
  | { kind: 'move'; t0: number; t1: number; from: Point; to: Point }
  | { kind: 'click'; t: number; at: Point }
  // Something worth zooming in on, e.g. the button being clicked or the input being typed into.
  // fleeting: the target disappeared after the action (e.g. a modal closed), so don't linger on it.
  | { kind: 'focus'; t0: number; t1: number; rect: Rect; zoom: number; fleeting?: boolean }
  // The page jumped (scroll / navigation), so any zoom target is stale.
  | { kind: 'cut'; t: number }
  // On-screen caption. Without an explicit duration it stays until the next caption.
  | { kind: 'caption'; t: number; text: string; ms?: number };

export interface Frame {
  t: number;
  data: Buffer;
}

export interface Recording {
  frames: Frame[];
  events: TimelineEvent[];
  start: number;
  end: number;
  viewport: { width: number; height: number };
  cursorStart: Point;
  // Phone recordings: height of the status bar drawn above the page, in CSS pixels.
  statusBar?: number;
}

export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Where the cursor is a fraction k (0..1, already eased) of the way along a move.
// Hands don't move in straight lines, so the path bends gently: a quadratic curve
// whose control point sits a little to the side of the midpoint.
export function pathPoint(from: Point, to: Point, k: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bend = 0.12 * (dx >= 0 ? -1 : 1); // arc upward when moving right, downward when moving left
  const c = { x: from.x + dx / 2 - dy * bend, y: from.y + dy / 2 + dx * bend };
  const a = (1 - k) * (1 - k);
  const b = 2 * (1 - k) * k;
  const d = k * k;
  return { x: a * from.x + b * c.x + d * to.x, y: a * from.y + b * c.y + d * to.y };
}

export function cursorAt(rec: Recording, t: number): Point {
  let pos = rec.cursorStart;
  for (const e of rec.events) {
    if (e.kind !== 'move' || e.t0 > t) continue;
    pos = t >= e.t1 ? e.to : pathPoint(e.from, e.to, easeInOut((t - e.t0) / (e.t1 - e.t0)));
  }
  return pos;
}
