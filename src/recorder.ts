import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { find, NotFound, type Match } from './locate.js';
import { describeTarget, type Script, type Step, type Target } from './script.js';
import { clamp, easeInOut, type Frame, type Point, type Recording, type Rect, type TimelineEvent } from './timeline.js';

const DEVICE_SCALE = 2;
const FIND_TIMEOUT = 10_000;
const WAIT_FOR_TIMEOUT = 30_000;
const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StepError extends Error {}

export function describe(step: Step): string {
  switch (step.action) {
    case 'goto': return `goto ${step.url}`;
    case 'click':
    case 'hover': return `${step.action} ${describeTarget(step.target)}`;
    case 'waitFor': return `wait for ${describeTarget(step.target)}`;
    case 'type': return step.into ? `type into ${describeTarget(step.into)}` : `type "${step.text}"`;
    case 'press': return `press ${step.key}`;
    case 'wait': return `wait ${step.ms}ms`;
    case 'scroll': return `scroll ${step.by}`;
    case 'say': return `say "${step.text}"`;
  }
}

export interface RunOptions {
  // Skip animations and shorten pauses. Used by `scriptcast check`.
  fast?: boolean;
  // Recording as a phone: gentler zoom.
  mobile?: boolean;
  headed?: boolean;
  log?: (msg: string) => void;
}

interface SessionOptions extends RunOptions {
  applyHide?: () => Promise<void>;
}

// Runs in the page: returns a CSS selector for whatever sits on top of `el` at
// point (x, y), e.g. a cookie banner, or null if the point really hits `el`.
function coveredBy(el: Element, { x, y }: { x: number; y: number }): string | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
  if (hit instanceof HTMLLabelElement && hit.control === el) return null;
  // Name the overlay itself (the fixed/sticky container), not some text inside it.
  let overlay: Element = hit;
  for (let n: Element | null = hit; n; n = n.parentElement) {
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'sticky') {
      overlay = n;
      break;
    }
  }
  if (overlay.id) return `#${overlay.id}`;
  if (overlay.classList.length) return `.${overlay.classList[0]}`;
  return overlay.tagName.toLowerCase();
}

const BOT_CHECK_MESSAGE =
  'this site is showing a "verify you are human" check to automated browsers, so scriptcast can\'t record it. ' +
  'Record your own app instead (localhost or a staging URL).';

async function isBotCheck(page: Page): Promise<boolean> {
  const text = await page
    .evaluate(() => `${document.title}\n${document.body?.innerText.slice(0, 2000) ?? ''}`)
    .catch(() => '');
  return /just a moment|verify(ing)? you are (a )?human|security verification|are you a robot|captcha/i.test(text);
}

class Session {
  events: TimelineEvent[] = [];
  warnings = 0;
  cursor: Point;
  private fast: boolean;
  private mobile: boolean;
  private log: (msg: string) => void;
  private applyHide: () => Promise<void>;

  constructor(private page: Page, private viewport: { width: number; height: number }, opts: SessionOptions) {
    this.cursor = { x: viewport.width * 0.55, y: viewport.height * 0.62 };
    this.fast = opts.fast ?? false;
    this.mobile = opts.mobile ?? false;
    this.log = opts.log ?? (() => {});
    this.applyHide = opts.applyHide ?? (() => Promise.resolve());
  }

  private pause(ms: number) {
    return sleep(this.fast ? Math.min(ms * 0.1, 100) : ms);
  }

  private zoomFor(rect: Rect): number {
    const { width, height } = this.viewport;
    const ideal = Math.min((width * 0.45) / rect.width, (height * 0.45) / rect.height);
    // Phone screens are already small, so zoom in gently there.
    return this.mobile ? clamp(ideal, 1.15, 1.35) : clamp(ideal, 1.4, 2);
  }

