import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { trackCamera, type Camera } from './camera.js';
import type { OutputOptions } from './script.js';
import { cursorAt, easeOut, type Recording } from './timeline.js';

// Ship our own font so videos look the same everywhere. Linux CI machines
// often have no nice sans-serif font, and text would fall back to a serif one.
const FONT = 'Inter';
for (const file of ['Inter-Regular.ttf', 'Inter-SemiBold.ttf']) {
  GlobalFonts.registerFromPath(fileURLToPath(new URL(`../fonts/${file}`, import.meta.url)), FONT);
}

const BACKGROUNDS: Record<string, string[]> = {
  aurora: ['#7f7fd5', '#86a8e7', '#91eae4'],
  sunset: ['#ff7e5f', '#feb47b'],
  ocean: ['#1a2980', '#26d0ce'],
  candy: ['#d53369', '#daae51'],
  forest: ['#134e5e', '#71b280'],
  midnight: ['#0f2027', '#203a43', '#2c5364'],
  mono: ['#e0e0e0', '#f5f5f5'],
};

interface Layout {
  // The browser window (title bar + page) on the output canvas.
  win: { x: number; y: number; w: number; h: number };
  // The page area inside the window.
  page: { x: number; y: number; w: number; h: number };
  bar: number;
  radius: number;
}

function computeLayout(out: OutputOptions, viewport: { width: number; height: number }): Layout {
  const pad = Math.round(out.height * 0.075);
  const bar = Math.round(out.height * 0.038);
  const aspect = viewport.width / viewport.height;
  const pageW = Math.min(out.width - pad * 2, (out.height - pad * 2 - bar) * aspect);
  const pageH = pageW / aspect;
  const x = (out.width - pageW) / 2;
  const y = (out.height - pageH - bar) / 2;
  return {
    win: { x, y, w: pageW, h: pageH + bar },
    page: { x, y: y + bar, w: pageW, h: pageH },
    bar,
    radius: Math.round(out.height * 0.014),
  };
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Everything that never changes between frames: background, window shadow, title bar.
function drawBackdrop(out: OutputOptions, layout: Layout, displayUrl: string): Canvas {
  const canvas = createCanvas(out.width, out.height);
  const ctx = canvas.getContext('2d');

  const colors = BACKGROUNDS[out.background] ?? [out.background];
  if (colors.length === 1) {
    ctx.fillStyle = colors[0];
  } else {
    const g = ctx.createLinearGradient(0, 0, out.width, out.height);
    colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, out.width, out.height);

  const { win, bar, radius } = layout;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = out.height * 0.05;
  ctx.shadowOffsetY = out.height * 0.02;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, win.x, win.y, win.w, win.h, radius);
  ctx.fill();
  ctx.restore();

  // Title bar
  ctx.save();
  roundRect(ctx, win.x, win.y, win.w, win.h, radius);
  ctx.clip();
  ctx.fillStyle = '#f1f1f3';
  ctx.fillRect(win.x, win.y, win.w, bar);
  ctx.fillStyle = '#dcdce0';
  ctx.fillRect(win.x, win.y + bar - 1, win.w, 1);
  ctx.restore();

  const dot = bar * 0.15;
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(win.x + bar * 0.55 + i * dot * 3.2, win.y + bar / 2, dot, 0, Math.PI * 2);
    ctx.fill();
  });

  const pillW = Math.min(win.w * 0.4, 520);
  const pillH = bar * 0.58;
  ctx.fillStyle = '#e4e4e8';
  roundRect(ctx, win.x + (win.w - pillW) / 2, win.y + (bar - pillH) / 2, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = '#55555d';
  ctx.font = `${Math.round(bar * 0.34)}px ${FONT}, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayUrl, win.x + win.w / 2, win.y + bar / 2 + 1);

  return canvas;
}

function drawCursor(ctx: SKRSContext2D, x: number, y: number, size: number, pressed: number) {
  const s = (size / 20) * (1 - 0.18 * pressed);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.2, 13.2);
  ctx.lineTo(7.1, 19.6);
  ctx.lineTo(10.2, 18.2);
  ctx.lineTo(7.4, 12);
  ctx.lineTo(12.8, 12);
  ctx.closePath();
  ctx.fillStyle = '#111111';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.restore();
}

interface Caption {
  text: string;
  t0: number;
  t1: number;
}

const CAPTION_FADE = 0.25;

// Each caption lasts for its explicit duration, or until the next caption (an empty one clears it).
function captionsOf(rec: Recording): Caption[] {
  const said = rec.events.filter((e) => e.kind === 'caption');
  return said
    .map((c, i) => ({
      text: c.text.trim(),
      t0: c.t,
      t1: c.ms !== undefined ? c.t + c.ms / 1000 : (said[i + 1]?.t ?? rec.end),
    }))
    .filter((c) => c.text);
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCaption(ctx: SKRSContext2D, caption: Caption, t: number, layout: Layout, outHeight: number) {
  const fadeIn = Math.min(1, (t - caption.t0) / CAPTION_FADE);
  const fadeOut = Math.min(1, (caption.t1 - t) / CAPTION_FADE);
  const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
  if (alpha <= 0) return;

  const size = Math.round(outHeight * 0.03);
  ctx.save();
  ctx.font = `600 ${size}px ${FONT}, sans-serif`;
  const lines = wrapText(ctx, caption.text, layout.page.w * 0.7);
  const lineH = size * 1.35;
  const padX = size * 1.1;
  const padY = size * 0.65;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lines.length * lineH + padY * 2;
  const x = layout.page.x + (layout.page.w - w) / 2;
  const y = layout.page.y + layout.page.h - h - outHeight * 0.045 + (1 - easeOut(fadeIn)) * size * 0.6;

  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = size * 0.8;
  ctx.shadowOffsetY = size * 0.2;
  ctx.fillStyle = 'rgba(20, 20, 28, 0.86)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(h / 2, size * 1.2));
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + padY + lineH * (i + 0.5)));
  ctx.restore();
}

class FrameSource {
  private index = 0;
  private cachedIndex = -1;
  private cached: Image | null = null;

  constructor(private rec: Recording) {}

  async at(t: number): Promise<Image> {
    const frames = this.rec.frames;
    while (this.index + 1 < frames.length && frames[this.index + 1].t <= t) this.index++;
    if (this.index !== this.cachedIndex) {
      this.cached = await loadImage(frames[this.index].data);
      this.cachedIndex = this.index;
    }
    return this.cached!;
  }
}

// Prefer the ffmpeg that ships with scriptcast so users don't have to install one.
// SCRIPTCAST_FFMPEG overrides it; a system ffmpeg is the last resort.
function ffmpegPath(): string {
  if (process.env.SCRIPTCAST_FFMPEG) return process.env.SCRIPTCAST_FFMPEG;
  try {
    return (createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  } catch {
    return 'ffmpeg';
  }
}

function startEncoder(out: OutputOptions) {
  const ffmpeg = ffmpegPath();
  const proc = spawn(
    ffmpeg,
    [
      '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${out.width}x${out.height}`, '-r', String(out.fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      out.file,
    ],
    { stdio: ['pipe', 'inherit', 'pipe'] },
  );
  // ffmpeg's input probe reads a partial first frame from the pipe and warns about it.
  // The frame is re-read in full, so drop that one line and pass everything else through.
  proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    const rest = chunk.split('\n').filter((l) => l && !l.startsWith('Truncating packet of size'));
    if (rest.length) process.stderr.write(rest.join('\n') + '\n');
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'ENOENT' ? new Error('ffmpeg was not found. Install it (e.g. "brew install ffmpeg") and try again.') : err),
    );
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
  return { proc, done };
}

