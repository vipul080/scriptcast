import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { record, type RunOptions } from './recorder.js';
import { render, toGif } from './renderer.js';
import type { Script } from './script.js';

export interface VideoFiles {
  video: string;
  gif?: string;
}

// Record the script and render it to a video (and a GIF if the script asks for one).
// Shared by `scriptcast record` and the studio.
export async function makeVideo(
  script: Script,
  opts: RunOptions & { onProgress?: (fraction: number) => void } = {},
): Promise<VideoFiles> {
  const log = opts.log ?? (() => {});
  mkdirSync(dirname(script.output.file), { recursive: true });

  log(`● Recording ${script.displayUrl}`);
  const rec = await record(script, opts);
  await render(rec, script.output, script.displayUrl, opts.onProgress);
  log(`✔ ${script.output.file}`);
  const files: VideoFiles = { video: script.output.file };

  if (script.output.gif) {
    const gif = script.output.file.replace(/\.[^.]+$/, '') + '.gif';
    log('● Making the GIF');
    await toGif(script.output.file, gif, { width: script.output.gifWidth, fps: script.output.gifFps, colors: script.output.gifColors });
    log(`✔ ${gif}`);
    files.gif = gif;
  }
  return files;
}