  private async settle() {
    await this.page.waitForLoadState('load').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: this.fast ? 1500 : 4000 }).catch(() => {});
    await this.applyHide();
  }

  private async find(target: Target, timeout = FIND_TIMEOUT, interact = true): Promise<{ rect: Rect; center: Point }> {
    // Pages that re-render (React, SPAs) can swap the element out right after we
    // find it, so look it up again a few times before giving up.
    let match: Match | undefined;
    let rect: Rect | null = null;
    for (let attempt = 0; attempt < 5 && !rect; attempt++) {
      if (attempt > 0) await sleep(300);
      try {
        match = await find(this.page, target, attempt === 0 ? timeout : 2000);
      } catch (err) {
        if (await isBotCheck(this.page)) throw new StepError(BOT_CHECK_MESSAGE);
        throw err;
      }
      rect = await match.locator.boundingBox({ timeout: 1000 }).catch(() => null);
    }
    if (!match || !rect) throw new StepError(`${describeTarget(target)} keeps disappearing from the page`);
    if (match.count > 1) {
      this.warnings++;
      this.log(`       ⚠ ${match.count} things match ${describeTarget(target)}, using the first one. Add "in:" or "nth:" to pick a different one.`);
    }
    const loc = match.locator;

    // Bring off-screen elements into view with a smooth scroll instead of a jump.
    if (rect.y < 0 || rect.y + rect.height > this.viewport.height) {
      this.events.push({ kind: 'cut', t: now() });
      await loc.evaluate((el, smooth) => el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'instant' }), !this.fast);
      await this.waitForScrollToStop();
      rect = (await loc.boundingBox()) ?? rect;
    }
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };

    if (interact) {
      const blocker = await loc.evaluate(coveredBy, center);
      if (blocker) {
        throw new StepError(
          `${describeTarget(target)} is covered by another element (${blocker}). ` +
            `Hide it by adding this to your script:  hide: ["${blocker}"]`,
        );
      }
    }
    return { rect, center };
  }

  private async waitForScrollToStop() {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const y = await this.page.evaluate(() => window.scrollY);
      if (y === last) break;
      last = y;
      await sleep(this.fast ? 30 : 80);
    }
  }

  // Glide the real mouse along the same eased path the renderer will draw,
  // so hover effects line up with the drawn cursor.
  private async moveTo(to: Point): Promise<{ t0: number; t1: number }> {
    const from = { ...this.cursor };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const t0 = now();
    if (dist < 2) return { t0, t1: t0 };
    if (this.fast) {
      await this.page.mouse.move(to.x, to.y);
      this.cursor = to;
      return { t0, t1: t0 };
    }
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

  private async clickTarget(target: Target) {
    const { rect, center } = await this.find(target);
    const { t0 } = await this.moveTo(center);
    await this.pause(140);
    const tClick = now();
    await this.page.mouse.down();
    await this.pause(90);
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
        await this.settle();
        await this.pause(700);
        break;
      case 'click':
        await this.clickTarget(step.target);
        await this.settle();
        await this.pause(550);
        break;
      case 'hover': {
        const { rect, center } = await this.find(step.target);
        const { t0 } = await this.moveTo(center);
        await this.pause(500);
        this.events.push({ kind: 'focus', t0, t1: now(), rect, zoom: this.zoomFor(rect) });
        break;
      }
      case 'waitFor':
        await this.find(step.target, WAIT_FOR_TIMEOUT, false);
        await this.pause(300);
        break;
      case 'type': {
        if (step.into) {
          await this.clickTarget(step.into);
          await this.pause(200);
        }
        const rect = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        const t0 = now();
        await page.keyboard.type(step.text, { delay: this.fast ? 0 : 65 });
        if (rect) this.events.push({ kind: 'focus', t0, t1: now(), rect, zoom: this.zoomFor(rect) });
        await this.pause(350);
        break;
      }
      case 'press':
        await page.keyboard.press(step.key);
        await this.settle();
        await this.pause(550);
        break;
      case 'wait':
        await this.pause(step.ms);
        break;
      case 'scroll':
        this.events.push({ kind: 'cut', t: now() });
        await page.evaluate(([by, smooth]) => window.scrollBy({ top: by, behavior: smooth ? 'smooth' : 'instant' }), [step.by, !this.fast] as const);
        await this.waitForScrollToStop();
        await this.pause(300);
        break;
      case 'say':
        // Give viewers a moment to read before the action the caption describes.
        this.events.push({ kind: 'caption', t: now(), text: step.text, ms: step.ms });
        await this.pause(900);
        break;
    }
  }
}

