<div align="center">

# democast

**Write a script. Get a polished demo video of your web app.**<br>
Re-run it whenever your UI changes.

![democast demo](assets/demo.gif)

<sub>☝️ This video was made by democast from a short script. No screen recorder, no editing.</sub>

</div>

---

Recording a product demo by hand is slow: you click through your app, flub a step, start over, then spend an hour zooming and trimming in an editor. Next week the UI changes and the video is out of date.

**democast** turns the demo into code. You describe the steps; it drives a real browser and renders a video with:

- 🔍 **Auto-zoom** that follows the action, then eases back out
- 🖱️ **Smooth cursor** that glides between clicks, with click ripples
- ⌨️ **Natural typing**, letter by letter
- 🎨 **Beautiful framing**: a gradient background, browser window and soft shadow
- 🔁 **Reproducible output**: change your UI, re-run, get a fresh video

## Quick start

```bash
npx democast init        # creates demo.yml
npx democast record demo.yml
```

That's it — you get `demo.mp4` (and `demo.gif` if you ask for one).

> Requires Node 18+ and [ffmpeg](https://ffmpeg.org/download.html) (`brew install ffmpeg` / `apt install ffmpeg`).
> On first run, install the browser with `npx playwright install chromium`.

## Writing a script

```yaml
url: http://localhost:3000
displayUrl: myapp.com          # what the fake address bar shows

output:
  file: demo.mp4
  gif: true
  background: aurora

steps:
  - click: Sign in
  - type: { into: Email, text: ada@example.com }
  - type: { into: Password, text: hunter2 }
  - press: Enter
  - wait: 1s
  - click: New project
  - scroll: 400
```

Targets are written the way you'd describe them to a person — **button or link text, a field's label or placeholder, or any visible text**. CSS selectors (`#submit`, `.card > button`) work too.

### Steps

| Step | Example | What it does |
| --- | --- | --- |
| `click` | `click: Save` | Moves the cursor to the element and clicks it |
| `type` | `type: hello` | Types into whatever is focused |
| `type` | `type: { into: Email, text: a@b.co }` | Clicks a field, then types into it |
| `press` | `press: Enter` | Presses a key (`Enter`, `Tab`, `Meta+K`, …) |
| `hover` | `hover: Pricing` | Moves the cursor over an element |
| `scroll` | `scroll: 600` | Smoothly scrolls the page by N pixels |
| `wait` | `wait: 1.5s` | Pauses (`500ms`, `2s`) |
| `goto` | `goto: /settings` | Navigates to another page |

### Options

| Key | Default | |
| --- | --- | --- |
| `viewport` | `{ width: 1280, height: 800 }` | Browser size |
| `output.file` | `demo.mp4` | Where to write the video |
| `output.gif` | `false` | Also write a GIF (great for READMEs) |
| `output.fps` | `30` | Frame rate |
| `output.width` / `height` | `1920` / `1080` | Video size |
| `output.background` | `aurora` | `aurora`, `sunset`, `ocean`, `candy`, `forest`, `midnight`, `mono`, or any CSS color |

### CLI

```bash
democast record demo.yml            # record and render
democast record demo.yml -o out.mp4 # choose output file
democast record demo.yml --gif      # also export a GIF
democast record demo.yml --headed   # watch the browser while it records
democast init                       # create a starter script
```

## Try the example

```bash
git clone https://github.com/vipul080/democast && cd democast
npm install && npx playwright install chromium
npm run demo   # renders examples/todo/demo.mp4
```

## How it works

1. **Record** — Playwright drives Chromium through your steps while the page is captured frame-by-frame at 2× resolution. Every cursor move, click and keystroke is logged on a timeline.
2. **Direct** — a virtual camera reads the timeline and decides where to look: it zooms toward whatever is being clicked or typed into and eases back out when things go quiet, using spring physics so motion never feels robotic.
3. **Render** — each output frame is composited (background, window, zoomed page, cursor, click effects) and streamed into ffmpeg.

## Roadmap

- [ ] Use in CI: GitHub Action that regenerates demo videos on every release
- [ ] Captions / callouts (`say: "Now invite your team"`)
- [ ] Dark-mode window theme and custom window styles
- [ ] Mobile viewports with device frames
- [ ] Record terminal sessions alongside the browser
- [ ] Background music and fade in/out

Have an idea? [Open an issue](../../issues) — feature requests are very welcome.

## Contributing

PRs are welcome! To work on democast locally:

```bash
npm install
npx playwright install chromium
npm run demo        # run the example with your changes
npm run typecheck
```

## License

MIT
