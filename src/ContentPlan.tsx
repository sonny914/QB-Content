import { useEffect, useMemo, useRef, useState, type ChangeEvent, type Dispatch } from 'react'
import type { Action, PlanState, RenderSource } from './workspace/model'
import {
  EMPTY_GRAPHIC,
  GRAPHIC_LIMITS,
  GRAPHIC_TEMPLATES,
  MAX_SECONDS,
  MIN_SECONDS,
  PLAN_INPUT_FIELDS,
  graphicReadingSeconds,
  parsePlan,
  planSummary,
  scaleScenes,
  totalSeconds,
  type GraphicSpec,
  type PlanScene,
} from './workspace/plan'
import { buildPlanningPrompt } from './workspace/planPrompt'
import { mediaDuration, type RenderHealth, type TimelineEntry } from './workspace/renderClient'
import { fileKey, formatSize, r1, toLibraryAssets, type LibraryAsset } from './workspace/assets'
import { useRender, type RenderedPreview } from './workspace/useRender'
import { RenderStatus, serviceReady } from './RenderStatus'

const now = () => new Date().toISOString()

const TEMPLATE_HELP: Record<GraphicSpec['template'], string> = {
  title: 'Headline with an optional support line.',
  card: 'A labelled card; items enter one by one.',
  notes: 'Separate notes scattered across the frame; optionally gathering into one card.',
  question: 'A closing question with an orange rule.',
}

interface Props {
  plan: PlanState
  dispatch: Dispatch<Action>
  health: RenderHealth | null
  onRendered: (preview: RenderedPreview, source: RenderSource) => Promise<void> | void
}

/** The scene → asset arrangement plus the voiceover, as a string the model can compare renders against. */
export function arrangementFingerprint(
  scenes: PlanScene[],
  assignments: Record<string, number | undefined>,
  library: LibraryAsset[],
  voice: File | null,
): string | null {
  if (scenes.length === 0 || (!voice && Object.keys(assignments).length === 0)) return null
  const byId = new Map(library.map((a) => [a.id, a]))
  return JSON.stringify({
    voice: fileKey(voice),
    scenes: scenes.map((s) => [s.id, s.seconds, s.kind === 'graphic' ? 'graphic' : fileKey(byId.get(assignments[s.id] ?? -1)?.file ?? null)]),
  })
}

/** A starting graphic for a scene switched from asset to graphic: its first sentence as the headline. */
export function defaultGraphicFor(scene: PlanScene): GraphicSpec {
  const first = scene.narration.split(/(?<=[.!?])\s+/)[0] ?? scene.narration
  return { ...EMPTY_GRAPHIC, headline: first.slice(0, GRAPHIC_LIMITS.headline).trim() || 'Headline' }
}

