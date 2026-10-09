// In-memory render jobs, each with its own temporary folder. Nothing is written inside the repo.
import { randomBytes } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { plan, render, resolveFormat, validateDurations, validateTimeline } from './render.mjs'

export const JOB_ID = /^[a-f0-9]{24}$/
const JOB_TTL_MS = 2 * 60 * 60 * 1000 // outputs are kept for two hours, then removed
const MAX_JOBS = 20

export class JobStore {
  constructor(baseDir = path.join(tmpdir(), 'qb-content-render'), format = resolveFormat()) {
    this.baseDir = baseDir
    this.format = format
    this.jobs = new Map()
  }

  async init() {
    // A fresh start discards anything an earlier process left behind.
    await rm(this.baseDir, { recursive: true, force: true })
    await mkdir(this.baseDir, { recursive: true })
  }

  newId() {
    return randomBytes(12).toString('hex')
  }

  dir(id) {
    if (!JOB_ID.test(id)) throw new Error('Bad job id')
    return path.join(this.baseDir, id)
  }

  async create() {
    const id = this.newId()
    const dir = this.dir(id)
    await mkdir(dir, { recursive: false })
    const job = {
      id,
      dir,
      status: 'uploading',
      progress: 0,
      message: 'Receiving files',
      error: null,
      notes: [],
      output: null,
      createdAt: Date.now(),
      controller: new AbortController(),
    }
    this.jobs.set(id, job)
    await this.evict()
    return job
  }

  get(id) {
    return JOB_ID.test(id) ? this.jobs.get(id) ?? null : null
  }

  publicView(job) {
    const { id, status, progress, message, error, notes, output, createdAt } = job
    return { id, status, progress, message, error, notes, output, createdAt }
  }

  outputPath(job) {
    return path.join(job.dir, `output.${this.format.ext}`)
  }

  /** Validate, plan and render in the background. The job object is updated as it goes. */
  async start(job, { voiceover, assets, durations, timeline }) {
    try {
      job.status = 'checking'
      job.message = 'Checking files'
      // Legacy clients send plain durations for uploaded assets; newer ones send a structured timeline.
      const clean = timeline
        ? validateTimeline(timeline, assets.length)
        : validateDurations(durations, assets.length).map((seconds) => ({ seconds, source: 'asset' }))
      const resolved = clean.map((e, i) => (e.source === 'asset' && e.assetIndex === undefined ? { ...e, assetIndex: i } : e))
      const p = await plan({ voiceover, assets, timeline: resolved, jobDir: job.dir })
      job.notes = p.notes
      job.status = 'rendering'
      const baseMessage = `Rendering ${p.items.length} scene${p.items.length === 1 ? '' : 's'} ${voiceover ? 'with the voiceover' : 'as a silent preview'}`
      job.message = baseMessage
      const output = this.outputPath(job)
      const result = await render({
        items: p.items,
        total: p.total,
        voiceover: voiceover ? voiceover.path : null,
        output,
        format: this.format,
        signal: job.controller.signal,
        onStage: (stage) => {
          job.message = stage ? `${baseMessage}: ${stage}` : baseMessage
        },
        onProgress: (fraction) => {
          job.progress = fraction
        },
      })
      const { size } = await stat(output)
      job.output = {
        ...result,
        size,
        ext: this.format.ext,
        mime: this.format.mime,
        timeline: p.total,
        voiceDuration: p.voiceDuration,
        assetCount: p.items.length,
        graphicCount: p.graphicCount,
        silent: p.silent,
      }
      job.progress = 1
      job.status = 'done'
      job.message = 'Preview ready'
      // The uploaded sources are no longer needed; keep only the rendered file.
      await Promise.all([voiceover, ...assets].filter(Boolean).map((f) => rm(f.path, { force: true })))
      await Promise.all(p.items.filter((it) => it.graphic).flatMap((it) => [rm(it.path, { force: true }), rm(`${it.path}.frames`, { recursive: true, force: true })]))
    } catch (err) {
      job.status = 'failed'
      job.error = err.message
      job.message = 'Render failed'
      await rm(job.dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async remove(id) {
    const job = this.get(id)
    if (!job) return false
    job.controller.abort()
    this.jobs.delete(id)
    await rm(job.dir, { recursive: true, force: true }).catch(() => {})
    return true
  }

  /** Drop expired jobs and, beyond MAX_JOBS, the oldest finished ones. */
  async evict() {
    const now = Date.now()
    const list = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const job of list) {
      const finished = job.status === 'done' || job.status === 'failed'
      if (now - job.createdAt > JOB_TTL_MS || (finished && this.jobs.size > MAX_JOBS)) await this.remove(job.id)
    }
  }

  async destroy() {
    for (const job of this.jobs.values()) job.controller.abort()
    this.jobs.clear()
    await rm(this.baseDir, { recursive: true, force: true }).catch(() => {})
  }
}