export async function launch(headed: boolean, log: (msg: string) => void): Promise<Browser> {
  try {
    return await chromium.launch({ headless: !headed });
  } catch (err) {
    if (!/Executable doesn't exist|install/i.test((err as Error).message)) throw err;
    log('● First run: downloading the browser scriptcast uses (one time only)...');
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    // Headless recording only needs the small headless shell; --headed needs full Chromium.
    const args = headed ? ['install', 'chromium'] : ['install', '--only-shell', 'chromium'];
    const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Could not download the browser. Try: npx playwright install chromium');
    return chromium.launch({ headless: !headed });
  }
}

async function withPage<T>(script: Script, opts: RunOptions, fn: (page: Page, session: Session) => Promise<T>): Promise<T> {
  const log = opts.log ?? (() => {});
  const browser = await launch(opts.headed ?? false, log);
  try {
    const savedSession = script.session && existsSync(script.session) ? script.session : undefined;
    const context = await browser.newContext({
      viewport: script.viewport,
      deviceScaleFactor: script.device?.deviceScaleFactor ?? DEVICE_SCALE,
      ...(script.device && { userAgent: script.device.userAgent, isMobile: true, hasTouch: true }),
      storageState: savedSession,
    });
    const page = await context.newPage();
    const hideCss = script.hide.length ? `${script.hide.join(', ')} { display: none !important; }` : '';
    const applyHide = () => (hideCss ? page.addStyleTag({ content: hideCss }).then(() => {}, () => {}) : Promise.resolve());
    page.on('domcontentloaded', applyHide);

    const open = async () => {
      try {
        await page.goto(script.url, { waitUntil: 'load' });
      } catch (err) {
        throw new StepError(`Couldn't open ${script.url}. Is your app running? (${(err as Error).message.split('\n')[0]})`);
      }
      await page.waitForLoadState('networkidle', { timeout: opts.fast ? 1500 : 4000 }).catch(() => {});
      await applyHide();
    };
    await open();

    if (savedSession) {
      log(`  using saved session ${relative(process.cwd(), savedSession)} (delete it to run setup again)`);
    } else if (script.setup.length) {
      log('  setup (not recorded)');
      const setup = new Session(page, script.viewport, { ...opts, fast: true, applyHide, mobile: Boolean(script.device) });
      await runSteps(script.setup, setup, log, 'Setup step');
      if (script.session) {
        mkdirSync(dirname(script.session), { recursive: true });
        await context.storageState({ path: script.session });
        log(`  saved session to ${relative(process.cwd(), script.session)}`);
      }
      // Start the video from the script's url, now logged in.
      await open();
    }

    const session = new Session(page, script.viewport, { ...opts, applyHide, mobile: Boolean(script.device) });
    await page.mouse.move(session.cursor.x, session.cursor.y);
    try {
      return await fn(page, session);
    } catch (err) {
      if (savedSession && err instanceof StepError) {
        err.message += `\n  If your saved login expired, delete ${relative(process.cwd(), savedSession)} and run again.`;
      }
      throw err;
    }
  } finally {
    await browser.close();
  }
}

async function runSteps(steps: Step[], session: Session, log: (msg: string) => void, label = 'Step') {
  for (const [i, step] of steps.entries()) {
    log(`  ${String(i + 1).padStart(2)}/${steps.length}  ${describe(step)}`);
    try {
      await session.run(step);
    } catch (err) {
      const reason = err instanceof StepError || err instanceof NotFound ? err.message : (err as Error).message.split('\n')[0];
      throw new StepError(`${label} ${i + 1} (${describe(step)}) failed: ${reason}`);
    }
  }
}

// Run every step as fast as possible without recording, to catch broken scripts early.
export async function check(script: Script, opts: RunOptions = {}): Promise<{ warnings: number }> {
  const log = opts.log ?? (() => {});
  return withPage(script, { ...opts, fast: true }, async (_page, session) => {
    await runSteps(script.steps, session, log);
    return { warnings: session.warnings };
  });
}

export async function record(script: Script, opts: RunOptions = {}): Promise<Recording> {
  const log = opts.log ?? (() => {});
  return withPage(script, { ...opts, fast: false }, async (page, session) => {
    const cursorStart = { ...session.cursor };
    const frames: Frame[] = [];
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', (f) => {
      frames.push({ t: f.metadata.timestamp ?? now(), data: Buffer.from(f.data, 'base64') });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 95,
      maxWidth: Math.round(script.viewport.width * (script.device?.deviceScaleFactor ?? DEVICE_SCALE)),
      maxHeight: Math.round(script.viewport.height * (script.device?.deviceScaleFactor ?? DEVICE_SCALE)),
    });

    const start = now();
    await sleep(600);
    await runSteps(script.steps, session, log);
    await sleep(1200);
    const end = now();
    await cdp.send('Page.stopScreencast').catch(() => {});

    if (frames.length === 0) throw new Error('The browser did not produce any frames');
    frames.sort((a, b) => a.t - b.t);
    return { frames, events: session.events, start, end, viewport: script.viewport, cursorStart, statusBar: script.device?.statusBar };
  });
}
