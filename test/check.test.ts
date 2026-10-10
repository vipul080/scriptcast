import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { check } from '../src/recorder.js';
import { parseScript } from '../src/script.js';

const dir = dirname(fileURLToPath(new URL('./fixtures/tricky.html', import.meta.url)));
const script = (steps: string, extra = '') => parseScript(`url: ./tricky.html\n${extra}\nsteps:\n${steps}`, dir);

describe('scriptcast check', () => {
  it('runs a script that scrolls, waits and types', async () => {
    const log: string[] = [];
    const result = await check(
      script(`
  - waitFor: Loaded later
  - type: { into: Email, text: ada@example.com }
  - click: { text: Save, in: Settings }
  - waitFor: Clicked save-settings
  - click: Way down here
  - waitFor: Clicked far
  - say: Done
`, 'hide: .cookie-banner'),
      { log: (m) => log.push(m) },
    );
    assert.equal(result.warnings, 0, log.join('\n'));
  });

  it('warns when a target is ambiguous', async () => {
    const log: string[] = [];
    const result = await check(script('  - click: Save'), { log: (m) => log.push(m) });
    assert.equal(result.warnings, 1);
    assert.match(log.join('\n'), /2 things match "Save"/);
  });

  it('reports which step failed', async () => {
    await assert.rejects(check(script('  - wait: 10ms\n  - click: Nope')), /Step 2 \(click "Nope"\) failed: couldn't find/);
  });

  it('explains when something covers the target', async () => {
    await assert.rejects(check(script('  - click: Way down here')), /covered by another element \(\.cookie-banner\)\. Hide it by adding this to your script:  hide: \["\.cookie-banner"\]/);
  });

  it('runs a script as a phone', async () => {
    await check(script('  - type: { into: Email, text: a@b.co }\n  - click: { text: Save, in: Settings }', 'device: iphone\nhide: .cookie-banner'));
  });

  it('hides elements listed under hide', async () => {
    await assert.rejects(check(script('  - click: Accept all', 'hide: .cookie-banner')), /couldn't find/);
  });
});
