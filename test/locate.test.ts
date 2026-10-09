import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { find, findOnce } from '../src/locate.js';
import type { Target } from '../src/script.js';

const fixture = pathToFileURL(new URL('./fixtures/tricky.html', import.meta.url).pathname).href;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(fixture);
});
after(() => browser.close());

async function idOf(target: Target) {
  const match = await findOnce(page, target);
  assert.ok(match, `expected to find ${JSON.stringify(target)}`);
  return { id: await match.locator.getAttribute('id'), count: match.count, tag: await match.locator.evaluate((el) => el.tagName) };
}

describe('finding elements', () => {
  it('prefers an exact button over a heading or link that contains the text', async () => {
    const { tag, count } = await idOf({ text: 'Save' });
    assert.equal(tag, 'BUTTON');
    assert.equal(count, 2, 'two visible exact "Save" buttons should be reported as ambiguous');
  });

  it('picks the match nearest to the "in" text', async () => {
    assert.equal((await idOf({ text: 'Save', in: 'Settings' })).id, 'save-settings');
    assert.equal((await idOf({ text: 'Save', in: 'Profile' })).id, 'save-profile');
  });

  it('accepts a CSS selector as the "in" scope', async () => {
    assert.equal((await idOf({ text: 'Save', in: '#settings' })).id, 'save-settings');
  });

  it('picks the Nth match', async () => {
    assert.equal((await idOf({ text: 'Save', nth: 2 })).id, 'save-settings');
    await assert.rejects(findOnce(page, { text: 'Save', nth: 5 }), /only found 2/);
  });

  it('ignores hidden elements', async () => {
    assert.notEqual((await idOf({ text: 'Save', nth: 2 })).id, 'hidden-save');
  });

  it('falls back to partial matches when nothing matches exactly', async () => {
    assert.equal((await idOf({ text: 'changes' })).id, 'save-changes');
  });

  it('finds fields by label or placeholder', async () => {
    assert.equal((await idOf({ text: 'Email' })).id, 'email');
    assert.equal((await idOf({ text: 'Your name' })).tag, 'INPUT');
  });

  it('accepts CSS selectors as the target', async () => {
    assert.equal((await idOf({ text: '#save-changes' })).id, 'save-changes');
  });

  it('waits for elements that appear later', async () => {
    const match = await find(page, { text: 'Loaded later' }, 5000);
    assert.equal(await match.locator.getAttribute('id'), 'late');
  });

  it('explains what it could not find', async () => {
    await assert.rejects(find(page, { text: 'Delete everything' }, 300), /couldn't find anything on the page matching "Delete everything"/);
  });
});
