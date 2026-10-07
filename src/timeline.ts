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
  | { kind: 'focus'; t0: number; t1: number; rect: Rect; zoom: number }
  // The page jumped (scroll / navigation), so any zoom target is stale.
  | { kind: 'cut'; t: number };

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
}

export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function cursorAt(rec: Recording, t: number): Point {
  let pos = rec.cursorStart;
  for (const e of rec.events) {
    if (e.kind !== 'move' || e.t0 > t) continue;
    if (t >= e.t1) {
      pos = e.to;
    } else {
      const k = easeInOut((t - e.t0) / (e.t1 - e.t0));
      pos = { x: e.from.x + (e.to.x - e.from.x) * k, y: e.from.y + (e.to.y - e.from.y) * k };
    }
  }
  return pos;
}
