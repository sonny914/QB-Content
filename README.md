# QB Content

Quiet Bands Content. See `PROJECT.md` for the plan and `CLAUDE.md` for working rules.

## Reel prototype (single-user, local)

One reel workspace: an editable brief, **Create a preview** (assemble a recorded voiceover and your images or clips into a vertical MP4 with FFmpeg, locally), a video preview player, revision notes, Request changes / Approve, download of the approved version, and an activity history.

- Brief text, revision notes and activity are saved in this browser's `localStorage` only.
- A video you attach plays from your device and is not copied anywhere.
- When you create a preview, the voiceover and assets are sent to the **render service on this computer** (`server/index.mjs`, bound to `127.0.0.1:5174`), assembled with FFmpeg in a temporary job folder under the OS temp directory, loaded into the player, and the temporary files are then removed. Nothing goes to any external service.
- Videos are not stored by the app. After a reload you must re-render or reattach the file and watch it to the end again before approving.
- There is no login, no generation of ideas, scripts, voices or images, and no publishing.

### Requirements

- Node.js 20 or newer.
- **FFmpeg** (with `ffprobe`, `libx264` and AAC) on your PATH. The app reports what's missing on the Create a preview panel.
  - Windows: `winget install Gyan.FFmpeg`, then open a new terminal.
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `sudo apt install ffmpeg`

### Run it

```bash
npm install
npm run dev        # starts the render service and the page; open http://localhost:5173
```

`npm run dev` runs both processes. `npm run dev:web` runs only the page and `npm run render-service` only the service, if you want them in separate terminals.

### Create a preview

1. Choose your recorded voiceover (mp3, wav, m4a, …).
2. Add images and/or video clips. They appear in order; move or remove them.
3. Each asset gets an equal share of the voiceover length by default. Edit any duration (0.5–300 s); **Divide evenly** restores the split.
4. **Create preview** renders a 720×1280 MP4 at 30 fps: assets are fitted inside the frame on a black background without stretching, clip audio is muted, the voiceover is the only audio track.
5. The result loads into the player as a new, unapproved video version. Watch it to the end, approve, then download.

What the panel warns about: a clip shorter than its assigned seconds holds its last frame (with a one-click **Use clip length**); a timeline shorter than the voiceover cuts the narration off; a longer one ends in silence.

Limits: 20 assets, 500 MB per file, 600 s total. Known gaps: EXIF-rotated phone photos are not auto-rotated by this FFmpeg pipeline (rotated videos are); HEIC images need an FFmpeg build with HEIF support; the browser can't show the length of clip formats it can't decode, though the render still handles them.

### Workflow rules

- The reel starts in **Draft**.
- **Approve** needs a video attached in this session and watched through to the end.
- **Request changes** needs a revision note.
- Editing the brief or replacing the video withdraws any approval and returns the reel to Draft.
- An approval records the exact brief version and video (by SHA-256 of the file). Reloading or reattaching a file requires a fresh review and explicit approval; earlier approvals remain in history.
- Without SHA-256 (for example plain HTTP on a phone), preview and notes still work, but approval requires HTTPS or localhost.
- File checking blocks approval. Failed checks show an error; clearing the workspace discards pending checks.

### Checks

```bash
npm run typecheck
npm test           # workflow rules, persistence, and a real local render verified with ffprobe
npm run test:e2e   # browser tests, including render → review → approve → download (needs ffmpeg)
```

The browser tests build the app and start the render service on port 5174, so stop `npm run dev` first. They run the service with `QB_RENDER_FORMAT=webm` (VP9/Opus) because Playwright's bundled Chromium can't decode H.264/AAC; the MP4 default is verified by the server test with ffprobe.
