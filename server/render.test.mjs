import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkTools, probe } from './ffmpeg.mjs'
import { makeFixtures, meanColorAt } from './fixtures.mjs'
import { buildArgs, resolveFormat, validateDurations } from './render.mjs'
import { startServer } from './index.mjs'

let fx
let srv
let base
let scratch

beforeAll(async () => {
  const tools = await checkTools()
  if (!tools.ok) throw new Error(`These tests need ffmpeg and ffprobe: ${tools.problem}`)
  fx = await makeFixtures()
  scratch = await mkdtemp(path.join(tmpdir(), 'qb-render-test-'))
  srv = await startServer({ port: 0, baseDir: path.join(scratch, 'jobs'), format: resolveFormat('mp4') })
  base = `http://127.0.0.1:${srv.address.port}`
})

afterAll(async () => {
  await srv?.close()
  await rm(scratch, { recursive: true, force: true })
})

async function fileBlob(file, type) {
  return new Blob([await readFile(file)], { type })
}

async function submit({ voice = fx.voice, assets, durations }) {
  const form = new FormData()
  form.append('durations', JSON.stringify(durations))
  if (voice) form.append('voiceover', await fileBlob(voice, 'audio/wav'), path.basename(voice))
  for (const a of assets) form.append('asset', await fileBlob(a, 'application/octet-stream'), path.basename(a))
  const res = await fetch(`${base}/api/renders`, { method: 'POST', body: form })
  return { status: res.status, body: await res.json() }
}

