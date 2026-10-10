import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, isMap, isSeq, parse } from 'yaml';
import { makeVideo, type VideoFiles } from '../pipeline.js';
import { check } from '../recorder.js';
import { loadScript, parseScript, resolveUrl } from '../script.js';
import { ClickCapture, type RawStep } from './capture.js';

const STATIC_DIR = fileURLToPath(new URL('../../studio/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.gif': 'image/gif',
};

const NEW_SCRIPT = {
  url: 'http://localhost:3000',
  displayUrl: 'localhost:3000',
  output: { file: 'demo.mp4', gif: true, background: 'aurora' },
  steps: [] as RawStep[],
};

type Doc = Record<string, any>;

// Write the script so it reads like a hand-written one: short steps on one line.
function toYaml(doc: Doc): string {
  const d = new Document(doc);
  const steps = d.get('steps');
  if (isSeq(steps)) {
    for (const item of steps.items) {
      if (!isMap(item)) continue;
      for (const pair of item.items) if (isMap(pair.value)) pair.value.flow = true;
    }
  }
  const viewport = d.get('viewport');
  if (isMap(viewport)) viewport.flow = true;
  return d.toString({ lineWidth: 0 });
}

// Validate without needing real secrets: every ${VAR} counts as set.
const anyEnv = new Proxy({}, { get: () => 'x' }) as Record<string, string>;

function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function revealFile(file: string) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', file]]
      : process.platform === 'win32'
        ? ['explorer', [`/select,${file}`]]
        : ['xdg-open', [dirname(file)]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function readBody(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

export async function startStudio(file: string, opts: { open?: boolean; port?: number } = {}) {
  const scriptPath = resolve(file);
  const token = randomBytes(16).toString('hex');
  const clients = new Set<ServerResponse>();
  let busy: string | null = null;
  let lastFiles: VideoFiles | null = null;
  let capture: ClickCapture | null = null;

  const broadcast = (event: Record<string, unknown>) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  };
  const log = (text: string) => broadcast({ type: 'log', text });

  const readDoc = (): Doc => (existsSync(scriptPath) ? (parse(readFileSync(scriptPath, 'utf8')) ?? {}) : structuredClone(NEW_SCRIPT));

  const validate = (doc: Doc): string | null => {
    try {
      parseScript(toYaml(doc), dirname(scriptPath), anyEnv);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  async function runJob(kind: string, job: () => Promise<Record<string, unknown> | void>) {
    busy = kind;
    broadcast({ type: 'start', kind });
    try {
      const result = (await job()) ?? {};
      broadcast({ type: 'done', kind, ...result });
    } catch (err) {
      broadcast({ type: 'error', kind, message: (err as Error).message });
    } finally {
      busy = null;
    }
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  function sendFile(req: IncomingMessage, res: ServerResponse, path: string) {
    const size = statSync(path).size;
    const type = TYPES[extname(path)] ?? 'application/octet-stream';
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      createReadStream(path).pipe(res);
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';

    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', busy })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (path === '/api/doc' && method === 'GET') {
      const doc = readDoc();
      return json(res, 200, { file: basename(scriptPath), path: scriptPath, exists: existsSync(scriptPath), doc, error: validate(doc) });
    }

    if (path === '/api/doc' && method === 'PUT') {
      const { doc } = await readBody(req);
      writeFileSync(scriptPath, toYaml(doc));
      return json(res, 200, { ok: true, yaml: toYaml(doc), error: validate(doc) });
    }

    if (path === '/api/yaml' && method === 'POST') {
      const { doc } = await readBody(req);
      return json(res, 200, { yaml: toYaml(doc) });
    }

    if ((path === '/api/check' || path === '/api/record') && method === 'POST') {
      if (busy) return json(res, 409, { error: `Already busy (${busy})` });
      const kind = path.slice(5);
      json(res, 202, { ok: true });
      void runJob(kind, async () => {
        const script = loadScript(scriptPath);
        if (kind === 'check') {
          const started = Date.now();
          const { warnings } = await check(script, { log });
          return { warnings, seconds: (Date.now() - started) / 1000 };
        }
        let last = -1;
        lastFiles = await makeVideo(script, {
          log,
          onProgress: (f) => {
            const pct = Math.round(f * 100);
            if (pct !== last) broadcast({ type: 'progress', value: (last = pct) });
          },
        });
        return { video: Boolean(lastFiles.video), gif: Boolean(lastFiles.gif), stamp: Date.now() };
      });
      return;
    }

    if (path === '/api/capture/start' && method === 'POST') {
      if (busy) return json(res, 409, { error: `Already busy (${busy})` });
      const { url, viewport } = await readBody(req);
      busy = 'capture';
      capture = new ClickCapture(
        (step) => broadcast({ type: 'captured', step }),
        (reason) => {
          busy = null;
          capture = null;
          broadcast({ type: 'done', kind: 'capture', reason });
        },
      );
      try {
        await capture.start(resolveUrl(String(url), dirname(scriptPath)), viewport ?? { width: 1280, height: 800 }, log);
        broadcast({ type: 'start', kind: 'capture' });
        return json(res, 200, { ok: true });
      } catch (err) {
        busy = null;
        capture = null;
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (path === '/api/capture/stop' && method === 'POST') {
      await capture?.stop();
      return json(res, 200, { ok: true });
    }

    if (path === '/api/output/video' || path === '/api/output/gif') {
      const file = path.endsWith('gif') ? lastFiles?.gif : lastFiles?.video;
      if (!file || !existsSync(file)) return json(res, 404, { error: 'No video yet' });
      return sendFile(req, res, file);
    }

    if (path === '/api/reveal' && method === 'POST') {
      if (lastFiles?.video) revealFile(lastFiles.video);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'Not found' });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
      const host = (req.headers.host ?? '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') return void res.writeHead(403).end();

      if (url.pathname.startsWith('/api/')) {
        const given = req.headers['x-studio-token'] ?? url.searchParams.get('token');
        if (given !== token) return json(res, 401, { error: 'Bad token. Reopen the link printed in your terminal.' });
        return await handleApi(req, res, url.pathname);
      }

      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const path = join(STATIC_DIR, name);
      if (!path.startsWith(STATIC_DIR) || !existsSync(path)) return void res.writeHead(404).end('Not found');
      sendFile(req, res, path);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    const tryPort = (p: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' && p !== 0 ? tryPort(0) : reject(err)));
      server.listen(p, '127.0.0.1', () => resolvePort((server.address() as { port: number }).port));
    };
    tryPort(opts.port ?? 4321);
  });

  const link = `http://127.0.0.1:${port}/?token=${token}`;
  if (opts.open !== false) openInBrowser(link);
  return { link, port, close: () => server.close() };
}
