// Generates small local test media with ffmpeg: an audible tone as the voiceover substitute,
// two visually distinct images and a one-second clip. Nothing is downloaded or generated remotely.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { FFMPEG, run } from './ffmpeg.mjs'

export const FIXTURE_DIR = path.resolve('test-results/fixtures')

export async function makeFixtures(dir = FIXTURE_DIR) {
  await mkdir(dir, { recursive: true })
  const f = {
    voice: path.join(dir, 'voice-tone-4s.wav'),
    orange: path.join(dir, 'frame-orange.png'),
    cream: path.join(dir, 'frame-cream-portrait.png'),
    clip: path.join(dir, 'clip-blue-1s.mp4'),
    clipWebm: path.join(dir, 'clip-blue-1s.webm'),
    silentVideo: path.join(dir, 'reel-a.webm'),
  }
  const jobs = [
    [f.voice, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ac', '1', '-ar', '44100']],
    [f.orange, ['-f', 'lavfi', '-i', 'color=c=0xFF5A00:s=400x300:d=1', '-frames:v', '1']],
    [f.cream, ['-f', 'lavfi', '-i', 'color=c=0xF2EEE5:s=300x500:d=1', '-frames:v', '1']],
    [f.clip, ['-f', 'lavfi', '-i', 'color=c=0x2040FF:s=320x240:d=1:r=24', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']],
    [f.clipWebm, ['-f', 'lavfi', '-i', 'color=c=0x2040FF:s=320x240:d=1:r=24', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', '-shortest']],
  ]
  for (const [out, args] of jobs) {
    if (existsSync(out)) continue
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out])
  }
  return f
}

/**
 * Mean RGB of the centre of one decoded frame at `seconds`, for "did the picture actually change"
 * checks. The centre is used because a fitted asset always covers it, whatever its aspect ratio.
 */
export async function meanColorAt(file, seconds) {
  const { stdout } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
    '-frames:v', '1', '-vf', 'crop=iw/4:ih/8:(iw-iw/4)/2:(ih-ih/8)/2,scale=16:16', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { binary: true })
  const buf = stdout
  const sum = [0, 0, 0]
  for (let i = 0; i < buf.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += buf[i + c]
  const n = buf.length / 3
  return sum.map((s) => Math.round(s / n))
}
