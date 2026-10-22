# Puppet Studio — Full Build Assignment for Claude Code

## Mission
Build and ship a working, reusable 2D digital puppet presenter studio inside this repository. Puppet Jay is Character 001. Deliver a functioning 10-second vertical community-invitation video, not just mockups or a prototype.

## Source of truth
Use the existing Puppet Jay assets from `characters/puppet-jay/` when present. The original ZIP is `Puppet-Jay-Animation-Asset-Pack(3).zip`, and a 12-file starter pack is `Puppet-Jay-V1-Starter.zip`. If they have not yet been committed, STOP and report the exact missing files; do not hallucinate or regenerate the character. Preserve Jay's orange-brown felt, hair waves, thick beard, black hoodie, proportions, and existing expression/pose designs. Do not use generic replacement puppet art.

## Definition of done
A developer can run `npm install && npm run dev`, load Jay in a 9:16 preview, switch expressions/poses/gestures, import a voice track, edit timed cues, preview a 10-second scene, save/reopen it, and export a playable 1080x1920 MP4 with synchronized audio and captions. No paid generation services or API keys. Add `npm run build` and automated tests, and verify them. If native FFmpeg is required, document installation and expose a reliable export command. Do not claim success unless the exported file is inspected with ffprobe and playback checked.

## Implementation
Use React, Vite, TypeScript, and PixiJS (or Canvas 2D if asset inspection shows it is simpler and more robust). Keep character manifests separate from scene/timeline data. Use a deterministic renderer at 30 fps. Implement fit-to-frame, transforms, anchors, visibility, layering, expressions, mouth cues, blink timing, body/gesture changes, backgrounds, caption tracks, audio waveform or playback controls, and scene JSON serialization. Ensure swaps do not jump, stretch, or misalign. Inspect alpha channels, dimensions, crops, and registration points first. Some PNGs may be flattened; do not promise independent clothing swaps or skeletal rigging if assets don't support them. Provide a compatibility matrix and clearly disable impossible swaps.

## UI
A usable desktop editing interface with a vertical stage, play/pause/scrub controls, asset panel, character selector, expression and gesture selectors, simple keyframe timeline, audio import, text/caption editor, save/load, and export. Prioritize function over visual decoration. Responsive enough to review on mobile. Use accessible controls.

## First production scene
Project: `community-invite-001`; duration exactly 10.0 s; vertical 1080x1920; 30 fps. One static creator-studio camera and consistent Puppet Jay. Script:
0–3s: “Everybody's talking about AI. Who's actually teaching you?”
3–7s: “I'm building a community where we learn by doing.”
7–10s: “Join free. Your first AI guide is on me.”
Final text: QUIETBANDS.COM / FREE AI STARTER GUIDE.
The words must be checked against the recorded voice duration; if they cannot be spoken naturally in ten seconds, propose a tighter version and implement it with approval. Do not synthesize Jay's voice without an approved voice source. Use a clearly labeled placeholder audio file or user-imported recording until then.

## Website and ebook
Prepare a separate, clearly scoped landing-page integration specification for QuietBands.com: headline, free-guide email signup, consent and privacy copy, success state, and delivery flow. Create draft content for a practical 5-workflow AI starter guide. Do not deploy website changes or invent an email-service integration without access/credentials. The actual production video must not promise a downloadable guide until it exists.

## Engineering workflow
1. Inventory repository and files; report assets present/missing.
2. Set up app and tests.
3. Build and test asset registration, expression/body/gesture swapping.
4. Build editor, scene schema, timeline and playback.
5. Implement deterministic video/audio export and verify output.
6. Build the 10-second sample scene.
7. Run lint, typecheck, tests, build, smoke tests, and inspect output.
8. Commit cohesive checkpoints; provide hashes, test logs, exact run commands, screenshot(s), final MP4 location, known limitations, and next steps.

## Quality gates
No substituted character, no broken alpha edges, no flicker or jumps on swaps, no UI controls that do nothing, no fake export, no silent audio mismatch, no unverified completion claims. Keep changes inside QB-Content's puppet-studio module; don't disturb unrelated content pipeline files. Build through to the working deliverable autonomously, asking only when genuinely blocked by missing source assets, voice rights/audio, or credentials.
