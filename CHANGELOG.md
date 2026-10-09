# Changelog

## 0.2.0

- **Captions**: `say: Invite your team` shows a caption until the next one; `say: { text, for: 2s }` for a fixed time.
- **Smarter element matching**: exact matches beat partial ones, buttons and links beat plain text, and ambiguous targets print a warning.
- **`in:` and `nth:`** to pick a specific match: `click: { text: Save, in: Settings }`.
- **`democast check`**: runs every step in seconds without recording, so you can fix a script before rendering.
- **`waitFor:`** waits for something to appear (up to 30s).
- **`hide:`** keeps cookie banners, chat widgets and other overlays out of the video.
- Off-screen elements are scrolled to smoothly instead of jumping.
- Clear errors when an overlay covers the element you want to click, or when a site shows a bot check.
- No more ffmpeg install: democast ships with its own. The browser downloads automatically on first run.
- Handles pages that re-render elements (React and other single-page apps).

## 0.1.0

- First release: YAML script → polished MP4/GIF with auto-zoom, smooth cursor, click ripples and window framing.
