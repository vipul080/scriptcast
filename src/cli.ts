#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { record } from './recorder.js';
import { render, toGif } from './renderer.js';
import { loadScript } from './script.js';

const STARTER = `# democast script — run with: npx democast record demo.yml
url: http://localhost:3000
viewport: { width: 1280, height: 800 }

output:
  file: demo.mp4
  gif: true            # also write demo.gif for your README
  background: aurora   # aurora, sunset, ocean, candy, forest, midnight, mono, or any CSS color

steps:
  - wait: 500ms
  - click: Sign in
  - type: { into: Email, text: you@example.com }
  - press: Enter
  - wait: 1.5s
`;

const program = new Command()
  .name('democast')
  .description('Write a script, get a polished demo video of your web app.')
  .version('0.1.0');

program
  .command('record')
  .argument('<script>', 'path to your demo script (.yml)')
  .option('-o, --out <file>', 'output video file (overrides the script)')
  .option('--gif', 'also write a GIF next to the video')
  .option('--headed', 'show the browser while recording')
  .description('record your app and render a polished video')
  .action(async (scriptPath: string, opts: { out?: string; gif?: boolean; headed?: boolean }) => {
    const script = loadScript(scriptPath);
    if (opts.out) script.output.file = resolve(opts.out);
    if (opts.gif) script.output.gif = true;

    console.log(`● Recording ${script.displayUrl}`);
    const rec = await record(script, { headed: opts.headed, log: (m) => console.log(m) });

    process.stdout.write('● Rendering   0%');
    await render(rec, script.output, script.displayUrl, (f) =>
      process.stdout.write(`\r● Rendering ${String(Math.round(f * 100)).padStart(3)}%`),
    );
    console.log(`\n✔ ${script.output.file}`);

    if (script.output.gif) {
      const gif = script.output.file.replace(/\.[^.]+$/, '') + '.gif';
      await toGif(script.output.file, gif);
      console.log(`✔ ${gif}`);
    }
  });

program
  .command('init')
  .argument('[file]', 'where to write the starter script', 'demo.yml')
  .description('create a starter demo script')
  .action((file: string) => {
    if (existsSync(file)) {
      console.error(`${file} already exists`);
      process.exit(1);
    }
    writeFileSync(file, STARTER);
    console.log(`✔ Created ${file}. Edit the steps, then run: npx democast record ${file}`);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