export async function render(
  rec: Recording,
  out: OutputOptions,
  displayUrl: string,
  onProgress: (fraction: number) => void = () => {},
) {
  const layout = computeLayout(out, rec.viewport);
  const backdrop = drawBackdrop(out, layout, displayUrl);
  const canvas = createCanvas(out.width, out.height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  const frameCount = Math.ceil((rec.end - rec.start) * out.fps);
  const cameras = trackCamera(rec, out.fps, frameCount);
  const source = new FrameSource(rec);
  const clicks = rec.events.filter((e) => e.kind === 'click');
  const captions = captionsOf(rec);
  const { page } = layout;
  const vw = rec.viewport.width;
  const vh = rec.viewport.height;

  const { proc, done } = startEncoder(out);

  for (let i = 0; i < frameCount; i++) {
    const t = rec.start + i / out.fps;
    const cam: Camera = cameras[i];
    const img = await source.at(t);

    // Visible part of the page, in CSS pixels.
    const viewW = vw / cam.zoom;
    const viewH = vh / cam.zoom;
    const viewX = cam.cx - viewW / 2;
    const viewY = cam.cy - viewH / 2;
    const px = img.width / vw;
    const toScreen = (x: number, y: number) => ({
      x: page.x + ((x - viewX) / viewW) * page.w,
      y: page.y + ((y - viewY) / viewH) * page.h,
    });

    ctx.drawImage(backdrop, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(page.x, page.y, page.w, page.h, [0, 0, layout.radius, layout.radius]);
    ctx.clip();
    ctx.drawImage(img, viewX * px, viewY * px, viewW * px, viewH * px, page.x, page.y, page.w, page.h);

    // Click ripples
    let pressed = 0;
    for (const c of clicks) {
      const age = t - c.t;
      if (age < 0 || age > 0.5) continue;
      const k = easeOut(age / 0.5);
      const p = toScreen(c.at.x, c.at.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, (8 + 30 * k) * cam.zoom * (page.w / vw), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(80, 120, 255, ${0.35 * (1 - k)})`;
      ctx.fill();
      if (age < 0.15) pressed = Math.max(pressed, Math.sin((age / 0.15) * Math.PI));
    }

    const cur = cursorAt(rec, t);
    const p = toScreen(cur.x, cur.y);
    drawCursor(ctx, p.x, p.y, 26 * (page.w / vw) * Math.sqrt(cam.zoom), pressed);
    ctx.restore();

    for (const c of captions) {
      if (t >= c.t0 && t <= c.t1) drawCaption(ctx, c, t, layout, out.height);
    }

    const { data } = ctx.getImageData(0, 0, out.width, out.height);
    if (!proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) {
      await once(proc.stdin, 'drain');
    }
    if (i % 15 === 0) onProgress(i / frameCount);
  }

  proc.stdin.end();
  await done;
  onProgress(1);
}

export async function toGif(mp4: string, gif: string) {
  const ffmpeg = ffmpegPath();
  const proc = spawn(
    ffmpeg,
    [
      '-y', '-loglevel', 'error', '-i', mp4,
      '-vf', 'fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
      gif,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const [code] = await once(proc, 'close');
  if (code !== 0) throw new Error(`ffmpeg failed to create the GIF (exit code ${code})`);
}
