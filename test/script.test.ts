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

  it('reads GIF options with sensible defaults', () => {
    const defaults = parse('url: x.com\nsteps: [{ wait: 1s }]').output;
    assert.deepEqual([defaults.gifWidth, defaults.gifFps, defaults.gifColors], [960, 15, 256]);
    const custom = parse('url: x.com\noutput: { gifWidth: 800, gifFps: 12, gifColors: 4000 }\nsteps: [{ wait: 1s }]').output;
    assert.deepEqual([custom.gifWidth, custom.gifFps, custom.gifColors], [800, 12, 256], 'colors are capped at 256');
  });

  it('fills in ${VARS} from the environment', () => {
    const s = parseScript('url: x.com\nsteps:\n  - type: "${PASSWORD}"\n  - type: "$${LITERAL}"', '/tmp', { PASSWORD: 'hunter2' });
    assert.deepEqual(s.steps, [
      { action: 'type', text: 'hunter2' },
      { action: 'type', text: '${LITERAL}' },
    ]);
    assert.throws(() => parseScript('url: x.com\nsteps: [{ type: "${MISSING}" }]', '/tmp', {}), /environment variable MISSING is not set/);
  });

  it('reads setup steps and the session path', () => {
    const s = parseScript('url: x.com\nsession: .auth/s.json\nsetup: [{ click: Sign in }]\nsteps: [{ wait: 1s }]', '/proj');
    assert.deepEqual(s.setup, [{ action: 'click', target: { text: 'Sign in' } }]);
    assert.equal(s.session, '/proj/.auth/s.json');
    assert.throws(() => parse('url: x.com\nsetup: [{ clik: x }]\nsteps: [{ wait: 1s }]'), /setup step 1: unknown action/);
  });

  it('records as a phone with device: iphone', () => {
    const s = parse('url: x.com\ndevice: iphone\nsteps: [{ wait: 1s }]');
    assert.equal(s.device?.name, 'iPhone');
    assert.deepEqual(s.viewport, { width: 393, height: 798 });
    assert.equal(s.output.window, 'phone');
    assert.deepEqual([s.output.width, s.output.height], [1080, 1920], 'phone videos are portrait');
    assert.throws(() => parse('url: x.com\ndevice: nokia\nsteps: [{ wait: 1s }]'), /Unknown device "nokia"/);
  });

  it('reads the window style', () => {
    assert.equal(parse('url: x.com\nsteps: [{ wait: 1s }]').output.window, 'light');
    assert.equal(parse('url: x.com\noutput: { window: dark }\nsteps: [{ wait: 1s }]').output.window, 'dark');
    assert.throws(() => parse('url: x.com\noutput: { window: purple }\nsteps: [{ wait: 1s }]'), /output.window should be one of/);
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