async function waitFor(id) {
  for (let i = 0; i < 300; i++) {
    const job = await (await fetch(`${base}/api/renders/${id}`)).json()
    if (job.status === 'done' || job.status === 'failed') return job
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('render timed out')
}

describe('validation', () => {
  it('rejects bad durations before touching ffmpeg', () => {
    expect(() => validateDurations([1, 2], 3)).toThrow(/Expected 3 durations/)
    expect(() => validateDurations([0.1], 1)).toThrow(/between 0.5 and 300/)
    expect(() => validateDurations(['x'], 1)).toThrow(/no duration/)
    expect(validateDurations(['1.5', 2], 2)).toEqual([1.5, 2])
  })

  it('rejects an unknown output format', async () => {
    const { resolveFormat } = await import('./render.mjs')
    expect(() => resolveFormat('avi')).toThrow(/must be one of mp4, webm/)
    expect(resolveFormat('webm').encoders).toEqual(['libvpx-vp9', 'libopus'])
  })

  it('builds an ffmpeg argument list with no shell and voiceover audio only', () => {
    const args = buildArgs({
      items: [
        { index: 0, kind: 'image', path: '/x/a.png', seconds: 2, hold: 0 },
        { index: 1, kind: 'video', path: "/x/b'; rm -rf $HOME.mov", seconds: 3, hold: 1.5 },
      ],
      total: 5,
      voiceover: '/x/v.wav',
      output: '/x/out.mp4',
    })
    expect(args).toContain("/x/b'; rm -rf $HOME.mov") // passed as a single argv entry, never through a shell
    const fc = args[args.indexOf('-filter_complex') + 1]
    expect(fc).toContain('scale=720:1280:force_original_aspect_ratio=decrease')
    expect(fc).toContain('pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black')
    expect(fc).toContain('tpad=stop_mode=clone:stop_duration=1.5')
    expect(fc).toContain('concat=n=2:v=1:a=0')
    expect(fc).toContain('[2:a:0]aresample=48000,apad[aout]')
    expect(args.filter((a) => a === '-map')).toHaveLength(2)
    expect(args).not.toContain('0:a')
    expect(args).not.toContain('1:a')
    expect(args).toContain('libx264')
    expect(args).toContain('+faststart')
  })
})

describe('render service', () => {
  it('reports ffmpeg availability', async () => {
    const health = await (await fetch(`${base}/api/health`)).json()
    expect(health.ok).toBe(true)
    expect(health.tools.ffmpeg).toMatch(/ffmpeg version/)
  })

  it('renders two images and a short clip into a 720x1280 MP4 with the voiceover', async () => {
    const { status, body } = await submit({ assets: [fx.orange, fx.cream, fx.clip], durations: [1.5, 1.5, 2] })
    expect(status).toBe(202)
    const job = await waitFor(body.id)
    expect(job.error).toBeNull()
    expect(job.status).toBe('done')
    expect(job.output).toMatchObject({ width: 720, height: 1280, timeline: 5, voiceDuration: 4, assetCount: 3, ext: 'mp4', mime: 'video/mp4' })
    expect(job.output.duration).toBeGreaterThan(4.9)
    expect(job.output.duration).toBeLessThan(5.2)
    expect(job.notes).toEqual([
      expect.stringMatching(/Clip 3 .* is 1s but set to 2s, so its last frame holds for 1s/),
      expect.stringMatching(/longer than the voiceover .* last 1s is silent/),
    ])

    const res = await fetch(`${base}/api/renders/${body.id}/output`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    const out = path.join(scratch, 'out.mp4')
    await (await import('node:fs/promises')).writeFile(out, Buffer.from(await res.arrayBuffer()))

    const info = await probe(out)
    expect(info).toMatchObject({ kind: 'video', width: 720, height: 1280, hasAudio: true })

    // Visual change: orange at 0.5s, cream at 2s, blue clip at 3.5s (held last frame, since the clip is 1s).
    const [c1, c2, c3] = await Promise.all([meanColorAt(out, 0.5), meanColorAt(out, 2), meanColorAt(out, 3.5)])
    expect(c1[0]).toBeGreaterThan(200) // orange #FF5A00
    expect(c1[2]).toBeLessThan(40)
    expect(c2.every((v) => v > 200)).toBe(true) // cream #F2EEE5
    expect(c3[2]).toBeGreaterThan(200) // blue #2040FF
    expect(c3[0]).toBeLessThan(80)

    // Range requests work for the player.
    const part = await fetch(`${base}/api/renders/${body.id}/output`, { headers: { Range: 'bytes=0-99' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toMatch(/^bytes 0-99\//)

    // Clip audio is never mixed in. The clip carries a 1 kHz tone during timeline 3-4s; through a
    // 1 kHz band-pass, that window of the output must be no louder than the voiceover alone.
    const { run, FFMPEG } = await import('./ffmpeg.mjs')
    const level = async (file) => {
      const { stderr } = await run(FFMPEG, ['-hide_banner', '-ss', '3', '-t', '1', '-i', file, '-af', 'bandpass=f=1000:width_type=h:w=100,volumedetect', '-f', 'null', '-'])
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1])
    }
    const [outLevel, voiceLevel] = await Promise.all([level(out), level(fx.voice)])
    expect(Number.isFinite(outLevel) && Number.isFinite(voiceLevel)).toBe(true)
    expect(outLevel).toBeLessThan(voiceLevel + 3)
  })

  it('refuses a render with no voiceover, with no assets, or with mismatched durations', async () => {
    expect((await submit({ voice: null, assets: [fx.orange], durations: [2] })).body.error).toMatch(/voiceover file is required/)
    expect((await submit({ assets: [], durations: [] })).body.error).toMatch(/at least one image or video/)
    expect((await submit({ assets: [fx.orange], durations: [2, 2] })).status).toBe(202)
    const job = await waitFor((await submit({ assets: [fx.orange], durations: [2, 2] })).body.id)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/Expected 1 durations/)
  })

  it('rejects a video file posing as a voiceover with no audio track', async () => {
    const { makeFixtures } = await import('./fixtures.mjs')
    const f = await makeFixtures()
    const { FFMPEG, run } = await import('./ffmpeg.mjs')
    const silent = path.join(path.dirname(f.clip), 'silent.mp4')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent])
    const { body } = await submit({ voice: silent, assets: [fx.orange], durations: [1] })
    const job = await waitFor(body.id)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/no audio track/)
  })

  it('rejects unsupported file types and bad job ids', async () => {
    const form = new FormData()
    form.append('durations', '[1]')
    form.append('voiceover', new Blob(['x']), 'voice.wav')
    form.append('asset', new Blob(['x']), 'notes.txt')
    const res = await fetch(`${base}/api/renders`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not a supported image or video/)
    expect((await fetch(`${base}/api/renders/../../etc/passwd`)).status).toBe(404)
    expect((await fetch(`${base}/api/renders/zzzz`)).status).toBe(404)
  })
})
