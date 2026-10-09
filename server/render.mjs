// Assembles a vertical 720x1280 MP4 from an ordered timeline of visual sources (uploaded images or
// clips, or motion-graphic scenes drawn locally) plus one voiceover track, or silence when none is
// attached. Simple assembly: each entry is shown for its assigned seconds. No speech alignment.
import { FFMPEG, probe, run } from './ffmpeg.mjs'
import { deviceCard, prepareMedia, readingSeconds, renderGraphicClip, validateGraphic, WIDTH as GW, HEIGHT as GH } from './graphics.mjs'

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

/**
 * Validate a structured timeline: [{ seconds, source: 'asset' }, { seconds, source: 'graphic', graphic }].
 * Asset entries consume the uploaded assets in order. Throws with a user-facing message.
 */
export function validateTimeline(timeline, assetCount) {
  if (!Array.isArray(timeline) || timeline.length === 0) throw new Error('The timeline needs at least one scene')
  if (timeline.length > MAX_ASSETS) throw new Error(`At most ${MAX_ASSETS} scenes per render`)
  let assetIndex = 0
  const clean = timeline.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Scene ${i + 1} is not an object`)
    const n = Number(entry.seconds)
    if (!Number.isFinite(n)) throw new Error(`Scene ${i + 1} has no duration`)
    if (n < MIN_SECONDS || n > MAX_SECONDS) throw new Error(`Scene ${i + 1} must be between ${MIN_SECONDS} and ${MAX_SECONDS} seconds`)
    const seconds = round(n)
    if (entry.source === 'graphic') {
      const graphic = validateGraphic(entry.graphic, `Scene ${i + 1} graphic`)
      // A graphic with a media slot set to 'asset' consumes the next uploaded file, like an asset scene.
      if (graphic.media === 'asset') {
        if (assetIndex >= assetCount) throw new Error(`Scene ${i + 1} needs an uploaded image or clip for its ${graphic.template} slot but only ${assetCount} ${assetCount === 1 ? 'was' : 'were'} sent`)
        return { seconds, source: 'graphic', graphic, assetIndex: assetIndex++ }
      }
      return { seconds, source: 'graphic', graphic }
    }
    if (entry.source === 'asset' || entry.source === undefined) {
      if (assetIndex >= assetCount) throw new Error(`Scene ${i + 1} needs an uploaded asset but only ${assetCount} ${assetCount === 1 ? 'was' : 'were'} sent`)
      return { seconds, source: 'asset', assetIndex: assetIndex++ }
    }
    throw new Error(`Scene ${i + 1} has an unknown source "${entry.source}"`)
  })
  if (assetIndex !== assetCount) throw new Error(`${assetCount} asset${assetCount === 1 ? '' : 's'} sent but the timeline uses ${assetIndex}`)
  const total = clean.reduce((a, e) => a + e.seconds, 0)
  if (total > MAX_TOTAL_SECONDS) throw new Error(`Total timeline must be ${MAX_TOTAL_SECONDS} seconds or less`)
  return clean
}

/** Probe every input and work out what the render will do. Pure planning: no rendering here. */
export async function plan({ voiceover, assets, timeline, jobDir }) {
  let voiceDuration = 0
  if (voiceover) {
    const voice = await probe(voiceover.path).catch((err) => {
      throw new Error(`The voiceover can't be read: ${err.message}`)
    })
    if (!voice.hasAudio) throw new Error('The voiceover file has no audio track')
    voiceDuration = round(voice.duration)
  }

  const items = []
  const notes = []
  for (const [i, entry] of timeline.entries()) {
    const seconds = entry.seconds
    if (entry.source === 'graphic') {
      const g = entry.graphic
      const need = readingSeconds(g)
      if (seconds < need - 0.05) notes.push(`Scene ${i + 1} shows text that needs about ${need}s to read but is set to ${seconds}s.`)
      for (const cue of g.captions) {
        if (cue.end > seconds + 0.05) notes.push(`Scene ${i + 1}: a caption runs to ${cue.end}s but the scene is ${seconds}s.`)
      }
      const item = { index: i, name: `graphic: ${g.headline || g.template}`, path: `${jobDir}/graphic-${i}.mp4`, kind: 'video', seconds, sourceDuration: seconds, hold: 0, graphic: g, mediaAsset: null }
      if (entry.assetIndex !== undefined) {
        const asset = assets[entry.assetIndex]
        const info = await probe(asset.path).catch((err) => {
          throw new Error(`Scene ${i + 1} (${asset.name}) can't be read: ${err.message}`)
        })
        if (info.kind === 'audio') throw new Error(`Scene ${i + 1} (${asset.name}) is audio only. The ${g.template} slot needs an image or video clip`)
        item.mediaAsset = { path: asset.path, name: asset.name, kind: info.kind, width: info.width, height: info.height, duration: round(info.duration) }
        item.name += ` + ${asset.name}`
        if (info.kind === 'video' && info.duration > 0 && info.duration < seconds - 0.05) notes.push(`Clip in scene ${i + 1} (${asset.name}) is ${round(info.duration)}s but the scene is ${seconds}s, so its last frame holds for ${round(seconds - info.duration)}s.`)
      }
      items.push(item)
      continue
    }
    const asset = assets[entry.assetIndex]
    const info = await probe(asset.path).catch((err) => {
      throw new Error(`Scene ${i + 1} (${asset.name}) can't be read: ${err.message}`)
    })
    if (info.kind === 'audio') throw new Error(`Scene ${i + 1} (${asset.name}) is audio only. Visual assets must be images or video clips`)
    const item = { index: i, name: asset.name, path: asset.path, kind: info.kind, seconds, sourceDuration: round(info.duration), hold: 0 }
    if (info.kind === 'video' && info.duration > 0 && info.duration < seconds - 0.05) {
      item.hold = round(seconds - info.duration)
      notes.push(`Clip in scene ${i + 1} (${asset.name}) is ${item.sourceDuration}s but set to ${seconds}s, so its last frame holds for ${item.hold}s.`)
    }
    items.push(item)
  }

  const total = round(timeline.reduce((a, e) => a + e.seconds, 0))
  if (!voiceover) notes.push('Silent preview: no voiceover was attached, so the audio track is silence.')
  else {
    if (total < voiceDuration - 0.05) notes.push(`The timeline (${total}s) is shorter than the voiceover (${voiceDuration}s): the narration is cut off at ${total}s.`)
    if (total > voiceDuration + 0.05) notes.push(`The timeline (${total}s) is longer than the voiceover (${voiceDuration}s): the last ${round(total - voiceDuration)}s is silent.`)
  }

  return { items, total, voiceDuration, notes, silent: !voiceover, graphicCount: items.filter((it) => it.graphic).length }
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
  // No voiceover: a silent track keeps the output a normal video with audio, clearly labelled silent.
  if (voiceover) args.push('-i', voiceover)
  else args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono')
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

