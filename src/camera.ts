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
// After clicking something that then disappeared (a modal's submit button, a menu
// item), zoom out quickly so viewers see what the click did.
const FLEETING_HOLD = 0.45;
// Spring stiffness: higher settles faster. Critically damped, so no wobble.
const STIFFNESS = 38;

interface Shot {
  t0: number;
  until: number;
  zoom: number;
  cx: number;
  cy: number;
}

// Turn focus events into camera shots. Actions that follow each other closely
// form one "scene" that shares a single zoom level, so the camera pans between
// them instead of pumping in and out on every step.
export function planShots(rec: Recording): Shot[] {
  const cuts = rec.events.filter((e) => e.kind === 'cut').map((e) => e.t);
  const shots: Shot[] = rec.events
    .filter((e) => e.kind === 'focus')
    .sort((a, b) => a.t0 - b.t0)
    .map((e) => {
      const nextCut = cuts.find((c) => c > e.t1) ?? Infinity;
      return {
        t0: e.t0,
        until: Math.min(e.t1 + (e.fleeting ? FLEETING_HOLD : HOLD), nextCut),
        zoom: e.zoom,
        cx: e.rect.x + e.rect.width / 2,
        cy: e.rect.y + e.rect.height / 2,
      };
    });

  let scene: Shot[] = [];
  const closeScene = () => {
    const zoom = Math.min(...scene.map((s) => s.zoom));
    for (const s of scene) s.zoom = zoom;
    scene = [];
  };
  for (const shot of shots) {
    const prev = scene[scene.length - 1];
    if (prev && shot.t0 - LEAD > prev.until) closeScene();
    scene.push(shot);
  }
  if (scene.length) closeScene();
  return shots;
}

function targetAt(shots: Shot[], viewport: { width: number; height: number }, t: number): Camera {
  let best: Shot | null = null;
  for (const s of shots) {
    if (t >= s.t0 - LEAD && t <= s.until && (!best || s.t0 > best.t0)) best = s;
  }
  return best ?? { zoom: 1, cx: viewport.width / 2, cy: viewport.height / 2 };
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
  const shots = planShots(rec);
  const pos = { ...targetAt(shots, rec.viewport, rec.start) };
  const vel = { zoom: 0, cx: 0, cy: 0 };
  const out: Camera[] = [];

  for (let i = 0; i < frameCount; i++) {
    const target = clampToViewport(targetAt(shots, rec.viewport, rec.start + i * dt), rec.viewport);
    for (const k of ['zoom', 'cx', 'cy'] as const) {
      const accel = STIFFNESS * (target[k] - pos[k]) - damping * vel[k];
      vel[k] += accel * dt;
      pos[k] += vel[k] * dt;
    }
    out.push(clampToViewport({ zoom: Math.max(1, pos.zoom), cx: pos.cx, cy: pos.cy }, rec.viewport));
  }
  return out;
}
