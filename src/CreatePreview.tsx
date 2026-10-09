import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  deleteJob,
  fetchHealth,
  fetchOutput,
  getJob,
  mediaDuration,
  submitRender,
  type RenderHealth,
  type RenderOutput,
} from './workspace/renderClient'

const MIN_SECONDS = 0.5
const MAX_SECONDS = 300
const r1 = (n: number) => Math.round(n * 10) / 10

interface Asset {
  id: number
  file: File
  kind: 'image' | 'video'
  url: string
  /** Source clip length when the browser can read it; null for images or undecodable clips. */
  sourceDuration: number | null
  seconds: number
}

type Phase = 'idle' | 'uploading' | 'checking' | 'rendering' | 'loading' | 'done' | 'failed'

export interface RenderedPreview {
  file: File
  output: RenderOutput
  notes: string[]
}

interface Props {
  onRendered: (preview: RenderedPreview) => Promise<void> | void
}

/** Split the voiceover length evenly, in tenths of a second, with the last asset absorbing rounding. */
export function evenSplit(total: number, count: number): number[] {
  if (count === 0) return []
  const each = Math.max(MIN_SECONDS, r1(total / count))
  const out = Array.from({ length: count }, () => each)
  out[count - 1] = Math.max(MIN_SECONDS, r1(total - each * (count - 1)))
  return out
}

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

