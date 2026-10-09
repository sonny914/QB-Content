import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { mediaDuration, type RenderHealth } from './workspace/renderClient'
import { formatSize, r1, toLibraryAssets, type LibraryAsset } from './workspace/assets'
import { useRender, type RenderedPreview } from './workspace/useRender'
import { RenderStatus, serviceReady } from './RenderStatus'

const MIN_SECONDS = 0.5
const MAX_SECONDS = 300

interface Asset extends LibraryAsset {
  seconds: number
}

interface Props {
  health: RenderHealth | null
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

/** Free-form assembly: any voiceover plus any ordered assets, no plan needed. */
export default function CreatePreview({ health, onRendered }: Props) {
  const [voice, setVoice] = useState<{ file: File; duration: number | null } | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [autoSplit, setAutoSplit] = useState(true)
  const render = useRender()
  const voiceInput = useRef<HTMLInputElement>(null)
  const assetInput = useRef<HTMLInputElement>(null)

  // Object URLs for thumbnails are released when an asset leaves the list or the panel unmounts.
  useEffect(() => () => assets.forEach((a) => URL.revokeObjectURL(a.url)), [assets])

  const busy = render.busy
  const timeline = r1(assets.reduce((sum, a) => sum + a.seconds, 0))
  const voiceDuration = voice?.duration ?? null

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
    render.reset()
    if (autoSplit) setAssets((list) => applySplit(list, duration))
  }

  async function onPickAssets(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    const added = (await toLibraryAssets(files)).map((a) => ({ ...a, seconds: 3 }))
    render.reset()
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

  function create() {
    if (!voice || assets.length === 0) return
    void render.run({ voice: voice.file, assets: assets.map((a) => a.file), durations: assets.map((a) => a.seconds) }, onRendered)
  }

  const canCreate = Boolean(voice && assets.length > 0 && serviceReady(health) && !busy)

  return (
    <section className="panel" aria-labelledby="create-h">
      <div className="panel-head">
        <h2 id="create-h">Create a preview (free-form)</h2>
        <span className="status-meta">Assembles your files. No generation.</span>
      </div>
      <p className="empty">
        Any voiceover plus any images or clips, each shown for a set number of seconds, rendered on this computer into a
        vertical 720×1280 MP4. Clip audio is muted so it can't compete with the narration. For a plan-driven reel, use the
        Content plan panel instead.
      </p>

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

      <RenderStatus state={render} testId="render-status" />
    </section>
  )
}
