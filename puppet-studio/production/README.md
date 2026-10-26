# Puppet Jay: two 10-second videos

Status: **blocked on source assets and voice.** The render pipeline is built
and tested on a throwaway geometric test rig. No Jay video has been rendered,
because the character art is not in this repository (or in the owner's Google
Drive under any Puppet/Jay name), and no generated stand-in is allowed.

## What's missing

| Needed | Expected location | Status |
| --- | --- | --- |
| `Puppet-Jay-Animation-Asset-Pack(3).zip` (or the 12-file `Puppet-Jay-V1-Starter.zip`) | unpack to `puppet-studio/characters/puppet-jay/` | **missing** |
| Voice, video 1 (WAV, ~6 s) | `production/voice/video1-community.wav` | **missing** |
| Voice, video 2 (WAV, ~7.5 s) | `production/voice/video2-ebook.wav` | **missing** |

## Once the assets are here

1. Unpack the pack into `characters/puppet-jay/` and write `manifest.json` there.
   Every character layer must share one registered canvas (same pixel size).
   If the pack ships flattened full-body images per mouth shape instead of
   layers, set `base` to `null` and point each mouth state at a full image.

   ```json
   {
     "background": "bg.png",
     "background_color": "#000000",
     "layers": {
       "base": "body.png",
       "eyes": { "open": "eyes_open.png", "half": "eyes_half.png", "closed": "eyes_closed.png" },
       "mouth": { "closed": "mouth_closed.png", "mid": "mouth_mid.png", "open": "mouth_open.png" }
     },
     "placement": { "scale": 1.0, "x": 540, "y": 1960 }
   }
   ```
   `placement` is the character's bottom-centre point on the 1080×1920 frame.
   Keep Jay's face above y≈1250 so the captions sit under the chin.

2. Record both lines (quiet room, 48 kHz WAV, one take each, ~0.4 s of
   silence before speaking). Video 1 must finish by 7.6 s and video 2 by
   8.0 s, when the CTA comes up.

3. Render:

   ```sh
   python3 render.py scenes/video1-community.json
   python3 render.py scenes/video2-ebook.json
   ```

   Output: `out/<id>.mp4` at 1080×1920, 30 fps, H.264 + AAC, exactly 10.0 s.
   `--allow-silent` renders with silent audio and a yellow
   **VOICE PENDING** flag burned in, for layout review only.

## How it moves

- **Mouth:** closed/mid/open picked per frame from the voice's loudness, held
  at least 2 frames so it never chatters. Sync is frame-exact because the
  mouth and the audio come from the same samples.
- **Eyes:** blink every 3.2–4.3 s on a fixed schedule (half, closed, closed, half).
- **Body:** ±0.6° sway pivoting at the base, 4 px breathing, and a small lift
  that follows speech energy. No transitions, no particles.
- **Captions:** Inter ExtraBold, cream `#F2EEE5` with a black outline, one
  phrase at a time, spread over the spoken span by length. To hand-time them
  to the recording, add `"line_times": [[start, end], ...]` to the scene file.
- **CTA:** cream headline over the URL in orange `#FF5A00` (the one accent),
  on a black box, held to the end.

## Scripts

- Video 1: "Everybody's talking about AI. Who's actually teaching you? Come
  learn with us at Quiet Bands." CTA: JOIN THE COMMUNITY / QUIETBANDS.COM
- Video 2: "You don't need another AI lecture. You need something you can
  actually use. Grab my free AI starter guide." CTA: FREE AI STARTER GUIDE /
  QUIETBANDS.COM. That's 20 words in 8 s, about 2.6 words per second.
  It fits at a natural pace, with no room for long pauses.
