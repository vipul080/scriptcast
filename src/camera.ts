import { clamp, type Recording } from './timeline.js';

export interface Camera {
  zoom: number;
  // Center of the view, in page (CSS pixel) coordinates.
  cx: number;
  cy: number;
}

// How long before an action the camera starts moving in, and how long it lingers after.
const LEAD = 0.25;
const HOLD = 1.6;
// Spring stiffness: higher settles faster. Critically damped, so no wobble.
const STIFFNESS = 38;

function targetAt(rec: Recording, t: number): Camera {
  const { width, height } = rec.viewport;
  const overview: Camera = { zoom: 1, cx: width / 2, cy: height / 2 };
  const cuts = rec.events.filter((e) => e.kind === 'cut').map((e) => e.t);

  let best: Camera | null = null;
  let bestStart = -Infinity;
  for (const e of rec.events) {
    if (e.kind !== 'focus') continue;
    const nextCut = cuts.find((c) => c > e.t1) ?? Infinity;
    const until = Math.min(e.t1 + HOLD, nextCut);
    if (t >= e.t0 - LEAD && t <= until && e.t0 > bestStart) {
      bestStart = e.t0;
      best = { zoom: e.zoom, cx: e.rect.x + e.rect.width / 2, cy: e.rect.y + e.rect.height / 2 };
    }
  }
  return best ?? overview;
}

export function clampToViewport(cam: Camera, viewport: { width: number; height: number }): Camera {
  const halfW = viewport.width / cam.zoom / 2;
  const halfH = viewport.height / cam.zoom / 2;
  return {
    zoom: cam.zoom,
    cx: clamp(cam.cx, halfW, viewport.width - halfW),
    cy: clamp(cam.cy, halfH, viewport.height - halfH),
  };
}

// One camera state per output frame, smoothed with a critically damped spring.
export function trackCamera(rec: Recording, fps: number, frameCount: number): Camera[] {
  const dt = 1 / fps;
  const damping = 2 * Math.sqrt(STIFFNESS);
  const first = targetAt(rec, rec.start);
  const pos = { ...first };
  const vel = { zoom: 0, cx: 0, cy: 0 };
  const out: Camera[] = [];

  for (let i = 0; i < frameCount; i++) {
    const target = clampToViewport(targetAt(rec, rec.start + i * dt), rec.viewport);
    for (const k of ['zoom', 'cx', 'cy'] as const) {
      const accel = STIFFNESS * (target[k] - pos[k]) - damping * vel[k];
      vel[k] += accel * dt;
      pos[k] += vel[k] * dt;
    }
    out.push(clampToViewport({ zoom: Math.max(1, pos.zoom), cx: pos.cx, cy: pos.cy }, rec.viewport));
  }
  return out;
}
