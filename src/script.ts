import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export type Step =
  | { action: 'goto'; url: string }
  | { action: 'click'; target: string }
  | { action: 'hover'; target: string }
  | { action: 'type'; text: string; into?: string }
  | { action: 'press'; key: string }
  | { action: 'wait'; ms: number }
  | { action: 'scroll'; by: number };

export interface OutputOptions {
  file: string;
  gif: boolean;
  fps: number;
  width: number;
  height: number;
  background: string;
}

export interface Script {
  url: string;
  displayUrl: string;
  viewport: { width: number; height: number };
  output: OutputOptions;
  steps: Step[];
}

export class ScriptError extends Error {}

export function parseDuration(value: unknown, where: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/);
    if (m) return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
  }
  throw new ScriptError(`${where}: expected a duration like 500ms or 1.5s, got ${JSON.stringify(value)}`);
}

function resolveUrl(url: string, baseDir: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const local = resolve(baseDir, url);
  if (existsSync(local)) return pathToFileURL(local).href;
  return `http://${url}`;
}

function defaultDisplayUrl(url: string): string {
  if (url.startsWith('file:')) return url.split('/').pop() ?? url;
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function parseStep(raw: unknown, index: number, baseDir: string): Step {
  const where = `step ${index + 1}`;
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

  switch (action) {
    case 'goto':
      return { action, url: resolveUrl(str(value, 'goto'), baseDir) };
    case 'click':
    case 'hover':
      return { action, target: str(value, action) };
    case 'type':
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        return { action, text: str(v.text, 'type.text'), into: v.into === undefined ? undefined : str(v.into, 'type.into') };
      }
      return { action, text: str(value, 'type') };
    case 'press':
      return { action, key: str(value, 'press') };
    case 'wait':
      return { action, ms: parseDuration(value, where) };
    case 'scroll':
      if (typeof value !== 'number') throw new ScriptError(`${where}: scroll takes a number of pixels, e.g. "scroll: 400"`);
      return { action, by: value };
    default:
      throw new ScriptError(`${where}: unknown action "${action}". Try one of: goto, click, hover, type, press, wait, scroll`);
  }
}

export function loadScript(path: string): Script {
  const baseDir = dirname(resolve(path));
  let doc: Record<string, any>;
  try {
    doc = parse(readFileSync(path, 'utf8')) ?? {};
  } catch (err) {
    throw new ScriptError(`Couldn't read ${path}: ${(err as Error).message}`);
  }

  if (typeof doc.url !== 'string') throw new ScriptError('Your script needs a "url:" to start from');
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) throw new ScriptError('Your script needs a list of "steps:"');

  const url = resolveUrl(doc.url, baseDir);
  const out = doc.output ?? {};
  return {
    url,
    displayUrl: doc.displayUrl ?? defaultDisplayUrl(url),
    viewport: { width: doc.viewport?.width ?? 1280, height: doc.viewport?.height ?? 800 },
    output: {
      file: resolve(baseDir, out.file ?? 'demo.mp4'),
      gif: out.gif ?? false,
      fps: out.fps ?? 30,
      width: out.width ?? 1920,
      height: out.height ?? 1080,
      background: out.background ?? 'aurora',
    },
    steps: doc.steps.map((s: unknown, i: number) => parseStep(s, i, baseDir)),
  };
}
