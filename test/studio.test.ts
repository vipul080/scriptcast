import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startStudio } from '../src/studio/server.js';

const dashboard = pathToFileURL(new URL('../examples/dashboard/index.html', import.meta.url).pathname).href;
const dir = mkdtempSync(join(tmpdir(), 'scriptcast-studio-'));
const scriptFile = join(dir, 'demo.yml');

let studio: Awaited<ReturnType<typeof startStudio>>;
let browser: Browser;
let page: Page;

before(async () => {
  studio = await startStudio(scriptFile, { open: false, port: 0 });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(studio.link);
});
after(async () => {
  await browser.close();
  studio.close();
  rmSync(dir, { recursive: true, force: true });
});

const lastStepInput = () => page.locator('#steps li').last().locator('input').first();

describe('studio, used by someone starting from scratch', () => {
  it('starts with an empty, friendly editor', async () => {
    await page.getByText('No steps yet.').waitFor();
    assert.equal(await page.locator('#save-state').textContent(), 'New script');
  });

  it('builds a script with buttons and saves it as readable YAML', async () => {
    await page.locator('#url').fill(dashboard);
    await page.getByRole('button', { name: '+ Caption' }).first().click();
    await lastStepInput().fill('Make a report');
    await page.getByRole('button', { name: '+ Click' }).first().click();
    await lastStepInput().fill('New report');
    await page.locator('#save-state', { hasText: 'Saved' }).waitFor();

    const yaml = readFileSync(scriptFile, 'utf8');
    assert.match(yaml, new RegExp(`url: ${dashboard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(yaml, /- say: Make a report\n\s+- click: New report/);
  });

  it('checks the steps', async () => {
    await page.getByRole('button', { name: 'Check steps' }).click();
    await page.getByText('All steps work').waitFor({ timeout: 60_000 });
  });

  it('makes a video and plays it in the page', async () => {
    await page.getByRole('button', { name: 'Make video' }).click();
    await page.getByText('Your video is ready').waitFor({ timeout: 180_000 });
    const src = await page.locator('#video').getAttribute('src');
    const res = await page.request.get(new URL(src!, studio.link).href);
    assert.equal(res.status(), 200);
    assert.equal(res.headers()['content-type'], 'video/mp4');
    assert.ok((await res.body()).length > 10_000);
    assert.equal(await page.locator('#dl-gif').isVisible(), true, 'new scripts make a GIF by default');
  });

  it('switches the frame to an iPhone and back', async () => {
    await page.locator('#frame').selectOption('iphone');
    await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'Saved');
    await page.waitForTimeout(500);
    assert.match(readFileSync(scriptFile, 'utf8'), /device: iphone/);
    await page.locator('#frame').selectOption('dark');
    await page.waitForTimeout(800);
    const yaml = readFileSync(scriptFile, 'utf8');
    assert.doesNotMatch(yaml, /device:/);
    assert.match(yaml, /window: dark/);
  });

  it('refuses API calls without the secret token', async () => {
    const res = await page.request.get(new URL('/api/doc', studio.link).href);
    assert.equal(res.status(), 401);
  });
});