export default function ContentPlan({ plan, dispatch, health, onRendered }: Props) {
  const [pasted, setPasted] = useState('')
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [showPrompt, setShowPrompt] = useState(false)
  const [library, setLibrary] = useState<LibraryAsset[]>([])
  const [assignments, setAssignments] = useState<Record<string, number | undefined>>({})
  const [voice, setVoice] = useState<{ file: File; duration: number | null } | null>(null)
  const render = useRender()
  const assetInput = useRef<HTMLInputElement>(null)
  const voiceInput = useRef<HTMLInputElement>(null)

  const imported = plan.imported
  const scenes = imported?.scenes ?? []
  const prompt = useMemo(() => buildPlanningPrompt(plan.inputs), [plan.inputs])
  const busy = render.busy

  useEffect(() => () => library.forEach((a) => URL.revokeObjectURL(a.url)), [library])

  // Tell the model what the current arrangement is, so a render made from an older one reads as stale.
  const fingerprint = arrangementFingerprint(scenes, assignments, library, voice?.file ?? null)
  useEffect(() => {
    dispatch({ type: 'setArrangement', fingerprint })
  }, [dispatch, fingerprint])

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied('copied')
    } catch {
      setCopied('failed')
      setShowPrompt(true)
    }
    setTimeout(() => setCopied('idle'), 4000)
  }

  function importPlan() {
    const result = parsePlan(pasted)
    if (!result.ok) {
      setImportErrors(result.errors)
      setImportWarnings([])
      return
    }
    if (imported && !window.confirm(`Replace plan v${plan.version} with the pasted one? Your scene edits in the current plan will be lost. This creates plan v${plan.version + 1}.`)) {
      return
    }
    setImportErrors([])
    setImportWarnings(result.warnings)
    dispatch({ type: 'importPlan', plan: result.plan, at: now() })
    // A new plan means new scenes: assignments to the old ones are dropped.
    setAssignments({})
    setPasted('')
    render.reset()
  }

  async function onPickAssets(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    const added = await toLibraryAssets(files)
    setLibrary((list) => [...list, ...added])
  }

  async function onPickVoice(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setVoice({ file, duration: await mediaDuration(file, 'audio') })
  }

  function removeFromLibrary(id: number) {
    setLibrary((list) => list.filter((a) => a.id !== id))
    setAssignments((map) => Object.fromEntries(Object.entries(map).filter(([, v]) => v !== id)))
  }

  function scaleToVoice() {
    if (!imported || voice?.duration == null) return
    const target = r1(voice.duration)
    dispatch({ type: 'replaceScenes', scenes: scaleScenes(imported.scenes, target), reason: `scene durations scaled to the voiceover (${target}s)`, at: now() })
  }

  const commit = () => dispatch({ type: 'commitPlan', at: now() })

  function setKind(i: number, kind: PlanScene['kind']) {
    const scene = scenes[i]
    if (kind === 'graphic' && !scene.graphic) dispatch({ type: 'editScene', index: i, field: 'graphic', value: defaultGraphicFor(scene), at: now() })
    else dispatch({ type: 'editScene', index: i, field: 'kind', value: kind, at: now() })
    commit()
  }

  function setGraphic(i: number, patch: Partial<GraphicSpec>, commitNow = false) {
    const current = scenes[i].graphic ?? EMPTY_GRAPHIC
    let next: GraphicSpec = { ...current, ...patch }
    if (next.template !== 'notes') next = { ...next, gather: false }
    if (typeof next.emphasize === 'number' && next.emphasize >= next.items.length) next = { ...next, emphasize: null }
    dispatch({ type: 'editScene', index: i, field: 'graphic', value: next, at: now() })
    if (commitNow) commit()
  }

  function createFromPlan() {
    if (!imported) return
    const byId = new Map(library.map((a) => [a.id, a]))
    const assets: File[] = []
    const timeline: TimelineEntry[] = []
    for (const s of scenes) {
      if (s.kind === 'graphic' && s.graphic) {
        timeline.push({ seconds: s.seconds, source: 'graphic', graphic: s.graphic })
      } else {
        const asset = byId.get(assignments[s.id] ?? -1)
        if (!asset) return
        assets.push(asset.file)
        timeline.push({ seconds: s.seconds, source: 'asset' })
      }
    }
    const source: RenderSource = { planVersion: plan.version, fingerprint: fingerprint ?? '' }
    void render.run({ voice: voice?.file ?? null, assets, timeline }, (preview) => onRendered(preview, source))
  }

  const timeline = totalSeconds(scenes)
  const voiceDuration = voice?.duration ?? null
  const assetScenes = scenes.filter((s) => s.kind !== 'graphic')
  const unassigned = assetScenes.filter((s) => assignments[s.id] === undefined || !library.some((a) => a.id === assignments[s.id]))
  const graphicProblems = scenes.flatMap((s, i) => (s.kind === 'graphic' && !(s.graphic?.headline ?? '').trim() ? [i + 1] : []))
  const canCreate = Boolean(imported && unassigned.length === 0 && graphicProblems.length === 0 && serviceReady(health) && !busy)
  const byId = new Map(library.map((a) => [a.id, a]))

  return (
    <section className="panel" aria-labelledby="plan-h">
      <div className="panel-head">
        <h2 id="plan-h">Content plan{plan.version > 0 ? ` · v${plan.version}` : ''}</h2>
        <span className="status-meta">Written in your own Claude session</span>
      </div>

      <p className="empty">
        Describe the reel, copy the planning prompt into your own Claude session, then paste the JSON it returns. The app
        doesn't call Claude or any AI service: it only writes the instructions and checks the answer.
      </p>

      {PLAN_INPUT_FIELDS.map((f) => {
        const id = `plan-${f.key}`
        const common = {
          id,
          value: plan.inputs[f.key],
          placeholder: f.hint,
          onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => dispatch({ type: 'planInput', field: f.key, value: e.target.value }),
        }
        return (
          <div className="field" key={f.key}>
            <label htmlFor={id}>{f.label}</label>
            {f.multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />}
          </div>
        )
      })}

      <div className="field">
        <div className="row">
          <button type="button" className="btn btn-outline" onClick={copyPrompt} data-testid="copy-prompt">
            Copy planning prompt
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setShowPrompt((v) => !v)} aria-expanded={showPrompt}>
            {showPrompt ? 'Hide the prompt' : 'Show the prompt'}
          </button>
          <span className="status-meta" aria-live="polite" data-testid="copy-status">
            {copied === 'copied' ? 'Copied to the clipboard.' : copied === 'failed' ? "This browser wouldn't copy. Select the text below instead." : ''}
          </span>
        </div>
        <p className="status-meta">
          This copies written instructions to your clipboard. It does not call Claude, any AI service, or anything outside this
          page. Paste it into your own Claude session; when Claude replies with JSON, paste that JSON below. The prompt tells
          Claude to use only the facts above and to list anything else under "claims to verify".
        </p>
        {showPrompt && <textarea className="prompt" readOnly rows={14} value={prompt} aria-label="Planning prompt" data-testid="prompt-text" />}
      </div>

      <div className="field">
        <label htmlFor="plan-paste">Paste Claude's JSON reply</label>
        <textarea
          id="plan-paste"
          rows={5}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder='{ "format": "qb-content-plan", "version": 1, ... }'
          disabled={busy}
        />
        <div className="row">
          <button type="button" className="btn btn-outline" onClick={importPlan} disabled={busy || !pasted.trim()} data-testid="import-plan">
            {imported ? 'Import as a new plan version' : 'Import plan'}
          </button>
        </div>
        {importErrors.length > 0 && (
          <div className="error" role="alert" data-testid="import-errors">
            <strong>Not imported. {imported ? `Plan v${plan.version} is unchanged.` : ''}</strong>
            <ul>
              {importErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {importWarnings.length > 0 && (
          <ul className="notes" data-testid="import-warnings">
            {importWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>

      {imported && (
        <>
          <div className="field">
            <span className="field-label">Hooks</span>
            <div className="hooks" role="radiogroup" aria-label="Hook options" data-testid="hooks">
              {imported.hooks.map((h, i) => (
                <label key={i} className="hook">
                  <input
                    type="radio"
                    name="hook"
                    checked={imported.recommendedHook === i}
                    onChange={() => dispatch({ type: 'chooseHook', index: i, at: now() })}
                    disabled={busy}
                  />
                  <span>{h}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Script</span>
            <blockquote className="script" data-testid="plan-script">
              {imported.script}
            </blockquote>
          </div>

          {imported.claimsToVerify.length > 0 && (
            <div className="warn" data-testid="claims">
              <strong>Verify before publishing.</strong> These are not from your supplied information:
              <ul>
                {imported.claimsToVerify.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="field">
            <span className="field-label" id="plan-voice-label">Your recorded voiceover (optional for a silent preview)</span>
            <div className="row">
              <button type="button" className="btn btn-quiet" onClick={() => voiceInput.current?.click()} disabled={busy}>
                {voice ? 'Replace voiceover' : 'Choose voiceover'}
              </button>
              <input
                ref={voiceInput}
                type="file"
                accept="audio/*,.m4a,.aac,.opus"
                className="visually-hidden"
                aria-labelledby="plan-voice-label"
                data-testid="plan-voice-input"
                onChange={onPickVoice}
              />
              {voice && (
                <span className="status-meta" data-testid="plan-voice-info">
                  {voice.file.name} · {formatSize(voice.file.size)}
                  {voice.duration !== null ? ` · ${r1(voice.duration)}s` : ' · length unknown in this browser'}
                </span>
              )}
              {voice?.duration != null && Math.abs(timeline - r1(voice.duration)) > 0.05 && (
                <button type="button" className="btn btn-quiet btn-small" onClick={scaleToVoice} disabled={busy} data-testid="scale-to-voice">
                  Scale scenes to {r1(voice.duration)}s
                </button>
              )}
            </div>
            {voice && <p className="status-meta">The recording is included as-is. Scene timing is not aligned to the speech automatically.</p>}
          </div>

          <div className="field">
            <span className="field-label" id="plan-assets-label">Your images and clips (for scenes set to "Uploaded asset")</span>
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
                aria-labelledby="plan-assets-label"
                data-testid="plan-asset-input"
                onChange={onPickAssets}
              />
              <span className="status-meta">Then pick one for each asset scene below.</span>
            </div>
            {library.length > 0 && (
              <ul className="library" data-testid="library">
                {library.map((a, i) => (
                  <li key={a.id} className="library-item">
                    {a.kind === 'image' ? <img className="thumb thumb-sm" src={a.url} alt="" /> : <video className="thumb thumb-sm" src={a.url} muted playsInline preload="metadata" />}
                    <span className="asset-name">
                      {i + 1}. {a.file.name}
                      <span className="status-meta"> · {a.kind}{a.sourceDuration !== null && ` · ${r1(a.sourceDuration)}s`}</span>
                    </span>
                    <button type="button" className="btn btn-quiet btn-small" onClick={() => removeFromLibrary(a.id)} disabled={busy} aria-label={`Remove ${a.file.name} from the library`}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="field">
            <span className="field-label">Scenes</span>
            <ol className="scenes" data-testid="scenes">
              {scenes.map((s, i) => {
                const asset = byId.get(assignments[s.id] ?? -1)
                const short = s.kind !== 'graphic' && asset?.kind === 'video' && asset.sourceDuration !== null && asset.sourceDuration < s.seconds - 0.05
                const g = s.graphic ?? EMPTY_GRAPHIC
                const readNeed = s.kind === 'graphic' ? graphicReadingSeconds(g) : 0
                return (
                  <li key={s.id} className="scene" data-testid="scene">
                    <div className="scene-head">
                      <strong>Scene {i + 1}</strong>
                      <label className="seconds">
                        <input
                          type="number"
                          min={MIN_SECONDS}
                          max={MAX_SECONDS}
                          step={0.1}
                          value={s.seconds}
                          aria-label={`Seconds for scene ${i + 1}`}
                          disabled={busy}
                          onChange={(e) => dispatch({ type: 'editScene', index: i, field: 'seconds', value: Number(e.target.value), at: now() })}
                          onBlur={commit}
                        />
                        <span>s</span>
                      </label>
                    </div>
                    <label className="scene-field">
                      <span className="field-label">Narration</span>
                      <textarea
                        rows={2}
                        value={s.narration}
                        aria-label={`Narration for scene ${i + 1}`}
                        disabled={busy}
                        onChange={(e) => dispatch({ type: 'editScene', index: i, field: 'narration', value: e.target.value, at: now() })}
                        onBlur={commit}
                      />
                    </label>
                    <label className="scene-field">
                      <span className="field-label">Visual (description for people, not read by the renderer)</span>
                      <textarea
                        rows={2}
                        value={s.visual}
                        aria-label={`Visual for scene ${i + 1}`}
                        disabled={busy}
                        onChange={(e) => dispatch({ type: 'editScene', index: i, field: 'visual', value: e.target.value, at: now() })}
                        onBlur={commit}
                      />
                    </label>

                    <div className="scene-field">
                      <span className="field-label">Visual source</span>
                      <div className="row" role="radiogroup" aria-label={`Visual source for scene ${i + 1}`}>
                        <label className="choice">
                          <input type="radio" name={`kind-${s.id}`} checked={s.kind !== 'graphic'} disabled={busy} onChange={() => setKind(i, 'asset')} />
                          <span>Uploaded asset</span>
                        </label>
                        <label className="choice">
                          <input type="radio" name={`kind-${s.id}`} checked={s.kind === 'graphic'} disabled={busy} onChange={() => setKind(i, 'graphic')} />
                          <span>Motion graphic</span>
                        </label>
                      </div>
                    </div>

                    {s.kind === 'graphic' ? (
                      <div className="graphic-editor" data-testid="graphic-editor">
                        <label className="scene-field">
                          <span className="field-label">Template</span>
                          <select value={g.template} aria-label={`Template for scene ${i + 1}`} disabled={busy} onChange={(e) => setGraphic(i, { template: e.target.value as GraphicSpec['template'] }, true)}>
                            {GRAPHIC_TEMPLATES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <span className="status-meta">{TEMPLATE_HELP[g.template]}</span>
                        </label>
                        <div className="row">
                          <label className="scene-field grow">
                            <span className="field-label">Label (small caps)</span>
                            <input type="text" value={g.label} maxLength={GRAPHIC_LIMITS.label} aria-label={`Label for scene ${i + 1}`} disabled={busy} onChange={(e) => setGraphic(i, { label: e.target.value })} onBlur={commit} placeholder="e.g. Morning" />
                          </label>
                        </div>
                        <label className="scene-field">
                          <span className="field-label">Headline (required, {GRAPHIC_LIMITS.headline} characters max)</span>
                          <input type="text" value={g.headline} maxLength={GRAPHIC_LIMITS.headline} aria-label={`Headline for scene ${i + 1}`} disabled={busy} onChange={(e) => setGraphic(i, { headline: e.target.value })} onBlur={commit} />
                        </label>
                        <label className="scene-field">
                          <span className="field-label">Supporting text (optional)</span>
                          <textarea rows={2} value={g.support} maxLength={GRAPHIC_LIMITS.support} aria-label={`Supporting text for scene ${i + 1}`} disabled={busy} onChange={(e) => setGraphic(i, { support: e.target.value })} onBlur={commit} />
                        </label>
                        <div className="scene-field">
                          <span className="field-label">Items (up to {GRAPHIC_LIMITS.items}, label and text)</span>
                          {g.items.map((it, j) => (
                            <div className="row item-row" key={j}>
                              <input type="text" value={it.label} maxLength={GRAPHIC_LIMITS.itemLabel} aria-label={`Item ${j + 1} label for scene ${i + 1}`} placeholder="Label" disabled={busy} onChange={(e) => setGraphic(i, { items: g.items.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)) })} onBlur={commit} />
                              <input type="text" value={it.text} maxLength={GRAPHIC_LIMITS.itemText} aria-label={`Item ${j + 1} text for scene ${i + 1}`} placeholder="Text" disabled={busy} onChange={(e) => setGraphic(i, { items: g.items.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })} onBlur={commit} />
                              <button type="button" className="btn btn-quiet btn-small" disabled={busy} aria-label={`Remove item ${j + 1} from scene ${i + 1}`} onClick={() => setGraphic(i, { items: g.items.filter((_, k) => k !== j) }, true)}>
                                Remove
                              </button>
                            </div>
                          ))}
                          <div className="row">
                            <button type="button" className="btn btn-quiet btn-small" disabled={busy || g.items.length >= GRAPHIC_LIMITS.items} onClick={() => setGraphic(i, { items: [...g.items, { label: '', text: '' }] })}>
                              Add item
                            </button>
                          </div>
                        </div>
                        <div className="row">
                          <label className="scene-field">
                            <span className="field-label">Emphasis (turns orange mid-scene)</span>
                            <select
                              value={g.emphasize === null ? '' : String(g.emphasize)}
                              aria-label={`Emphasis for scene ${i + 1}`}
                              disabled={busy}
                              onChange={(e) => setGraphic(i, { emphasize: e.target.value === '' ? null : e.target.value === 'headline' ? 'headline' : Number(e.target.value) }, true)}
                            >
                              <option value="">None</option>
                              <option value="headline">Headline</option>
                              {g.items.map((it, j) => (
                                <option key={j} value={j}>
                                  Item {j + 1}{it.label ? `: ${it.label}` : ''}
                                </option>
                              ))}
                            </select>
                          </label>
                          {g.template === 'notes' && (
                            <label className="choice">
                              <input type="checkbox" checked={g.gather} disabled={busy} onChange={(e) => setGraphic(i, { gather: e.target.checked }, true)} />
                              <span>Gather the notes into one card mid-scene</span>
                            </label>
                          )}
                        </div>
                        <p className={readNeed > s.seconds + 0.05 ? 'warn-line' : 'status-meta'} data-testid="reading-time">
                          About {readNeed}s to read{readNeed > s.seconds + 0.05 ? `, but the scene is ${s.seconds}s. Give it more time or fewer words.` : ` · scene is ${s.seconds}s.`}
                        </p>
                      </div>
                    ) : (
                      <label className="scene-field">
                        <span className="field-label">Asset for this scene</span>
                        <div className="row">
                          {asset && (asset.kind === 'image' ? <img className="thumb thumb-sm" src={asset.url} alt="" /> : <video className="thumb thumb-sm" src={asset.url} muted playsInline preload="metadata" />)}
                          <select
                            value={assignments[s.id] ?? ''}
                            aria-label={`Asset for scene ${i + 1}`}
                            disabled={busy || library.length === 0}
                            onChange={(e) => setAssignments((map) => ({ ...map, [s.id]: e.target.value === '' ? undefined : Number(e.target.value) }))}
                          >
                            <option value="">{library.length === 0 ? 'Add images or clips first' : 'Choose an asset'}</option>
                            {library.map((a, j) => (
                              <option key={a.id} value={a.id}>
                                {j + 1}. {a.file.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </label>
                    )}
                    {short && (
                      <p className="warn-line" data-testid="scene-short-clip">
                        This clip is {r1(asset.sourceDuration!)}s but the scene is {s.seconds}s: its last frame will hold for {r1(s.seconds - asset.sourceDuration!)}s.
                      </p>
                    )}
                  </li>
                )
              })}
            </ol>
          </div>

          <p className="status-meta" data-testid="plan-timeline">
            Timeline {timeline}s
            {voiceDuration !== null && ` · voiceover ${r1(voiceDuration)}s`}
            {voiceDuration === null && ' · no voiceover: the preview will be silent'}
            {voiceDuration !== null && timeline < voiceDuration - 0.05 && <span className="warn-line"> · narration will be cut off at {timeline}s</span>}
            {voiceDuration !== null && timeline > voiceDuration + 0.05 && <span className="warn-line"> · the last {r1(timeline - voiceDuration)}s will be silent</span>}
          </p>

          <div className="actions">
            <button type="button" className="btn btn-outline" onClick={createFromPlan} disabled={!canCreate} data-testid="create-from-plan">
              {busy ? 'Working…' : voice ? `Create preview from plan v${plan.version}` : `Create silent preview from plan v${plan.version}`}
            </button>
          </div>
          <ul className="blockers" data-testid="plan-blockers">
            {!voice && <li>No voiceover chosen: the preview will be rendered silent and labelled as such.</li>}
            {unassigned.length > 0 && <li>Assign an asset to {unassigned.length === assetScenes.length ? 'every asset scene' : `scene${unassigned.length === 1 ? '' : 's'} ${unassigned.map((s) => scenes.indexOf(s) + 1).join(', ')}`}, or switch {unassigned.length === 1 && assetScenes.length > 1 ? 'it to a motion graphic' : 'them to motion graphics'}.</li>}
            {graphicProblems.length > 0 && <li>Give scene{graphicProblems.length === 1 ? '' : 's'} {graphicProblems.join(', ')} a headline.</li>}
            {!serviceReady(health) && health !== null && <li>The local render service isn't available (see the notice above).</li>}
          </ul>
          <RenderStatus state={render} testId="plan-render-status" />
          <p className="status-meta">{imported ? `Plan v${plan.version}: ${planSummary(imported)}.` : ''}</p>
        </>
      )}
    </section>
  )
}
