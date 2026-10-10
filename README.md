<div align="center">

# scriptcast

**Write a script. Get a polished demo video of your web app.**<br>
Re-run it whenever your UI changes or let GitHub Actions do it for you.

![scriptcast demo](assets/demo.gif)

<sub>☝️ Made by scriptcast from [this short script](examples/dashboard/demo.yml), and re-recorded automatically by its own GitHub Action. No screen recorder, no editing.</sub>

</div>

---

Recording a product demo by hand is slow: you click through your app, flub a step, start over, then spend an hour zooming and trimming in an editor. Next week the UI changes and the video is out of date.

**scriptcast** turns the demo into code. You describe the steps; it drives a real browser and renders a video with:

- 🔍 **Auto-zoom** that follows the action, then eases back out
- 🖱️ **Smooth cursor** that glides between clicks, with click ripples
- ⌨️ **Natural typing**, letter by letter
- 💬 **Captions** that explain each step (`say: Invite your team`)
- 🎨 **Beautiful framing**: a gradient background, browser window and soft shadow
- 🔁 **Always up to date**: a GitHub Action re-records your demo on every release

## Quick start

```bash
npx scriptcast init              # creates demo.yml
npx scriptcast check demo.yml    # runs every step in seconds to make sure it works
npx scriptcast record demo.yml   # makes the video
```

That's it, you get `demo.mp4` (and `demo.gif` if you ask for one).

> Requires Node 18+. Nothing else to install: scriptcast brings its own ffmpeg, and downloads its browser automatically the first time it runs.

## Writing a script

```yaml
url: http://localhost:3000
displayUrl: myapp.com          # what the fake address bar shows
hide: [".cookie-banner", "#intercom"]   # keep these out of the video

output:
  file: demo.mp4
  gif: true
  background: aurora

steps:
  - say: Sign in with your email
  - click: Sign in
  - type: { into: Email, text: ada@example.com }
  - press: Enter
  - waitFor: Dashboard
  - say: Create a project in one click
  - click: New project
  - scroll: 400
```

### Pointing at things

Write targets the way you'd describe them to a person: **button or link text, a field's label or placeholder, or any visible text**. CSS selectors (`#submit`, `.card > button`) work too.

When several things match, scriptcast picks the best one:

1. **Exact matches beat partial ones.** `click: Save` prefers a "Save" button over "Save changes" or "Saved items".
2. **Buttons and links beat form fields, which beat plain text.** A "Save" button wins over a heading that says "Save time".
3. If it's still ambiguous, it uses the first one on the page **and warns you**, so you can be more specific:

```yaml
- click: { text: Save, in: Settings }   # the Save nearest to "Settings"
- click: { text: Save, in: "#billing" } # the Save inside #billing
- click: { text: Save, nth: 2 }         # the second Save on the page
```

### Apps behind a login

Put the login in `setup:`. It runs before recording starts, so it never shows up in the video:

```yaml
url: http://localhost:3000/dashboard
setup:
  - type: { into: Email, text: demo@example.com }
  - type: { into: Password, text: "${DEMO_PASSWORD}" }
  - click: Sign in
  - waitFor: Dashboard
session: .scriptcast/session.json   # optional: stay logged in between runs
steps:
  - click: New project
```

- `${DEMO_PASSWORD}` is read from an environment variable, so secrets never live in the script. (Write `$${...}` if you need a literal `${...}`.)
- With `session:`, scriptcast saves the logged-in browser state after setup and reuses it next time, skipping setup. Delete the file to log in again. It contains cookies, so add it to `.gitignore`.


| Step | Example | What it does |
| --- | --- | --- |
| `click` | `click: Save` | Moves the cursor to the element and clicks it |
| `type` | `type: hello` | Types into whatever is focused |
| `type` | `type: { into: Email, text: a@b.co }` | Clicks a field, then types into it |
| `say` | `say: Invite your team` | Shows a caption until the next `say` (`say: ""` clears it) |
| `say` | `say: { text: Ta-da!, for: 2s }` | Shows a caption for a fixed time |
| `press` | `press: Enter` | Presses a key (`Enter`, `Tab`, `Meta+K`, …) |
| `hover` | `hover: Pricing` | Moves the cursor over an element |
| `scroll` | `scroll: 600` | Smoothly scrolls the page by N pixels |
| `wait` | `wait: 1.5s` | Pauses (`500ms`, `2s`) |
| `waitFor` | `waitFor: Dashboard` | Waits (up to 30s) until something appears, e.g. after a slow load |
| `goto` | `goto: /settings` | Navigates to another page |

