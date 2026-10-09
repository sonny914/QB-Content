import { useEffect, useReducer, useRef, useState, type ChangeEvent } from 'react'
import {
  approvalBlockers,
  BRIEF_FIELDS,
  currentVideo,
  isApprovalCurrent,
  reducer,
  snapshot,
  EMPTY_BRIEF,
  type ActivityEntry,
  type Status,
} from './workspace/model'
import { SAMPLE_BRIEF } from './workspace/sample'
import { identifyVideo } from './workspace/hash'
import { browserStorage, clearState, loadState, saveState } from './workspace/storage'

const NOTE_DRAFT_KEY = 'qb-content:revision-note-draft:v1'
const now = () => new Date().toISOString()

const STATUS_LABEL: Record<Status, string> = {
  draft: 'Draft',
  changes_requested: 'Changes requested',
  approved: 'Approved',
}

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const shortHash = (hash: string) => (hash.startsWith('sha256:') ? `SHA-256 ${hash.slice(7, 19)}…` : 'name/size fingerprint')

function readNoteDraft(store: Storage | null) {
  try {
    return store?.getItem(NOTE_DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

export default function App() {
  const store = useRef(browserStorage()).current
  const [state, dispatch] = useReducer(reducer, null, () => loadState(store, now()))
  const [saved, setSaved] = useState(true)
  const [note, setNote] = useState(() => readNoteDraft(store as Storage | null))
  const [noteError, setNoteError] = useState('')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [playError, setPlayError] = useState(false)
  const [fileError, setFileError] = useState('')
  const fileCheckId = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const noteInput = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setSaved(saveState(store, state)), [store, state])

  useEffect(() => {
    try {
      store?.setItem(NOTE_DRAFT_KEY, note)
    } catch {
      // Draft note is a convenience; the saved-state banner covers storage failures.
    }
  }, [store, note])

  useEffect(() => () => void (videoUrl && URL.revokeObjectURL(videoUrl)), [videoUrl])

  const blockers = approvalBlockers(state)
  const approvedNow = isApprovalCurrent(state)
  const attached = state.session.attached
  const pairedVideo = currentVideo(state)
  const briefEmpty = snapshot(state.brief) === snapshot(EMPTY_BRIEF)

  async function onPickVideo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const checkId = ++fileCheckId.current
    setChecking(true)
    setFileError('')
    try {
      const video = await identifyVideo(file)
      if (checkId !== fileCheckId.current) return
      setPlayError(false)
      setVideoUrl(URL.createObjectURL(file))
      dispatch({ type: 'attach', video, at: now() })
    } catch {
      if (checkId === fileCheckId.current) {
        setFileError('Could not read or verify this file. Choose it again or try another local video. The previous preview has not changed.')
      }
    } finally {
      if (checkId === fileCheckId.current) setChecking(false)
    }
  }

  function onRequestChanges() {
    if (!note.trim()) {
      setNoteError('Write a revision note before requesting changes.')
      noteInput.current?.focus()
      return
    }
    dispatch({ type: 'requestChanges', note, at: now() })
    setNote('')
    setNoteError('')
  }

  function onLoadSample() {
    if (!briefEmpty && !window.confirm('Replace the current brief with the fictional sample? This creates a new brief version.')) return
    dispatch({ type: 'loadSample', brief: SAMPLE_BRIEF, at: now() })
  }

  function onReset() {
    if (!window.confirm('Clear the brief, notes and activity stored in this browser? This cannot be undone.')) return
    fileCheckId.current += 1
    setChecking(false)
    setFileError('')
    clearState(store)
    setNote('')
    setNoteError('')
    setVideoUrl(null)
    setPlayError(false)
    dispatch({ type: 'reset', at: now() })
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <h1 className="product">QB Content</h1>
          <span className="tag">Single-user local prototype</span>
        </div>
      </header>

      <p className="prototype-note" role="note">
        Brief text, revision notes and activity are saved in this browser only. Videos are never uploaded or stored:
        they play from your device and must be reattached after a reload.
        {!saved && <strong> This browser is refusing local storage, so changes will be lost on reload.</strong>}
      </p>

      <section className="status" aria-live="polite">
        <span className={`pill pill-${state.status}`} data-testid="status">
          {STATUS_LABEL[state.status]}
        </span>
        <span className="status-meta">
          Brief v{state.briefVersion}
          {' · '}
          {pairedVideo ? `Video v${pairedVideo.version}` : 'No video'}
        </span>
        {approvedNow && state.approval && (
          <span className="status-meta" data-testid="approval-summary">
            Approved {formatTime(state.approval.at)} for brief v{state.approval.briefVersion} + video v
            {state.approval.videoVersion}
          </span>
        )}
      </section>

      <main className="layout">
        <section className="panel brief" aria-labelledby="brief-h">
          <div className="panel-head">
            <h2 id="brief-h">Brief</h2>
            <button type="button" className="btn btn-quiet" onClick={onLoadSample}>
              Load fictional sample
            </button>
          </div>
          {state.isSample && (
            <p className="sample-flag" data-testid="sample-flag">
              Fictional sample brief. Not a real client, campaign or result.
            </p>
          )}
          {BRIEF_FIELDS.map((f) => {
            const id = `brief-${f.key}`
            const common = {
              id,
              value: state.brief[f.key],
              onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                dispatch({ type: 'edit', field: f.key, value: e.target.value, at: now() }),
              onBlur: () => dispatch({ type: 'commit', at: now() }),
            }
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>{f.label}</label>
                {f.multiline ? <textarea rows={f.key === 'script' ? 9 : 3} {...common} /> : <input type="text" {...common} />}
              </div>
            )
          })}
        </section>

        <div className="side">
          <section className="panel" aria-labelledby="video-h">
            <div className="panel-head">
              <h2 id="video-h">Video preview</h2>
              <button type="button" className="btn btn-quiet" onClick={() => fileInput.current?.click()} disabled={checking}>
                {checking ? 'Checking file…' : attached ? 'Replace video' : pairedVideo ? 'Reattach video' : 'Choose video'}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="video/*"
                className="visually-hidden"
                data-testid="video-input"
                aria-label="Choose video file"
                onChange={onPickVideo}
              />
            </div>

            {fileError && <p className="error" role="alert">{fileError}</p>}
            {attached && videoUrl ? (
              <>
                <video
                  key={videoUrl}
                  src={videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  data-testid="player"
                  onEnded={() => dispatch({ type: 'watched', at: now() })}
                  onError={() => setPlayError(true)}
                />
                {playError && (
                  <p className="error">This browser can't play this file, so it can't be reviewed or approved here.</p>
                )}
                <dl className="video-meta">
                  <div>
                    <dt>File</dt>
                    <dd>
                      {attached.name} · {formatSize(attached.size)}
                    </dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>
                      Video v{attached.version} · {shortHash(attached.hash)}
                    </dd>
                  </div>
                  <div>
                    <dt>Review</dt>
                    <dd data-testid="watched">{state.session.watched ? 'Watched to the end' : 'Not yet watched to the end'}</dd>
                  </div>
                </dl>
              </>
            ) : pairedVideo ? (
              <p className="empty" data-testid="reattach-notice">
                Video v{pairedVideo.version} ({pairedVideo.name}) was attached in an earlier session. Videos aren't stored,
                so reattach the file and watch it again before approving.
              </p>
            ) : (
              <p className="empty">No video attached. Pick a local file to preview it here. Nothing is uploaded.</p>
            )}
          </section>

          <section className="panel" aria-labelledby="review-h">
            <h2 id="review-h">Review</h2>
            <div className="field">
              <label htmlFor="revision-note">Revision note</label>
              <textarea
                id="revision-note"
                ref={noteInput}
                rows={3}
                value={note}
                aria-invalid={noteError ? true : undefined}
                aria-describedby={noteError ? 'note-error' : undefined}
                onChange={(e) => {
                  setNote(e.target.value)
                  if (noteError && e.target.value.trim()) setNoteError('')
                }}
                placeholder="What needs to change?"
              />
              {noteError && (
                <p className="error" id="note-error" role="alert">
                  {noteError}
                </p>
              )}
            </div>
            <div className="actions">
              <button type="button" className="btn btn-outline" onClick={onRequestChanges}>
                Request changes
              </button>
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => dispatch({ type: 'approve', at: now() })}
                disabled={checking || blockers.length > 0 || playError}
                aria-describedby="approve-blockers"
              >
                Approve
              </button>
            </div>
            <ul className="blockers" id="approve-blockers" data-testid="blockers">
              {(checking ? ['Checking the replacement file…'] : playError ? ['The preview must be playable.'] : blockers).map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </section>

          <section className="panel" aria-labelledby="activity-h">
            <h2 id="activity-h">Activity</h2>
            <ol className="activity" data-testid="activity">
              {[...state.activity].reverse().map((e) => (
                <ActivityItem key={e.id} entry={e} />
              ))}
            </ol>
          </section>
        </div>
      </main>

      <footer className="footer">
        <button type="button" className="btn btn-quiet" onClick={onReset}>
          Clear local data
        </button>
      </footer>
    </div>
  )
}

function ActivityItem({ entry }: { entry: ActivityEntry }) {
  return (
    <li className={`act act-${entry.kind}`}>
      <div className="act-line">
        <span className="act-text">{entry.text}</span>
        <time dateTime={entry.at}>{formatTime(entry.at)}</time>
      </div>
      {entry.note && <blockquote className="act-note">{entry.note}</blockquote>}
      <div className="act-ver">
        Brief v{entry.briefVersion}
        {entry.videoVersion !== null && ` · Video v${entry.videoVersion}`}
      </div>
    </li>
  )
}
