# Changelog

## 0.5.1

- The studio explains the one-time browser download the first time you press **Record my clicks**, instead of just saying "Opening a browser window".
- New end-to-end test that uses the studio like a first-time user: empty folder, build steps with buttons, check, make a video.

## 0.5.0

- **scriptcast studio** (`npx scriptcast studio`): a visual editor in your browser. Add steps with buttons and dropdowns, press **Record my clicks** to turn your own clicking and typing into steps, then check, record, watch and download the video without touching the terminal again.
- Click recording describes targets the way a person would (button text, field labels) and never captures real passwords: it writes `${PASSWORD}` instead.
- The status now says when the GIF is being made.

## 0.4.0

- **Apps behind a login**: `setup:` steps run before recording and never appear in the video. `session:` saves the logged-in state and reuses it next time.
- **Environment variables** in scripts: `${DEMO_PASSWORD}` keeps secrets out of your script (and works with GitHub Actions secrets).
- **About 4x faster rendering** (a 19 second demo now renders in under 5 seconds).

- New hero example: an analytics dashboard with a modal, captions and a live-updating table (`examples/dashboard`).
- `output.gifWidth`, `output.gifFps` and `output.gifColors` to trade GIF quality for file size.

## 0.3.0

- **GitHub Action**: `uses: vipul080/scriptcast@v0` records your demo in CI, can start your app and wait for it, and can commit the fresh video/GIF back to your repo. scriptcast's own README demo is now generated this way.
- Bundled the Inter font, so captions and the address bar look the same on every machine (Linux CI used to fall back to a serif font).
- First run downloads a 3× smaller browser (headless shell only).
- Clean progress output in CI logs, and the output folder is created if it doesn't exist.

## 0.2.0

- **Captions**: `say: Invite your team` shows a caption until the next one; `say: { text, for: 2s }` for a fixed time.
- **Smarter element matching**: exact matches beat partial ones, buttons and links beat plain text, and ambiguous targets print a warning.
- **`in:` and `nth:`** to pick a specific match: `click: { text: Save, in: Settings }`.
- **`scriptcast check`**: runs every step in seconds without recording, so you can fix a script before rendering.
- **`waitFor:`** waits for something to appear (up to 30s).
- **`hide:`** keeps cookie banners, chat widgets and other overlays out of the video.
- Off-screen elements are scrolled to smoothly instead of jumping.
- Clear errors when an overlay covers the element you want to click, or when a site shows a bot check.
- No more ffmpeg install: scriptcast ships with its own. The browser downloads automatically on first run.
- Handles pages that re-render elements (React and other single-page apps).

## 0.1.0

- First release: YAML script → polished MP4/GIF with auto-zoom, smooth cursor, click ripples and window framing.
