import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

// What to click/hover/type into. Written the way you'd describe it to a person.
export interface Target {
  text: string;
  // Prefer the match nearest to this text (e.g. a section heading), or inside this CSS selector.
  in?: string;
  // Pick the Nth match (1-based) when there are several.
  nth?: number;
}

export type Step =
  | { action: 'goto'; url: string }
  | { action: 'click'; target: Target }
  | { action: 'hover'; target: Target }
  | { action: 'type'; text: string; into?: Target }
  | { action: 'press'; key: string }
  | { action: 'wait'; ms: number }
  | { action: 'waitFor'; target: Target }
  | { action: 'scroll'; by: number }
  | { action: 'say'; text: string; ms?: number };

export interface OutputOptions {
  file: string;
  gif: boolean;
  gifWidth: number;
  gifFps: number;
  gifColors: number;
  fps: number;
  width: number;
  height: number;
  background: string;
}

export interface Script {
  url: string;
  displayUrl: string;
  viewport: { width: number; height: number };
  // CSS selectors to hide while recording (cookie banners, chat widgets, ...).
  hide: string[];
  output: OutputOptions;
  // Steps that run before recording starts and never appear in the video (e.g. logging in).
  setup: Step[];
  // Where to save the browser session (cookies, local storage) after setup. If the file
  // already exists, scriptcast starts from it and skips setup.
  session?: string;
  steps: Step[];
}

export class ScriptError extends Error {}

export const ACTIONS = ['goto', 'click', 'hover', 'type', 'press', 'wait', 'waitFor', 'scroll', 'say'] as const;

export function parseDuration(value: unknown, where: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/);
    if (m) return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
  }
  throw new ScriptError(`${where}: expected a duration like 500ms or 1.5s, got ${JSON.stringify(value)}`);
}

export function resolveUrl(url: string, baseDir: string, base?: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (base && url.startsWith('/') && !base.startsWith('file:')) return new URL(url, base).href;
  const local = resolve(baseDir, url);
  if (existsSync(local)) return pathToFileURL(local).href;
  return `http://${url}`;
}

function defaultDisplayUrl(url: string): string {
  if (url.startsWith('file:')) return url.split('/').pop() ?? url;
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function describeTarget(t: Target): string {
  let s = `"${t.text}"`;
  if (t.in) s += ` in "${t.in}"`;
  if (t.nth) s += ` (#${t.nth})`;
  return s;
}

function parseStep(raw: unknown, index: number, baseDir: string, startUrl: string, section = 'step'): Step {
  const where = `${section} ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScriptError(`${where}: each step should look like "- click: Login"`);
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    throw new ScriptError(`${where}: expected exactly one action, got ${keys.join(', ') || 'none'}`);
  }
  const action = keys[0];
  const value = (raw as Record<string, unknown>)[action];
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string' && typeof v !== 'number') throw new ScriptError(`${where}: ${what} should be text`);
    return String(v);
  };
  const target = (v: unknown, what: string): Target => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const nth = o.nth === undefined ? undefined : Number(o.nth);
      if (nth !== undefined && (!Number.isInteger(nth) || nth < 1)) {
        throw new ScriptError(`${where}: ${what}.nth should be 1, 2, 3, ...`);
      }
      return { text: str(o.text, `${what}.text`), in: o.in === undefined ? undefined : str(o.in, `${what}.in`), nth };
    }
    return { text: str(v, what) };
  };

  switch (action) {
    case 'goto':
      return { action, url: resolveUrl(str(value, 'goto'), baseDir, startUrl) };
    case 'click':
    case 'hover':
    case 'waitFor':
      return { action, target: target(value, action) };
    case 'type':
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        return { action, text: str(v.text, 'type.text'), into: v.into === undefined ? undefined : target(v.into, 'type.into') };
      }
      return { action, text: str(value, 'type') };
    case 'press':
      return { action, key: str(value, 'press') };
    case 'wait':
      return { action, ms: parseDuration(value, where) };
    case 'scroll':
      if (typeof value !== 'number') throw new ScriptError(`${where}: scroll takes a number of pixels, e.g. "scroll: 400"`);
      return { action, by: value };
    case 'say':
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        return { action, text: str(v.text, 'say.text'), ms: v.for === undefined ? undefined : parseDuration(v.for, where) };
      }
      return { action, text: str(value, 'say') };
    default:
      throw new ScriptError(`${where}: unknown action "${action}". Try one of: ${ACTIONS.join(', ')}`);
  }
}

// Replace ${NAME} in any string with the environment variable NAME, so secrets
// like passwords can come from the environment (or CI secrets) instead of the script.
function interpolate(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    // $${NAME} is an escape for a literal ${NAME}.
    return value.replace(/(\$?)\$\{(\w+)\}/g, (match: string, escaped: string, name: string) => {
      if (escaped) return match.slice(1);
      const v = env[name];
      if (v === undefined) throw new ScriptError(`Your script uses \${${name}} but the environment variable ${name} is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  }
  return value;
}

export function parseScript(source: string, baseDir: string, env: Record<string, string | undefined> = process.env): Script {
  let doc: Record<string, any>;
  try {
    doc = parse(source) ?? {};
  } catch (err) {
    throw new ScriptError(`Your script isn't valid YAML: ${(err as Error).message}`);
  }
  doc = interpolate(doc, env) as Record<string, any>;

  if (typeof doc.url !== 'string') throw new ScriptError('Your script needs a "url:" to start from');
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) throw new ScriptError('Your script needs a list of "steps:"');
  if (doc.setup !== undefined && !Array.isArray(doc.setup)) throw new ScriptError('"setup:" should be a list of steps, like "steps:"');

  const url = resolveUrl(doc.url, baseDir);
  const out = doc.output ?? {};
  const hide = doc.hide === undefined ? [] : Array.isArray(doc.hide) ? doc.hide.map(String) : [String(doc.hide)];
  return {
    url,
    displayUrl: doc.displayUrl ?? defaultDisplayUrl(url),
    viewport: { width: doc.viewport?.width ?? 1280, height: doc.viewport?.height ?? 800 },
    hide,
    output: {
      file: resolve(baseDir, out.file ?? 'demo.mp4'),
      gif: out.gif ?? false,
      gifWidth: out.gifWidth ?? 960,
      gifFps: out.gifFps ?? 15,
      gifColors: Math.min(256, Math.max(8, out.gifColors ?? 256)),
      fps: out.fps ?? 30,
      width: out.width ?? 1920,
      height: out.height ?? 1080,
      background: out.background ?? 'aurora',
    },
    setup: doc.setup === undefined ? [] : (Array.isArray(doc.setup) ? doc.setup : []).map((s: unknown, i: number) => parseStep(s, i, baseDir, url, 'setup step')),
    session: typeof doc.session === 'string' ? resolve(baseDir, doc.session) : undefined,
    steps: doc.steps.map((s: unknown, i: number) => parseStep(s, i, baseDir, url)),
  };
}

export function loadScript(path: string): Script {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ScriptError(`Couldn't read ${path}: ${(err as Error).message}`);
  }
  return parseScript(source, dirname(resolve(path)));
}