/** Render to `output`, reporting 0..1 progress. Graphic scenes are drawn to clips first. */
export async function render({ items, total, voiceover, output, format, onProgress, onStage, signal }) {
  const graphics = items.filter((it) => it.graphic)
  // Drawing frames is the slower half when graphics are present; weight progress accordingly.
  const drawShare = graphics.length ? 0.55 : 0
  const graphicSeconds = graphics.reduce((a, it) => a + it.seconds, 0)
  let drawn = 0
  for (const [n, item] of graphics.entries()) {
    if (onStage) onStage(`Drawing graphic scene ${item.index + 1} (${n + 1} of ${graphics.length})`)
    let media = null
    if (item.mediaAsset) {
      const g = item.graphic
      const aspect = item.mediaAsset.width && item.mediaAsset.height ? item.mediaAsset.width / item.mediaAsset.height : null
      const slot = g.template === 'presenter' ? { w: GW, h: GH } : deviceCard(g.frame, aspect)
      // A focus zoom needs more source pixels than the slot shows at rest; render up to 2.5× for it.
      const zoomScale = g.focus ? Math.min(2.5, 1 / Math.max(g.focus.w, g.focus.h, 0.4)) : 1
      media = await prepareMedia({ assetPath: item.mediaAsset.path, kind: item.mediaAsset.kind, seconds: item.seconds, slot, scale: zoomScale, outDir: `${item.path}.frames`, signal })
    }
    await renderGraphicClip({
      spec: item.graphic,
      seconds: item.seconds,
      output: item.path,
      media,
      signal,
      onProgress: (p) => onProgress && onProgress(((drawn + p * item.seconds) / graphicSeconds) * drawShare),
    })
    drawn += item.seconds
  }
  if (onStage) onStage(graphics.length ? 'Assembling the scenes with the audio' : null)
  const args = buildArgs({ items, total, voiceover, output, format })
  await run(FFMPEG, args, {
    signal,
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line)
      if (m && onProgress) onProgress(drawShare + Math.min(1, Number(m[1]) / 1e6 / total) * (1 - drawShare))
    },
  })
  const info = await probe(output)
  return { duration: round(info.duration), width: info.width, height: info.height }
}
