import { chromium, type Locator, type Page } from 'playwright';
import type { Script, Step } from './script.js';
import { clamp, easeInOut, type Frame, type Point, type Recording, type Rect, type TimelineEvent } from './timeline.js';

const DEVICE_SCALE = 2;
const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StepError extends Error {}

function describe(step: Step): string {
  switch (step.action) {
    case 'goto': return `goto ${step.url}`;
    case 'click':
    case 'hover': return `${step.action} "${step.target}"`;
    case 'type': return step.into ? `type into "${step.into}"` : `type "${step.text}"`;
    case 'press': return `press ${step.key}`;
    case 'wait': return `wait ${step.ms}ms`;
    case 'scroll': return `scroll ${step.by}`;
  }
}

// Targets are matched the way a person would describe them: button/link text,
// a field's label or placeholder, or any visible text. CSS selectors also work.
function locate(page: Page, target: string): Locator {
  const looksLikeSelector = /^[#.[]|^[a-z][\w-]*[#.[:>]|^(css|xpath|text)=|^\/\//i.test(target);
  if (looksLikeSelector) return page.locator(target).first();
  return page
    .getByRole('button', { name: target })
    .or(page.getByRole('link', { name: target }))
    .or(page.getByLabel(target))
    .or(page.getByPlaceholder(target))
    .or(page.getByText(target))
    .first();
}

class Session {
  events: TimelineEvent[] = [];
  cursor: Point;

  constructor(private page: Page, private viewport: { width: number; height: number }) {
    this.cursor = { x: viewport.width * 0.55, y: viewport.height * 0.62 };
  }

  private zoomFor(rect: Rect): number {
    const { width, height } = this.viewport;
    return clamp(Math.min((width * 0.45) / rect.width, (height * 0.45) / rect.height), 1.4, 2);
  }

  private async scrollY(): Promise<number> {
    return this.page.evaluate(() => window.scrollY);
  }

  private async find(target: string): Promise<{ rect: Rect; center: Point }> {
    const loc = locate(this.page, target);
    try {
      await loc.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      throw new StepError(`couldn't find anything on the page matching "${target}"`);
    }
    const before = await this.scrollY();
    await loc.scrollIntoViewIfNeeded();
    if ((await this.scrollY()) !== before) this.events.push({ kind: 'cut', t: now() });
    const rect = await loc.boundingBox();
    if (!rect) throw new StepError(`"${target}" is on the page but has no size`);
    return { rect, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  }

  // Glide the real mouse along the same eased path the renderer will draw,
  // so hover effects line up with the drawn cursor.
  private async moveTo(to: Point): Promise<{ t0: number; t1: number }> {
    const from = { ...this.cursor };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const t0 = now();
    if (dist < 2) return { t0, t1: t0 };
    const dur = clamp(0.35 + dist * 0.0007, 0.45, 1.0);
    for (;;) {
      const k = Math.min(1, (now() - t0) / dur);
      const e = easeInOut(k);
      await this.page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      if (k >= 1) break;
      await sleep(12);
    }
    const t1 = t0 + dur;
    this.events.push({ kind: 'move', t0, t1, from, to });
    this.cursor = to;
    return { t0, t1 };
  }

  private async clickTarget(target: string) {
    const { rect, center } = await this.find(target);
    const { t0 } = await this.moveTo(center);
    await sleep(140);
    const tClick = now();
    await this.page.mouse.down();
    await sleep(90);
    await this.page.mouse.up();
    this.events.push({ kind: 'click', t: tClick, at: center });
    this.events.push({ kind: 'focus', t0, t1: now(), rect, zoom: this.zoomFor(rect) });
  }

  async run(step: Step) {
    const page = this.page;
    switch (step.action) {
      case 'goto':
        this.events.push({ kind: 'cut', t: now() });
        await page.goto(step.url, { waitUntil: 'load' });
        await sleep(700);
        break;
      case 'click':
        await this.clickTarget(step.target);
        await page.waitForLoadState('load').catch(() => {});
        await sleep(550);
        break;
      case 'hover': {
        const { rect, center } = await this.find(step.target);
        const { t0 } = await this.moveTo(center);
        await sleep(500);
        this.events.push({ kind: 'focus', t0, t1: now(), rect, zoom: this.zoomFor(rect) });
        break;
      }
      case 'type': {
        if (step.into) {
          await this.clickTarget(step.into);
          await sleep(200);
        }
        const rect = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        const t0 = now();
        await page.keyboard.type(step.text, { delay: 65 });
        if (rect) this.events.push({ kind: 'focus', t0, t1: now(), rect, zoom: this.zoomFor(rect) });
        await sleep(350);
        break;
      }
      case 'press':
        await page.keyboard.press(step.key);
        await sleep(550);
        break;
      case 'wait':
        await sleep(step.ms);
        break;
      case 'scroll':
        this.events.push({ kind: 'cut', t: now() });
        await page.evaluate((by) => window.scrollBy({ top: by, behavior: 'smooth' }), step.by);
        await sleep(900);
        break;
    }
  }
}

export async function record(
  script: Script,
  opts: { headed?: boolean; log?: (msg: string) => void } = {},
): Promise<Recording> {
  const log = opts.log ?? (() => {});
  const browser = await chromium.launch({ headless: !opts.headed });
  try {
    const context = await browser.newContext({ viewport: script.viewport, deviceScaleFactor: DEVICE_SCALE });
    const page = await context.newPage();
    await page.goto(script.url, { waitUntil: 'load' });

    const session = new Session(page, script.viewport);
    const cursorStart = { ...session.cursor };
    await page.mouse.move(cursorStart.x, cursorStart.y);

    const frames: Frame[] = [];
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', (f) => {
      frames.push({ t: f.metadata.timestamp ?? now(), data: Buffer.from(f.data, 'base64') });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 95,
      maxWidth: script.viewport.width * DEVICE_SCALE,
      maxHeight: script.viewport.height * DEVICE_SCALE,
    });

    const start = now();
    await sleep(600);
    for (const [i, step] of script.steps.entries()) {
      log(`  ${i + 1}/${script.steps.length}  ${describe(step)}`);
      try {
        await session.run(step);
      } catch (err) {
        const reason = err instanceof StepError ? err.message : (err as Error).message.split('\n')[0];
        throw new StepError(`Step ${i + 1} (${describe(step)}) failed: ${reason}`);
      }
    }
    await sleep(1200);
    const end = now();
    await cdp.send('Page.stopScreencast').catch(() => {});

    if (frames.length === 0) throw new Error('The browser did not produce any frames');
    frames.sort((a, b) => a.t - b.t);
    return { frames, events: session.events, start, end, viewport: script.viewport, cursorStart };
  } finally {
    await browser.close();
  }
}
