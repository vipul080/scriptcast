#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { makeVideo } from './pipeline.js';
import { check } from './recorder.js';
import { loadScript } from './script.js';
import { startStudio } from './studio/server.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const STARTER = `# scriptcast script
#   check it works:  npx scriptcast check demo.yml
#   make the video:  npx scriptcast record demo.yml
url: http://localhost:3000
viewport: { width: 1280, height: 800 }

# Hide things you don't want in the video (CSS selectors)
# hide: [".cookie-banner", "#chat-widget"]

output:
  file: demo.mp4
  gif: true            # also write demo.gif for your README
  background: aurora   # aurora, sunset, ocean, candy, forest, midnight, mono, or any CSS color

steps:
  - say: Sign in in seconds
  - click: Sign in
  - type: { into: Email, text: you@example.com }
  - press: Enter
  - waitFor: Dashboard
  - say: ""            # clear the caption
  - wait: 1s
`;

// A live-updating percentage in a terminal; a few plain lines in CI logs.
function progressPrinter(): (fraction: number) => void {
  if (process.stdout.isTTY) {
    return (f) => {
      process.stdout.write(`\r● Rendering ${String(Math.round(f * 100)).padStart(3)}%`);
      if (f >= 1) process.stdout.write('\n');
    };
  }
  let lastQuarter = -1;
  return (f) => {
    const quarter = Math.floor(f * 4);
    if (quarter !== lastQuarter) {
      lastQuarter = quarter;
      console.log(`● Rendering ${quarter * 25}%`);
    }
  };
}

const program = new Command()
  .name('scriptcast')
  .description('Write a script, get a polished demo video of your web app.')
  .version(version);

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

    const outputs = await makeVideo(script, { headed: opts.headed, log: (m) => console.log(m), onProgress: progressPrinter() });

    // When running inside GitHub Actions, expose the file paths as step outputs.
    if (process.env.GITHUB_OUTPUT) {
      const lines = Object.entries(outputs).filter(([, v]) => v).map(([k, v]) => `${k}=${v}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, lines.join(''));
    }
  });

program
  .command('check')
  .argument('<script>', 'path to your demo script (.yml)')
  .option('--headed', 'show the browser while checking')
  .description('quickly run every step without recording, to make sure the script works')
  .action(async (scriptPath: string, opts: { headed?: boolean }) => {
    const script = loadScript(scriptPath);
    const started = Date.now();
    console.log(`● Checking ${script.displayUrl}`);
    const { warnings } = await check(script, { headed: opts.headed, log: (m) => console.log(m) });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const note = warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''} above)` : '';
    console.log(`✔ All ${script.steps.length} steps work${note}. Took ${secs}s`);
    console.log(`  Make the video with: scriptcast record ${scriptPath}`);
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
    console.log(`✔ Created ${file}. Edit the steps, then run: scriptcast check ${file}`);
  });

program
  .command('studio')
  .argument('[file]', 'script to open (created if it does not exist)', 'demo.yml')
  .option('-p, --port <port>', 'port to run on', '4321')
  .option('--no-open', "don't open the browser automatically")
  .description('open a friendly editor in your browser to build and record demos')
  .action(async (file: string, opts: { port: string; open: boolean }) => {
    const { link } = await startStudio(file, { port: Number(opts.port), open: opts.open });
    console.log(`● scriptcast studio is running for ${file}`);
    console.log(`  ${link}`);
    console.log('  Keep this terminal open while you use it. Press Ctrl+C to stop.');
  });

program.parseAsync().catch((err: Error) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
