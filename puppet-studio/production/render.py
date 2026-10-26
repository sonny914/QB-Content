#!/usr/bin/env python3
"""Render a 10 s, 1080x1920, 30 fps Puppet Jay presenter video.

Composites Jay's existing PNG layers (see characters/puppet-jay/manifest.json),
drives the mouth from the voice track's loudness, blinks on a fixed schedule,
adds a slow breathing sway, and burns captions plus the CTA with FFmpeg.

    python3 render.py scenes/video1-community.json
    python3 render.py scenes/video1-community.json --allow-silent   # voice pending

It refuses to run without the real character assets: there is no fallback art.
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

W, H, FPS = 1080, 1920, 30
HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE.parent / "characters" / "puppet-jay" / "manifest.json"

CREAM, ORANGE = "&H00E5EEF2", "&H00005AFF"  # ASS colours are &HAABBGGRR


def die(msg):
    sys.exit(f"render: {msg}")


def load_manifest(path):
    if not path.exists():
        die(f"missing {path}. The Puppet Jay assets are not in the repository; "
            "commit them to characters/puppet-jay/ and write the manifest first.")
    m = json.loads(path.read_text())
    root = path.parent

    def img(rel):
        p = root / rel
        if not p.exists():
            die(f"manifest names {p}, which does not exist")
        return Image.open(p).convert("RGBA")

    layers = m["layers"]
    out = {
        "background": img(m["background"]) if m.get("background") else None,
        "background_color": m.get("background_color", "#000000"),
        "base": img(layers["base"]) if layers.get("base") else None,
        "eyes": {k: img(v) for k, v in (layers.get("eyes") or {}).items()},
        "mouth": {k: img(v) for k, v in layers["mouth"].items()},
        "placement": m["placement"],
    }
    for need in ("closed", "mid", "open"):
        if need not in out["mouth"]:
            die(f"manifest mouth layer '{need}' is required")
    sizes = {i.size for i in [out["base"], *out["eyes"].values(), *out["mouth"].values()] if i}
    if len(sizes) != 1:
        die(f"character layers must share one registered canvas, got sizes {sizes}")
    return out


def voice_envelope(voice, duration):
    """Per-frame RMS loudness of the voice, normalised to 0..1."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(voice), "-t", str(duration), "-ac", "1",
         "-ar", "48000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    pcm = np.frombuffer(raw, np.float32)
    n = int(duration * FPS)
    hop = 48000 // FPS
    pcm = np.pad(pcm, (0, max(0, n * hop - len(pcm))))[: n * hop].reshape(n, hop)
    rms = np.sqrt((pcm ** 2).mean(axis=1))
    voiced = rms[rms > rms.max() * 0.05] if rms.max() > 0 else rms
    ref = np.percentile(voiced, 95) if voiced.size else 1.0
    return np.clip(rms / (ref or 1.0), 0, 1)


def mouth_track(env):
    """closed / mid / open per frame, held at least two frames so it never chatters."""
    track, state, held = [], "closed", 99
    for e in env:
        want = "closed" if e < 0.12 else "mid" if e < 0.45 else "open"
        if want != state and held >= 2:
            state, held = want, 0
        held += 1
        track.append(state)
    return track


def eye_track(n, eyes):
    """Blink every ~3.1-4.3 s (deterministic), closed 3 frames with a half frame either side."""
    track = ["open"] * n
    if "closed" not in eyes:
        return track
    t, gaps = int(1.2 * FPS), [97, 128, 109, 121]
    i = 0
    while t + 4 < n:
        seq = ["half", "closed", "closed", "half"] if "half" in eyes else ["closed"] * 3
        for k, s in enumerate(seq):
            track[t + k] = s
        t += gaps[i % len(gaps)]
        i += 1
    return track


def caption_times(scene, env):
    """Spread caption lines across the voiced span in proportion to their length."""
    if scene.get("line_times"):
        return scene["line_times"]
    voiced = np.nonzero(env > 0.12)[0]
    start, end = ((voiced[0] / FPS, voiced[-1] / FPS + 0.15) if voiced.size
                  else (0.4, scene["cta_start"] - 0.2))
    weights = np.array([len(l) for l in scene["lines"]], float)
    edges = start + np.concatenate([[0], np.cumsum(weights)]) / weights.sum() * (end - start)
    return [[round(a, 2), round(b, 2)] for a, b in zip(edges[:-1], edges[1:])]


