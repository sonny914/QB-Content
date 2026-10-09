// Drives one render through the local service: upload with progress, poll, fetch the file, clean up.
// Shared by the free-form "Create a preview" panel and the content plan handoff.
import { useEffect, useRef, useState } from 'react'
import { deleteJob, fetchHealth, fetchOutput, getJob, submitRender, type RenderHealth, type RenderOutput } from './renderClient'
import { formatSize, r1 } from './assets'

export type RenderPhase = 'idle' | 'uploading' | 'checking' | 'rendering' | 'loading' | 'done' | 'failed'

export interface RenderedPreview {
  file: File
  output: RenderOutput
  notes: string[]
}

export interface RenderInput {
  voice: File
  assets: File[]
  durations: number[]
}

export interface RenderState {
  phase: RenderPhase
  busy: boolean
  progress: number
  message: string
  error: string
  notes: string[]
}

export function useRenderHealth(): RenderHealth | null {
  const [health, setHealth] = useState<RenderHealth | null>(null)
  useEffect(() => {
    let alive = true
    fetchHealth().then((h) => alive && setHealth(h))
    return () => {
      alive = false
    }
  }, [])
  return health
}

export function useRender() {
  const [phase, setPhase] = useState<RenderPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  const cancelled = useRef(false)
  useEffect(() => () => void (cancelled.current = true), [])

  const busy = phase === 'uploading' || phase === 'checking' || phase === 'rendering' || phase === 'loading'

  function reset() {
    setPhase('idle')
    setError('')
    setNotes([])
    setProgress(0)
  }

  /** Resolves true when the preview was rendered and handed to `onRendered`. */
  async function run(input: RenderInput, onRendered: (p: RenderedPreview) => Promise<void> | void): Promise<boolean> {
    if (busy) return false
    cancelled.current = false
    setError('')
    setNotes([])
    setProgress(0)
    setPhase('uploading')
    setMessage('Sending files to the local render process')
    let jobId: string | null = null
    try {
      const form = new FormData()
      form.append('durations', JSON.stringify(input.durations))
      form.append('voiceover', input.voice, input.voice.name)
      for (const a of input.assets) form.append('asset', a, a.name)
      jobId = await submitRender(form, (f) => setProgress(f))

      for (;;) {
        if (cancelled.current) return false
        const job = await getJob(jobId)
        setNotes(job.notes)
        if (job.status === 'failed') throw new Error(job.error ?? 'Render failed')
        if (job.status === 'done' && job.output) {
          setPhase('loading')
          setProgress(1)
          setMessage('Loading the preview into the player')
          const file = await fetchOutput(jobId, job.output)
          await onRendered({ file, output: job.output, notes: job.notes })
          setPhase('done')
          setMessage(`Preview ready: ${job.output.width}×${job.output.height}, ${r1(job.output.duration)}s, ${formatSize(job.output.size)}`)
          return true
        }
        setPhase(job.status === 'rendering' ? 'rendering' : 'checking')
        setProgress(job.status === 'rendering' ? job.progress : 0)
        setMessage(job.message)
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (err) {
      setPhase('failed')
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      // The player holds the file now; the temporary job folder can go.
      if (jobId) void deleteJob(jobId)
    }
  }

  const state: RenderState = { phase, busy, progress, message, error, notes }
  return { ...state, run, reset }
}
