// Assembles a vertical 720x1280 MP4 from ordered visual assets plus one voiceover track.
// Simple assembly: each asset is shown for its assigned seconds. No speech alignment.
import { FFMPEG, probe, run } from './ffmpeg.mjs'

export const WIDTH = 720
export const HEIGHT = 1280
export const FPS = 30
export const BACKGROUND = 'black'
export const MIN_SECONDS = 0.5
export const MAX_SECONDS = 300
export const MAX_TOTAL_SECONDS = 600
export const MAX_ASSETS = 20

/**
 * Output profiles. 'mp4' (H.264 + AAC) is the product default: it plays on phones and in every
 * mainstream browser. 'webm' (VP9 + Opus) exists for automated tests in browsers that ship without
 * H.264 and AAC decoders (Playwright's Chromium); select it with QB_RENDER_FORMAT=webm.
 */
export const FORMATS = {
  mp4: {
    ext: 'mp4',
    mime: 'video/mp4',
    codecArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
    encoders: ['libx264', 'aac'],
  },
  webm: {
    ext: 'webm',
    mime: 'video/webm',
    codecArgs: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '96k'],
    encoders: ['libvpx-vp9', 'libopus'],
  },
}

export function resolveFormat(name = process.env.QB_RENDER_FORMAT || 'mp4') {
  const format = FORMATS[name]
  if (!format) throw new Error(`QB_RENDER_FORMAT must be one of ${Object.keys(FORMATS).join(', ')}, not "${name}"`)
  return { name, ...format }
}

const round = (n) => Math.round(n * 1000) / 1000

/** Validate the timeline the client sent. Returns the clean list or throws with a user-facing message. */
export function validateDurations(durations, assetCount) {
  if (!Array.isArray(durations) || durations.length !== assetCount) {
    throw new Error(`Expected ${assetCount} durations, got ${Array.isArray(durations) ? durations.length : 'none'}`)
  }
  const clean = durations.map((d, i) => {
    const n = Number(d)
    if (!Number.isFinite(n)) throw new Error(`Asset ${i + 1} has no duration`)
    if (n < MIN_SECONDS || n > MAX_SECONDS) throw new Error(`Asset ${i + 1} must be between ${MIN_SECONDS} and ${MAX_SECONDS} seconds`)
    return round(n)
  })
  const total = clean.reduce((a, b) => a + b, 0)
  if (total > MAX_TOTAL_SECONDS) throw new Error(`Total timeline must be ${MAX_TOTAL_SECONDS} seconds or less`)
  return clean
}

/** Probe every input and work out what the render will do. Pure planning: no rendering here. */
export async function plan({ voiceover, assets, durations }) {
  const voice = await probe(voiceover.path).catch((err) => {
    throw new Error(`The voiceover can't be read: ${err.message}`)
  })
  if (!voice.hasAudio) throw new Error('The voiceover file has no audio track')

  const items = []
  const notes = []
  for (const [i, asset] of assets.entries()) {
    const info = await probe(asset.path).catch((err) => {
      throw new Error(`Asset ${i + 1} (${asset.name}) can't be read: ${err.message}`)
    })
    if (info.kind === 'audio') throw new Error(`Asset ${i + 1} (${asset.name}) is audio only. Visual assets must be images or video clips`)
    const seconds = durations[i]
    const item = { index: i, name: asset.name, path: asset.path, kind: info.kind, seconds, sourceDuration: round(info.duration), hold: 0 }
    if (info.kind === 'video' && info.duration > 0 && info.duration < seconds - 0.05) {
      item.hold = round(seconds - info.duration)
      notes.push(`Clip ${i + 1} (${asset.name}) is ${item.sourceDuration}s but set to ${seconds}s, so its last frame holds for ${item.hold}s.`)
    }
    items.push(item)
  }

  const total = round(durations.reduce((a, b) => a + b, 0))
  const voiceDuration = round(voice.duration)
  if (total < voiceDuration - 0.05) notes.push(`The timeline (${total}s) is shorter than the voiceover (${voiceDuration}s): the narration is cut off at ${total}s.`)
  if (total > voiceDuration + 0.05) notes.push(`The timeline (${total}s) is longer than the voiceover (${voiceDuration}s): the last ${round(total - voiceDuration)}s is silent.`)

  return { items, total, voiceDuration, notes }
}

/** Build the ffmpeg argument list. Exported so tests can check it without rendering. */
export function buildArgs({ items, total, voiceover, output, format = resolveFormat('mp4') }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats']
  const filters = []
  for (const item of items) {
    if (item.kind === 'image') {
      args.push('-loop', '1', '-framerate', String(FPS), '-t', String(item.seconds), '-i', item.path)
    } else {
      args.push('-i', item.path)
    }
    const fit =
      `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BACKGROUND},setsar=1,fps=${FPS},format=yuv420p`
    if (item.kind === 'image') {
      filters.push(`[${item.index}:v]${fit},trim=duration=${item.seconds},setpts=PTS-STARTPTS[v${item.index}]`)
    } else {
      // Clip to the assigned seconds; a shorter clip holds its last frame (tpad clone) for the remainder.
      const hold = item.hold > 0 ? `,tpad=stop_mode=clone:stop_duration=${item.hold}` : ''
      filters.push(`[${item.index}:v]trim=duration=${item.seconds},setpts=PTS-STARTPTS,${fit}${hold},trim=duration=${item.seconds},setpts=PTS-STARTPTS[v${item.index}]`)
    }
  }
  const voiceIndex = items.length
  args.push('-i', voiceover)
  const chain = items.map((it) => `[v${it.index}]`).join('')
  filters.push(`${chain}concat=n=${items.length}:v=1:a=0[vout]`)
  // Voiceover only: source clip audio is never mapped, so it can't compete with the narration.
  // apad + the -t below make the output exactly the timeline length whatever the voiceover length is.
  filters.push(`[${voiceIndex}:a:0]aresample=48000,apad[aout]`)
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', String(total),
    '-r', String(FPS), '-ar', '48000',
    ...format.codecArgs,
    output,
  )
  return args
}

/** Render to `output`, reporting 0..1 progress. */
export async function render({ items, total, voiceover, output, format, onProgress, signal }) {
  const args = buildArgs({ items, total, voiceover, output, format })
  await run(FFMPEG, args, {
    signal,
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line)
      if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / total))
    },
  })
  const info = await probe(output)
  return { duration: round(info.duration), width: info.width, height: info.height }
}
