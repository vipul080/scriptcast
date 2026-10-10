import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ClickCapture, type RawStep } from '../src/studio/capture.js';

const dashboard = pathToFileURL(new URL('../examples/dashboard/index.html', import.meta.url).pathname).href;

describe('recording clicks', () => {
  it('turns clicks and typing into human-style steps', async () => {
    const steps: RawStep[] = [];
    let ended = '';
    const capture = new ClickCapture((s) => steps.push(s), (reason) => (ended = reason));
    const page = await capture.start(dashboard, { width: 1280, height: 800 }, () => {}, true);

    await page.getByRole('button', { name: 'New report' }).click();
    await page.locator('#name').pressSequentially('Weekly active users');
    await page.getByRole('button', { name: 'Active users' }).click();
    await page.getByText('Email me every Monday').click();
    await page.getByRole('button', { name: 'Create report' }).click();
    await page.waitForTimeout(200);
    await capture.stop();

    assert.deepEqual(steps, [
      { click: 'New report' },
      { type: { into: 'Report name', text: 'Weekly active users' } },
      { click: 'Active users' },
      { click: 'Email me every Monday' },
      { click: 'Create report' },
    ]);
    assert.equal(ended, 'stopped');
  });

  it('records Enter and never captures real passwords', async () => {
    const steps: RawStep[] = [];
    const capture = new ClickCapture((s) => steps.push(s), () => {});
    const form = 'data:text/html,<label>Password <input id="pw" type="password"></label>';
    const page = await capture.start(form, { width: 800, height: 600 }, () => {}, true);
    await page.locator('#pw').pressSequentially('hunter2');
    await page.locator('#pw').press('Enter');
    await page.waitForTimeout(200);
    await capture.stop();
    assert.deepEqual(steps, [{ type: { into: 'Password', text: '${PASSWORD}' } }, { press: 'Enter' }]);
  });
});
