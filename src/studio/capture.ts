import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { launch } from '../recorder.js';

// A step in the same shape as the YAML, e.g. { click: 'Save' }.
export type RawStep = Record<string, unknown>;

// The in-page recorder lives in a plain .js file so no build tool ever rewrites it:
// it runs inside the website, where helpers added by compilers don't exist.
const PAGE_RECORDER = fileURLToPath(new URL('../../studio/capture-page.js', import.meta.url));

export class ClickCapture {
  private browser: Browser | null = null;
  private stopped = false;

  constructor(
    private onStep: (step: RawStep) => void,
    private onEnd: (reason: 'closed' | 'stopped' | 'error', message?: string) => void,
  ) {}

  // Opens a visible browser window for the user to click around in. Returns the page
  // (tests drive it directly with headless: true).
  async start(url: string, viewport: { width: number; height: number }, log: (msg: string) => void, headless = false): Promise<Page> {
    this.browser = await launch(!headless, log);
    const context = await this.browser.newContext({ viewport });
    let lastAction = Date.now();
    await context.exposeBinding('__scriptcastStep', (_source, step: RawStep) => {
      lastAction = Date.now();
      this.onStep(step);
    });
    await context.addInitScript({ path: PAGE_RECORDER });
    const page: Page = await context.newPage();

    // A navigation that didn't come right after a click or key press was typed
    // into the address bar, so record it as a goto.
    let first = true;
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (first) {
        first = false;
        return;
      }
      if (Date.now() - lastAction > 1500) this.onStep({ goto: frame.url() });
    });
    page.on('close', () => this.finish('closed'));
    this.browser.on('disconnected', () => this.finish('closed'));

    try {
      await page.goto(url, { waitUntil: 'load' });
    } catch (err) {
      await this.stop();
      throw new Error(`Couldn't open ${url}. Is your app running? (${(err as Error).message.split('\n')[0]})`);
    }
    return page;
  }

  private finish(reason: 'closed' | 'stopped') {
    if (this.stopped) return;
    this.stopped = true;
    this.onEnd(reason);
    this.browser?.close().catch(() => {});
  }

  async stop() {
    this.finish('stopped');
  }
}
