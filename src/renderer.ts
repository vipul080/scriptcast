import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { trackCamera, type Camera } from './camera.js';
import type { OutputOptions } from './script.js';
import { clamp, cursorAt, easeOut, type Recording } from './timeline.js';

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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  style: OutputOptions['window'];
  // The outer frame (browser window or phone body) on the output canvas.
  win: Box;
  // The web page inside it.
  page: Box;
  // Height of the title bar (browser) or status bar (phone) above the page.
  bar: number;
  radius: number;
  // Corner radii of the page area: [top-left, top-right, bottom-right, bottom-left].
  pageRadius: number[];
  // Phone only: the whole screen (status bar + page) and its corner radius.
  screen?: Box;
  screenRadius?: number;
}

function computeLayout(out: OutputOptions, viewport: { width: number; height: number }, statusBar = 0): Layout {
  const aspect = viewport.width / viewport.height;

  if (out.window === 'phone') {
    // Sizes are relative to the phone's screen width so the frame keeps its proportions.
    const pad = Math.round(out.height * 0.06);
    const bezel = 0.045; // of screen width
    const barRatio = statusBar / viewport.width;
    const heightPerWidth = 1 / aspect + barRatio + bezel * 2;
    const screenW = Math.min((out.width - pad * 2) / (1 + bezel * 2), (out.height - pad * 2) / heightPerWidth);
    const b = screenW * bezel;
    const bar = screenW * barRatio;
    const pageH = screenW / aspect;
    const win = { x: (out.width - screenW - b * 2) / 2, y: (out.height - (pageH + bar + b * 2)) / 2, w: screenW + b * 2, h: pageH + bar + b * 2 };
    const screen = { x: win.x + b, y: win.y + b, w: screenW, h: pageH + bar };
    const screenRadius = screenW * 0.13;
    return {
      style: 'phone',
      win,
      screen,
      screenRadius,
      page: { x: screen.x, y: screen.y + bar, w: screenW, h: pageH },
      bar,
      radius: screenRadius + b,
      pageRadius: [0, 0, screenRadius, screenRadius],
    };
  }

  const pad = Math.round(out.height * 0.075);
  const bar = out.window === 'none' ? 0 : Math.round(out.height * 0.038);
  const pageW = Math.min(out.width - pad * 2, (out.height - pad * 2 - bar) * aspect);
  const pageH = pageW / aspect;
  const x = (out.width - pageW) / 2;
  const y = (out.height - pageH - bar) / 2;
  const radius = Math.round(out.height * 0.014);
  return {
    style: out.window,
    win: { x, y, w: pageW, h: pageH + bar },
    page: { x, y: y + bar, w: pageW, h: pageH },
    bar,
    radius,
    pageRadius: bar ? [0, 0, radius, radius] : [radius, radius, radius, radius],
  };
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const WINDOW_THEMES = {
  light: { body: '#ffffff', bar: '#f1f1f3', line: '#dcdce0', pill: '#e4e4e8', text: '#55555d' },
  dark: { body: '#1e1f29', bar: '#2a2b36', line: '#1a1b23', pill: '#3a3b48', text: '#c9cad6' },
};

function drawBrowserBar(ctx: SKRSContext2D, layout: Layout, displayUrl: string, theme: (typeof WINDOW_THEMES)['light']) {
  const { win, bar, radius } = layout;
  ctx.save();
  roundRect(ctx, win.x, win.y, win.w, win.h, radius);
  ctx.clip();
  ctx.fillStyle = theme.bar;
  ctx.fillRect(win.x, win.y, win.w, bar);
  ctx.fillStyle = theme.line;
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
  ctx.fillStyle = theme.pill;
  roundRect(ctx, win.x + (win.w - pillW) / 2, win.y + (bar - pillH) / 2, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = theme.text;
  ctx.font = `${Math.round(bar * 0.34)}px ${FONT}, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayUrl, win.x + win.w / 2, win.y + bar / 2 + 1);
}

// Phone body, side buttons and the status bar (time, island, battery).
function drawPhone(ctx: SKRSContext2D, layout: Layout) {
  const { win, screen, screenRadius, bar, radius } = layout;
  if (!screen || screenRadius === undefined) return;
  const u = screen.w / 393; // one iPhone point, in canvas pixels

  // Side buttons sit behind the body.
  ctx.fillStyle = '#2a2a30';
  roundRect(ctx, win.x - 3 * u, win.y + 160 * u, 5 * u, 34 * u, 2 * u);
  ctx.fill();
  roundRect(ctx, win.x - 3 * u, win.y + 210 * u, 5 * u, 60 * u, 2 * u);
  ctx.fill();
  roundRect(ctx, win.x + win.w - 2 * u, win.y + 230 * u, 5 * u, 90 * u, 2 * u);
  ctx.fill();

  ctx.fillStyle = '#0d0d10';
  roundRect(ctx, win.x, win.y, win.w, win.h, radius);
  ctx.fill();
  ctx.strokeStyle = '#3b3b42';
  ctx.lineWidth = 2 * u;
  roundRect(ctx, win.x + u, win.y + u, win.w - 2 * u, win.h - 2 * u, radius - u);
  ctx.stroke();

  // Status bar
  ctx.save();
  roundRect(ctx, screen.x, screen.y, screen.w, screen.h, screenRadius);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(screen.x, screen.y, screen.w, bar + 1);
  ctx.restore();

  const mid = screen.y + bar * 0.55;
  ctx.fillStyle = '#111111';
  ctx.font = `600 ${Math.round(16 * u)}px ${FONT}, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('9:41', screen.x + 62 * u, mid);
  // Battery
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 1.2 * u;
  roundRect(ctx, screen.x + screen.w - 62 * u, mid - 6 * u, 26 * u, 12 * u, 3.5 * u);
  ctx.stroke();
  roundRect(ctx, screen.x + screen.w - 60 * u, mid - 4 * u, 19 * u, 8 * u, 2 * u);
  ctx.fill();
  roundRect(ctx, screen.x + screen.w - 35 * u, mid - 2 * u, 1.8 * u, 4 * u, u);
  ctx.fill();
  // Signal bars
  for (let i = 0; i < 4; i++) {
    const h = (4 + i * 2.2) * u;
    roundRect(ctx, screen.x + screen.w - 98 * u + i * 5 * u, mid + 5 * u - h, 3 * u, h, u);
    ctx.fill();
  }
  // Dynamic island
  ctx.fillStyle = '#000000';
  roundRect(ctx, screen.x + screen.w / 2 - 63 * u, screen.y + 11 * u, 126 * u, 37 * u, 18.5 * u);
  ctx.fill();
}

// The static background behind everything.
function drawBackground(out: OutputOptions): Canvas {
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
  return canvas;
}

// The window or phone frame with its shadow, on a transparent canvas so it can fade in and out.
function drawFrame(out: OutputOptions, layout: Layout, displayUrl: string): Canvas {
  const canvas = createCanvas(out.width, out.height);
  const ctx = canvas.getContext('2d');
  const { win, radius } = layout;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = out.height * 0.05;
  ctx.shadowOffsetY = out.height * 0.02;
  ctx.fillStyle = layout.style === 'dark' ? WINDOW_THEMES.dark.body : '#ffffff';
  roundRect(ctx, win.x, win.y, win.w, win.h, radius);
  ctx.fill();
  ctx.restore();

  if (layout.style === 'phone') drawPhone(ctx, layout);
  else if (layout.style === 'light' || layout.style === 'dark') drawBrowserBar(ctx, layout, displayUrl, WINDOW_THEMES[layout.style]);
  return canvas;
}

// Phones show a soft touch circle instead of a mouse arrow.
function drawTouch(ctx: SKRSContext2D, x: number, y: number, size: number, pressed: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, size * (1 - 0.15 * pressed), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 255, 255, ${0.45 + 0.25 * pressed})`;
  ctx.fill();
  ctx.lineWidth = size * 0.08;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.stroke();
  ctx.restore();
}

// How visible the touch circle is: shown while moving toward a target and briefly after a tap.
function touchAlpha(rec: Recording, t: number): number {
  let alpha = 0;
  for (const e of rec.events) {
    if (e.kind === 'move') {
      if (t >= e.t0 - 0.15 && t <= e.t1 + 0.9) alpha = Math.max(alpha, Math.min(1, (t - (e.t0 - 0.15)) / 0.15));
    } else if (e.kind === 'click') {
      const age = t - e.t;
      if (age >= -0.3 && age <= 0.9) alpha = 1;
      else if (age > 0.9 && age <= 1.2) alpha = Math.max(alpha, 1 - (age - 0.9) / 0.3);
    }
  }
  return alpha;
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

  // Scale with the page too, so captions fit on a narrow phone screen.
  const size = Math.round(Math.min(outHeight * 0.03, layout.page.w * 0.05));
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
  const layout = computeLayout(out, rec.viewport, rec.statusBar);
  const background = drawBackground(out);
  const frame = drawFrame(out, layout, displayUrl);
  const canvas = createCanvas(out.width, out.height);
  const ctx = canvas.getContext('2d');
  // 'medium' (mipmapped bilinear) looks the same as 'high' here and is about 10x faster.
  ctx.imageSmoothingQuality = 'medium';

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

    ctx.drawImage(background, 0, 0);
    ctx.save();
    // Fade and grow in at the start, and the reverse at the end, so GIFs loop smoothly.
    if (out.fade) {
      const appear = easeOut(clamp(Math.min((t - rec.start) / 0.5, (rec.end - t) / 0.45), 0, 1));
      if (appear < 1) {
        const scale = 0.96 + 0.04 * appear;
        ctx.globalAlpha = appear;
        ctx.translate(out.width / 2, out.height / 2);
        ctx.scale(scale, scale);
        ctx.translate(-out.width / 2, -out.height / 2);
      }
    }
    ctx.drawImage(frame, 0, 0);
    ctx.beginPath();
    ctx.roundRect(page.x, page.y, page.w, page.h, layout.pageRadius);
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
    if (layout.style === 'phone') {
      drawTouch(ctx, p.x, p.y, 15 * (page.w / vw) * cam.zoom, pressed, touchAlpha(rec, t));
      // Home indicator
      ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
      roundRect(ctx, page.x + page.w / 2 - page.w * 0.17, page.y + page.h - page.w * 0.03, page.w * 0.34, page.w * 0.012, page.w * 0.006);
      ctx.fill();
    } else {
      drawCursor(ctx, p.x, p.y, 26 * (page.w / vw) * Math.sqrt(cam.zoom), pressed);
    }
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

export async function toGif(mp4: string, gif: string, opts: { width: number; fps: number; colors: number }) {
  const ffmpeg = ffmpegPath();
  const proc = spawn(
    ffmpeg,
    [
      '-y', '-loglevel', 'error', '-i', mp4,
      '-vf', `fps=${opts.fps},scale=${opts.width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=${opts.colors}[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
      gif,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const [code] = await once(proc, 'close');
  if (code !== 0) throw new Error(`ffmpeg failed to create the GIF (exit code ${code})`);
}