### Options

| Key | Default | |
| --- | --- | --- |
| `viewport` | `{ width: 1280, height: 800 }` | Browser size |
| `hide` | `[]` | CSS selectors to hide while recording (cookie banners, chat widgets) |
| `output.file` | `demo.mp4` | Where to write the video |
| `output.gif` | `false` | Also write a GIF (great for READMEs) |
| `output.gifWidth` / `gifFps` / `gifColors` | `960` / `15` / `256` | GIF size, frame rate and palette. Lower them for a smaller file (e.g. `880` / `12` / `96` roughly halves it) |
| `output.fps` | `30` | Frame rate |
| `output.width` / `height` | `1920` / `1080` | Video size |
| `output.background` | `aurora` | `aurora`, `sunset`, `ocean`, `candy`, `forest`, `midnight`, `mono`, or any CSS color |

### CLI

```bash
scriptcast check demo.yml             # dry run: checks every step works, in seconds
scriptcast record demo.yml            # record and render
scriptcast record demo.yml -o out.mp4 # choose output file
scriptcast record demo.yml --gif      # also export a GIF
scriptcast record demo.yml --headed   # watch the browser while it records
scriptcast init                       # create a starter script
```

## Keep your demo up to date (GitHub Action)

Demo videos go stale the moment your UI changes. Add this workflow and your demo re-records itself on every release:

```yaml
# .github/workflows/demo.yml
name: Update demo
on:
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
      - run: npm ci
      - uses: vipul080/scriptcast@v0
        with:
          script: demo.yml
          start: npm run dev                # start your app first
          wait-on: http://localhost:3000    # and wait until it's up
          args: --gif -o docs/demo.mp4
          commit: true                      # commit the fresh video + GIF
        env:
          DEMO_PASSWORD: ${{ secrets.DEMO_PASSWORD }}   # if your script logs in
```

| Input | | |
| --- | --- | --- |
| `script` | required | Path to your script |
| `args` | | Extra `scriptcast record` flags, e.g. `--gif -o docs/demo.mp4` |
| `start` | | Command that starts your app (runs in the background) |
| `wait-on` | | URL to wait for before recording |
| `wait-timeout` | `120` | Seconds to wait for `wait-on` |
| `commit` | `false` | Commit the video (and GIF) back to the repo |
| `commit-message` | `Update demo video` | |

Outputs: `video` and `gif` (file paths), handy for uploading as an artifact or attaching to a release.

## Try the example

```bash
git clone https://github.com/vipul080/scriptcast && cd scriptcast
npm install
npm run demo   # renders examples/dashboard/demo.mp4
```

## How it works

1. **Record**: Playwright drives Chromium through your steps while the page is captured frame-by-frame at 2× resolution. Every cursor move, click and keystroke is logged on a timeline.
2. **Direct**: a virtual camera reads the timeline and decides where to look: it zooms toward whatever is being clicked or typed into and eases back out when things go quiet, using spring physics so motion never feels robotic.
3. **Render**: each output frame is composited (background, window, zoomed page, cursor, click effects) and streamed into ffmpeg.

## Roadmap

- [x] Captions (`say: Now invite your team`)
- [x] Smart element matching with `in:` / `nth:`
- [x] `scriptcast check` dry runs
- [x] Apps behind a login (`setup:` + saved sessions)
- [x] GitHub Action that keeps demo videos up to date
- [ ] Dark-mode window theme and custom window styles
- [ ] Mobile viewports with device frames
- [ ] Record terminal sessions alongside the browser
- [ ] Background music and fade in/out

Have an idea? [Open an issue](../../issues). Feature requests are very welcome.

## Contributing

PRs are welcome! To work on scriptcast locally:

```bash
npm install
npx playwright install chromium
npm test            # unit + browser tests
npm run demo        # run the example with your changes
```

## License

MIT
