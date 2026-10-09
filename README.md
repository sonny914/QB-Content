# QB Content

Quiet Bands Content. See `PROJECT.md` for the plan and `CLAUDE.md` for working rules.

## Reel review prototype (single-user, local)

One reel workspace: an editable brief, a local video preview, revision notes, Request changes / Approve, and an activity history.

- Brief text, revision notes and activity are saved in this browser's `localStorage` only.
- Videos are **never uploaded or stored**. They play from your device. After a reload you must reattach the file and watch it to the end again before approving.
- There is no login, no server, no generation, no publishing.

### Run it

```bash
npm install
npm run dev        # then open http://localhost:5173
```

### Workflow rules

- The reel starts in **Draft**.
- **Approve** needs a video attached in this session and watched through to the end.
- **Request changes** needs a revision note.
- Editing the brief or replacing the video withdraws any approval and returns the reel to Draft.
- An approval records the exact brief version and video (by SHA-256 of the file). Reattaching the identical file keeps a valid approval. A different file does not.

### Checks

```bash
npm run typecheck
npm test           # unit tests for the workflow rules and persistence
npm run test:e2e   # browser tests (needs ffmpeg to generate two 1-second test clips locally)
```
