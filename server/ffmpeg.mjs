// Thin wrappers around the ffmpeg / ffprobe binaries. Every call uses spawn with an
// argument array: nothing is ever interpolated into a shell string.
import { spawn } from 'node:child_process'

export const FFMPEG = process.env.QB_FFMPEG || 'ffmpeg'
export const FFPROBE = process.env.QB_FFPROBE || 'ffprobe'

/** Run a binary and collect stdout/stderr. Rejects with a readable message on a non-zero exit. */
export function run(bin, args, { onStdoutLine, signal, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal })
    } catch (err) {
      reject(err)
      return
    }
    let stdout = binary ? [] : ''
    let stderr = ''
    let pending = ''
    if (!binary) child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (binary) {
        stdout.push(chunk)
        return
      }
      stdout += chunk
      if (!onStdoutLine) return
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) onStdoutLine(line)
    })
    child.stderr.on('data', (chunk) => {
      // Keep only the tail: ffmpeg's stderr can be long and the useful part is at the end.
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('error', (err) => {
      reject(err.code === 'ENOENT' ? new Error(`${bin} is not installed or not on PATH`) : err)
    })
    child.on('close', (code, sig) => {
      if (code === 0) resolve({ stdout: binary ? Buffer.concat(stdout) : stdout, stderr })
      else if (sig) reject(new Error(`${bin} was stopped (${sig})`))
      else reject(new Error(`${bin} exited with code ${code}: ${lastUsefulLine(stderr)}`))
    })
  })
}

function lastUsefulLine(stderr) {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.at(-1) ?? 'no error output'
}

/** Report whether ffmpeg and ffprobe can be executed, and their versions. */
export async function checkTools(encoders = ['libx264', 'aac']) {
  const result = { ffmpeg: null, ffprobe: null, ok: false, problem: null }
  for (const [key, bin] of [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE]]) {
    try {
      const { stdout } = await run(bin, ['-version'])
      result[key] = stdout.split(/\r?\n/)[0].replace(/ Copyright.*$/, '').trim()
    } catch (err) {
      result.problem = (result.problem ? result.problem + ' ' : '') + err.message + '.'
    }
  }
  if (result.ffmpeg) {
    try {
      const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders'])
      const missing = encoders.filter((enc) => !new RegExp(`\\s${enc}\\s`).test(stdout))
      if (missing.length) result.problem = `This ffmpeg build lacks the ${missing.join(' and ')} encoder(s) needed for the output format.`
    } catch (err) {
      result.problem = err.message
    }
  }
  result.ok = Boolean(result.ffmpeg && result.ffprobe && !result.problem)
  return result
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'tiff', 'jpegls', 'ppm', 'pgm'])

/**
 * Probe a media file. Returns { kind: 'image' | 'video' | 'audio', duration, width, height }
 * or throws if ffprobe can't read it.
 */
export async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ])
  const info = JSON.parse(stdout)
  const streams = info.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const audio = streams.find((s) => s.codec_type === 'audio')
  const formatName = info.format?.format_name ?? ''
  const formatDuration = Number(info.format?.duration)

  if (video) {
    const frames = Number(video.nb_frames)
    const streamDuration = Number(video.duration)
    const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : formatDuration
    const isImage =
      /^(image2|png_pipe|webp_pipe|bmp_pipe|tiff_pipe|jpeg_pipe|gif_pipe)/.test(formatName) ||
      (IMAGE_CODECS.has(video.codec_name) && (!Number.isFinite(frames) || frames <= 1))
    const rotated = Math.abs(Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180 === 90
    return {
      kind: isImage ? 'image' : 'video',
      duration: isImage ? 0 : Number.isFinite(duration) ? duration : 0,
      width: rotated ? video.height : video.width,
      height: rotated ? video.width : video.height,
      hasAudio: Boolean(audio),
    }
  }
  if (audio) {
    const d = Number(audio.duration)
    return { kind: 'audio', duration: Number.isFinite(d) && d > 0 ? d : formatDuration, hasAudio: true }
  }
  throw new Error('No audio, video or image stream found')
}
