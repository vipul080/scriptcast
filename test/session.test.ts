import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { check } from '../src/recorder.js';
import { parseScript } from '../src/script.js';

const page = readFileSync(new URL('./fixtures/login.html', import.meta.url), 'utf8');
let server: Server;
let url: string;
const dir = mkdtempSync(join(tmpdir(), 'scriptcast-session-'));

before(async () => {
  server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const script = (setup: string) =>
  parseScript(
    `url: ${url}
session: session.json
setup:
${setup}
steps:
  - click: Welcome back
`,
    dir,
    { TEST_PASSWORD: 'correct horse' },
  );

describe('setup and sessions', () => {
  it('runs setup off camera, then records logged in, and saves the session', async () => {
    const log: string[] = [];
    await check(
      script(`  - type: { into: Email, text: ada@example.com }
  - type: { into: Password, text: "\${TEST_PASSWORD}" }
  - click: Sign in
  - waitFor: Dashboard`),
      { log: (m) => log.push(m) },
    );
    assert.ok(existsSync(join(dir, 'session.json')), 'session file should be saved');
    assert.match(log.join('\n'), /setup \(not recorded\)/);
  });

  it('reuses a saved session and skips setup', async () => {
    const log: string[] = [];
    // This setup would fail if it ran, so passing proves it was skipped.
    await check(script('  - click: Button that does not exist'), { log: (m) => log.push(m) });
    assert.match(log.join('\n'), /using saved session/);
  });

  it('labels failing setup steps', async () => {
    rmSync(join(dir, 'session.json'));
    await assert.rejects(check(script('  - wait: 10ms\n  - click: Nope')), /Setup step 2 \(click "Nope"\) failed/);
  });
});