export default function CreatePreview({ onRendered }: Props) {
  const [health, setHealth] = useState<RenderHealth | null>(null)
  const [voice, setVoice] = useState<{ file: File; duration: number | null } | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [autoSplit, setAutoSplit] = useState(true)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  const nextId = useRef(1)
  const voiceInput = useRef<HTMLInputElement>(null)
  const assetInput = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    let alive = true
    fetchHealth().then((h) => alive && setHealth(h))
    return () => {
      alive = false
    }
  }, [])

  // Object URLs for thumbnails are released when an asset leaves the list or the panel unmounts.
  useEffect(() => () => assets.forEach((a) => URL.revokeObjectURL(a.url)), [assets])
  useEffect(() => () => void (cancelled.current = true), [])

  const busy = phase === 'uploading' || phase === 'checking' || phase === 'rendering' || phase === 'loading'
  const timeline = r1(assets.reduce((sum, a) => sum + a.seconds, 0))
  const voiceDuration = voice?.duration ?? null
  const serviceOk = health?.reachable === true && health.ok

  function applySplit(list: Asset[], total: number | null): Asset[] {
    if (total === null || list.length === 0) return list
    const split = evenSplit(total, list.length)
    return list.map((a, i) => ({ ...a, seconds: split[i] }))
  }

  async function onPickVoice(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const duration = await mediaDuration(file, 'audio')
    setVoice({ file, duration })
    setPhase('idle')
    setError('')
    if (autoSplit) setAssets((list) => applySplit(list, duration))
  }

  async function onPickAssets(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    const added: Asset[] = []
    for (const file of files) {
      const kind: Asset['kind'] = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|3gp)$/i.test(file.name) ? 'video' : 'image'
      added.push({
        id: nextId.current++,
        file,
        kind,
        url: URL.createObjectURL(file),
        sourceDuration: kind === 'video' ? await mediaDuration(file, 'video') : null,
        seconds: 3,
      })
    }
    setPhase('idle')
    setError('')
    setAssets((list) => {
      const merged = [...list, ...added]
      return autoSplit ? applySplit(merged, voiceDuration) : merged
    })
  }

  function update(id: number, patch: Partial<Asset>) {
    setAssets((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  function setSeconds(id: number, value: number) {
    setAutoSplit(false)
    update(id, { seconds: Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, r1(value))) })
  }

  function move(id: number, dir: -1 | 1) {
    setAssets((list) => {
      const i = list.findIndex((a) => a.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= list.length) return list
      const next = [...list]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function remove(id: number) {
    setAssets((list) => {
      const next = list.filter((a) => a.id !== id)
      return autoSplit ? applySplit(next, voiceDuration) : next
    })
  }

  function divideEvenly() {
    setAutoSplit(true)
    setAssets((list) => applySplit(list, voiceDuration))
  }

  async function create() {
    if (!voice || assets.length === 0 || busy) return
    cancelled.current = false
    setError('')
    setNotes([])
    setProgress(0)
    setPhase('uploading')
    setMessage('Sending files to the local render process')
    let jobId: string | null = null
    try {
      const form = new FormData()
      form.append('durations', JSON.stringify(assets.map((a) => a.seconds)))
      form.append('voiceover', voice.file, voice.file.name)
      for (const a of assets) form.append('asset', a.file, a.file.name)
      jobId = await submitRender(form, (f) => setProgress(f))

      // Poll until the service reports done or failed.
      for (;;) {
        if (cancelled.current) return
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
          break
        }
        setPhase(job.status === 'rendering' ? 'rendering' : 'checking')
        setProgress(job.status === 'rendering' ? job.progress : 0)
        setMessage(job.message)
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (err) {
      setPhase('failed')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      // The player holds the file now; the temporary job folder can go.
      if (jobId) void deleteJob(jobId)
    }
  }

  const canCreate = Boolean(voice && assets.length > 0 && serviceOk && !busy)

  return (
    <section className="panel" aria-labelledby="create-h">
      <div className="panel-head">
        <h2 id="create-h">Create a preview</h2>
        <span className="status-meta">Assembles your files. No generation.</span>
      </div>
      <p className="empty">
        Your recorded voiceover plus images or clips, each shown for a set number of seconds, rendered on this computer
        into a vertical 720×1280 MP4. Clip audio is muted so it can't compete with the narration.
      </p>

      {health === null ? (
        <p className="empty">Checking the local render service…</p>
      ) : !health.reachable ? (
        <div className="warn" role="alert" data-testid="service-warning">
          <strong>{health.error}</strong> Start the app with <code>npm run dev</code>, which runs the page and the render
          service together, or run <code>npm run render-service</code> in a second terminal.
        </div>
      ) : !health.ok ? (
        <div className="warn" role="alert" data-testid="service-warning">
          <strong>Rendering is unavailable: {health.tools.problem}</strong> The render service needs FFmpeg with
          ffprobe, libx264 and AAC on this computer, on the PATH. Install it and restart <code>npm run dev</code>:
          Windows <code>winget install Gyan.FFmpeg</code> (then open a new terminal), macOS{' '}
          <code>brew install ffmpeg</code>, Debian/Ubuntu <code>sudo apt install ffmpeg</code>.
        </div>
      ) : null}

      <div className="field">
        <span className="field-label" id="voice-label">Voiceover</span>
        <div className="row">
          <button type="button" className="btn btn-quiet" onClick={() => voiceInput.current?.click()} disabled={busy}>
            {voice ? 'Replace voiceover' : 'Choose voiceover'}
          </button>
          <input
            ref={voiceInput}
            type="file"
            accept="audio/*,.m4a,.aac,.opus"
            className="visually-hidden"
            aria-labelledby="voice-label"
            data-testid="voice-input"
            onChange={onPickVoice}
          />
          {voice && (
            <span className="status-meta" data-testid="voice-info">
              {voice.file.name} · {formatSize(voice.file.size)}
              {voice.duration !== null ? ` · ${r1(voice.duration)}s` : ' · length unknown in this browser'}
            </span>
          )}
        </div>
      </div>

      <div className="field">
        <span className="field-label" id="assets-label">Images and clips, in order</span>
        <div className="row">
          <button type="button" className="btn btn-quiet" onClick={() => assetInput.current?.click()} disabled={busy}>
            Add images or clips
          </button>
          <input
            ref={assetInput}
            type="file"
            accept="image/*,video/*"
            multiple
            className="visually-hidden"
            aria-labelledby="assets-label"
            data-testid="asset-input"
            onChange={onPickAssets}
          />
          {assets.length > 1 && (
            <button type="button" className="btn btn-quiet" onClick={divideEvenly} disabled={busy || voiceDuration === null}>
              Divide evenly
            </button>
          )}
        </div>
        {assets.length > 0 && (
          <ol className="assets" data-testid="assets">
            {assets.map((a, i) => {
              const short = a.kind === 'video' && a.sourceDuration !== null && a.sourceDuration < a.seconds - 0.05
              return (
                <li key={a.id} className="asset">
                  {a.kind === 'image' ? (
                    <img className="thumb" src={a.url} alt="" />
                  ) : (
                    <video className="thumb" src={a.url} muted playsInline preload="metadata" />
                  )}
                  <div className="asset-main">
                    <div className="asset-name">
                      {i + 1}. {a.file.name}
                      <span className="status-meta">
                        {' '}
                        · {a.kind}
                        {a.sourceDuration !== null && ` · ${r1(a.sourceDuration)}s long`}
                      </span>
                    </div>
                    <div className="row">
                      <label className="seconds">
                        <input
                          type="number"
                          min={MIN_SECONDS}
                          max={MAX_SECONDS}
                          step={0.1}
                          value={a.seconds}
                          aria-label={`Seconds for asset ${i + 1}`}
                          disabled={busy}
                          onChange={(e) => setSeconds(a.id, Number(e.target.value))}
                        />
                        <span>s</span>
                      </label>
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => move(a.id, -1)} disabled={busy || i === 0} aria-label={`Move asset ${i + 1} up`}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => move(a.id, 1)} disabled={busy || i === assets.length - 1} aria-label={`Move asset ${i + 1} down`}>
                        ↓
                      </button>
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => remove(a.id)} disabled={busy} aria-label={`Remove asset ${i + 1}`}>
                        Remove
                      </button>
                    </div>
                    {short && (
                      <p className="warn-line" data-testid="short-clip">
                        This clip is {r1(a.sourceDuration!)}s but set to {a.seconds}s: its last frame will hold for{' '}
                        {r1(a.seconds - a.sourceDuration!)}s.{' '}
                        <button type="button" className="link" onClick={() => setSeconds(a.id, a.sourceDuration!)} disabled={busy}>
                          Use clip length
                        </button>
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>

      {assets.length > 0 && (
        <p className="status-meta" data-testid="timeline">
          Timeline {timeline}s
          {voiceDuration !== null && ` · voiceover ${r1(voiceDuration)}s`}
          {voiceDuration !== null && timeline < voiceDuration - 0.05 && (
            <span className="warn-line"> · narration will be cut off at {timeline}s</span>
          )}
          {voiceDuration !== null && timeline > voiceDuration + 0.05 && (
            <span className="warn-line"> · the last {r1(timeline - voiceDuration)}s will be silent</span>
          )}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn btn-outline" onClick={create} disabled={!canCreate} data-testid="create-preview">
          {busy ? 'Working…' : 'Create preview'}
        </button>
      </div>

      {phase !== 'idle' && (
        <div className="render-status" aria-live="polite" data-testid="render-status">
          {busy && (
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          <p className={phase === 'failed' ? 'error' : 'status-meta'} data-testid="render-message">
            {phase === 'failed' ? error : `${message}${busy && phase !== 'checking' ? ` · ${Math.round(progress * 100)}%` : ''}`}
          </p>
          {notes.length > 0 && (
            <ul className="notes" data-testid="render-notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
