import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDuration, parseScript, ScriptError } from '../src/script.js';

const parse = (yaml: string) => parseScript(yaml, '/tmp');

describe('parsing scripts', () => {
  it('reads targets written as plain text or with in/nth', () => {
    const s = parse(`
url: https://example.com
steps:
  - click: Save
  - click: { text: Save, in: Settings }
  - hover: { text: Save, nth: 2 }
  - type: { into: { text: Email, in: Login }, text: a@b.co }
`);
    assert.deepEqual(s.steps, [
      { action: 'click', target: { text: 'Save' } },
      { action: 'click', target: { text: 'Save', in: 'Settings', nth: undefined } },
      { action: 'hover', target: { text: 'Save', in: undefined, nth: 2 } },
      { action: 'type', text: 'a@b.co', into: { text: 'Email', in: 'Login', nth: undefined } },
    ]);
  });

  it('reads captions with and without a duration', () => {
    const s = parse(`
url: https://example.com
steps:
  - say: Hello
  - say: { text: Bye, for: 2s }
`);
    assert.deepEqual(s.steps, [
      { action: 'say', text: 'Hello' },
      { action: 'say', text: 'Bye', ms: 2000 },
    ]);
  });

  it('resolves goto paths against the start url', () => {
    const s = parse(`
url: http://localhost:3000/app
steps:
  - goto: /settings
`);
    assert.deepEqual(s.steps[0], { action: 'goto', url: 'http://localhost:3000/settings' });
  });

  it('accepts hide as a single selector or a list', () => {
    assert.deepEqual(parse('url: x.com\nhide: .cookie\nsteps: [{ wait: 1s }]').hide, ['.cookie']);
    assert.deepEqual(parse('url: x.com\nhide: [.a, "#b"]\nsteps: [{ wait: 1s }]').hide, ['.a', '#b']);
  });

  it('gives helpful errors', () => {
    assert.throws(() => parse('steps: []'), /needs a "url:"/);
    assert.throws(() => parse('url: x.com\nsteps: [{ clik: Save }]'), /unknown action "clik"/);
    assert.throws(() => parse('url: x.com\nsteps: [{ click: { text: Save, nth: 0 } }]'), /nth should be 1, 2, 3/);
    assert.throws(() => parse('url: x.com\nsteps: [{ scroll: lots }]'), ScriptError);
  });

  it('parses durations', () => {
    assert.equal(parseDuration('500ms', ''), 500);
    assert.equal(parseDuration('1.5s', ''), 1500);
    assert.equal(parseDuration(250, ''), 250);
    assert.throws(() => parseDuration('soon', 'step 1'), /step 1/);
  });
});
