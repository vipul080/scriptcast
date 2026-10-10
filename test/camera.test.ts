import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planShots } from '../src/camera.js';
import { pathPoint, type Recording, type TimelineEvent } from '../src/timeline.js';

const rect = { x: 100, y: 100, width: 50, height: 20 };
const rec = (events: TimelineEvent[]): Recording => ({
  frames: [],
  events,
  start: 0,
  end: 30,
  viewport: { width: 1280, height: 800 },
  cursorStart: { x: 0, y: 0 },
});

describe('camera', () => {
  it('keeps one zoom level for actions that follow each other closely', () => {
    const shots = planShots(rec([
      { kind: 'focus', t0: 1, t1: 2, rect, zoom: 2 },
      { kind: 'focus', t0: 2.5, t1: 3, rect, zoom: 1.4 },
      { kind: 'focus', t0: 3.5, t1: 4, rect, zoom: 1.8 },
    ]));
    assert.deepEqual(shots.map((s) => s.zoom), [1.4, 1.4, 1.4]);
  });

  it('starts a new scene after a pause', () => {
    const shots = planShots(rec([
      { kind: 'focus', t0: 1, t1: 2, rect, zoom: 2 },
      { kind: 'focus', t0: 10, t1: 11, rect, zoom: 1.5 },
    ]));
    assert.deepEqual(shots.map((s) => s.zoom), [2, 1.5]);
  });

  it('pulls back quickly when the clicked thing disappeared', () => {
    const [stays, gone] = planShots(rec([
      { kind: 'focus', t0: 1, t1: 2, rect, zoom: 2 },
      { kind: 'focus', t0: 10, t1: 11, rect, zoom: 2, fleeting: true },
    ]));
    assert.ok(stays.until - 2 > 1, 'normal targets linger');
    assert.ok(gone.until - 11 < 0.5, 'vanished targets do not');
  });

  it('moves the cursor along a gentle curve that starts and ends on target', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    assert.deepEqual(pathPoint(from, to, 0), from);
    assert.deepEqual(pathPoint(from, to, 1), to);
    const mid = pathPoint(from, to, 0.5);
    assert.ok(mid.y < -1 && mid.y > -10, `bends a little, got y=${mid.y}`);
  });
});