def ass_time(t):
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def write_captions(scene, times, path, pending):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter ExtraBold,76,{CREAM},{CREAM},&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,5,2,2,80,80,520,1
Style: CTA,Inter ExtraBold,70,{CREAM},{CREAM},&H00000000,&H00000000,0,0,0,0,100,100,1,0,3,28,0,2,80,80,400,1
Style: Flag,Inter Bold,40,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,10,0,8,40,40,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    cta, dur = scene["cta_start"], scene["duration"]
    for line, (a, b) in zip(scene["lines"], times):
        b = min(b, cta - 0.05)
        if b > a:
            ev.append(f"Dialogue: 0,{ass_time(a)},{ass_time(b)},Cap,,0,0,0,,{{\\fad(80,60)}}{line}")
    head_line, url = scene["cta"]
    ev.append(f"Dialogue: 0,{ass_time(cta)},{ass_time(dur)},CTA,,0,0,0,,"
              f"{{\\fad(150,0)}}{head_line}\\N{{\\c{ORANGE}}}{url}")
    if pending:
        ev.append(f"Dialogue: 1,{ass_time(0)},{ass_time(dur)},Flag,,0,0,0,,VOICE PENDING — SILENT PLACEHOLDER")
    path.write_text(head + "\n".join(ev) + "\n")


def frames(char, mouths, eyes_t, env):
    pl = char["placement"]
    if char["background"] is not None:
        bg = char["background"].convert("RGB").resize((W, H), Image.LANCZOS)
    else:
        bg = Image.new("RGB", (W, H), char["background_color"])
    cache = {}

    def sprite(eye, mouth):
        key = (eye, mouth)
        if key not in cache:
            layers = [char["base"], char["eyes"].get(eye) or char["eyes"].get("open"),
                      char["mouth"][mouth]]
            layers = [l for l in layers if l is not None]
            img = Image.new("RGBA", layers[0].size, (0, 0, 0, 0))
            for l in layers:
                img = Image.alpha_composite(img, l)
            s = pl["scale"]
            cache[key] = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
        return cache[key]

    smooth = 0.0
    for f, (m, e) in enumerate(zip(mouths, eyes_t)):
        t = f / FPS
        smooth += (env[f] - smooth) * 0.15                    # slow follow of speech energy
        spr = sprite(e, m)
        angle = 0.6 * math.sin(2 * math.pi * t / 5.3)         # restrained sway, degrees
        lift = 4 * math.sin(2 * math.pi * t / 3.6) + 6 * smooth  # breath + nod with emphasis
        spr = spr.rotate(angle, resample=Image.BICUBIC, expand=False,
                         center=(spr.width / 2, spr.height))  # pivot at the base
        frame = bg.copy()
        frame.paste(spr, (round(pl["x"] - spr.width / 2), round(pl["y"] - spr.height - lift)), spr)
        yield frame.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scene", type=Path)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--voice", type=Path, help="override the scene's voice file")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--allow-silent", action="store_true",
                    help="render with silent audio and a VOICE PENDING flag when no voice exists")
    a = ap.parse_args()

    scene = json.loads(a.scene.read_text())
    dur, n = scene["duration"], int(scene["duration"] * FPS)
    char = load_manifest(a.manifest)
    voice = a.voice or HERE / scene["voice"]
    pending = not voice.exists()
    if pending and not a.allow_silent:
        die(f"no voice at {voice}. Record it, or pass --allow-silent for a flagged placeholder.")

    env = np.zeros(n) if pending else voice_envelope(voice, dur)
    mouths, eyes_t = mouth_track(env), eye_track(n, char["eyes"])
    times = caption_times(scene, env)

    out = a.out or HERE / "out" / f"{scene['id']}{'-VOICE-PENDING' if pending else ''}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    ass = HERE / "captions" / f"{scene['id']}.ass"
    write_captions(scene, times, ass, pending)

    audio = (["-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=48000:cl=stereo"] if pending
             else ["-i", str(voice)])
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           *audio,
           "-filter_complex", f"[0:v]ass={ass}[v];[1:a]apad,atrim=0:{dur},"
                              f"afade=t=out:st={dur - 0.25}:d=0.25,aresample=48000[a]",
           "-map", "[v]", "-map", "[a]", "-t", str(dur),
           "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
           "-profile:v", "high", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-movflags", "+faststart", str(out)]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for buf in frames(char, mouths, eyes_t, env):
        p.stdin.write(buf)
    p.stdin.close()
    if p.wait():
        die("ffmpeg failed")
    print(json.dumps({"out": str(out), "voice_pending": pending, "caption_times": times}))


if __name__ == "__main__":
    main()
