import { describe, expect, it } from 'vitest'
import { approvalBlockers, initialState, isApprovalCurrent, reducer, type Action, type State } from './model'
import { SAMPLE_BRIEF } from './sample'
import { loadState, saveState, STORAGE_KEY } from './storage'

const AT = '2026-10-09T12:00:00.000Z'
const videoA = { hash: 'sha256:aaa', hashKind: 'sha256' as const, name: 'reel-a.webm', size: 100 }
const videoB = { hash: 'sha256:bbb', hashKind: 'sha256' as const, name: 'reel-b.webm', size: 200 }

const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s)
const attach = (video: typeof videoA): Action => ({ type: 'attach', video, at: AT })
const watched: Action = { type: 'watched', at: AT }
const approve: Action = { type: 'approve', at: AT }
const edit = (value: string): Action => ({ type: 'edit', field: 'hook', value, at: AT })

function memoryStore() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  }
}

const approvedState = () => run(initialState(AT), edit('Hook one'), attach(videoA), watched, approve)

describe('approval rules', () => {
  it('starts in Draft with nothing approved', () => {
    const s = initialState(AT)
    expect(s.status).toBe('draft')
    expect(s.approval).toBeNull()
    expect(s.activity.map((e) => e.kind)).toEqual(['created'])
  })

  it('blocks approval without a video', () => {
    const s = run(initialState(AT), edit('Hook'), approve)
    expect(s.status).toBe('draft')
    expect(approvalBlockers(s)).toEqual(['Attach the reel video.'])
  })

  it('blocks approval until the attached video has been watched', () => {
    const s = run(initialState(AT), attach(videoA), approve)
    expect(s.status).toBe('draft')
    expect(approvalBlockers(s)).toEqual(['Watch the preview through to the end.'])
  })

  it('approves the current brief and video version', () => {
    const s = approvedState()
    expect(s.status).toBe('approved')
    expect(isApprovalCurrent(s)).toBe(true)
    expect(s.approval).toMatchObject({ briefVersion: 2, videoHash: 'sha256:aaa', videoVersion: 1 })
    expect(s.activity.at(-1)?.text).toBe('Approved brief v2 with video v1')
  })

  it('requires a revision note to request changes', () => {
    const s0 = run(initialState(AT), attach(videoA))
    const s1 = reducer(s0, { type: 'requestChanges', note: '   ', at: AT })
    expect(s1).toBe(s0)
    const s2 = reducer(s0, { type: 'requestChanges', note: ' Tighten the hook ', at: AT })
    expect(s2.status).toBe('changes_requested')
    expect(s2.activity.at(-1)).toMatchObject({ kind: 'changes_requested', note: 'Tighten the hook' })
  })

  it('editing the brief withdraws approval', () => {
    const s = reducer(approvedState(), edit('Hook two'))
    expect(s.status).toBe('draft')
    expect(s.approval).toBeNull()
    expect(s.activity.at(-1)?.kind).toBe('approval_withdrawn')
  })

  it('replacing the video withdraws approval and needs a fresh review', () => {
    const s = reducer(approvedState(), attach(videoB))
    expect(s.status).toBe('draft')
    expect(s.approval).toBeNull()
    expect(s.session.watched).toBe(false)
    expect(currentVersion(s)).toBe(2)
    expect(s.activity.map((e) => e.kind).slice(-2)).toEqual(['video_replaced', 'approval_withdrawn'])
  })

  it('reattaching the identical file requires a fresh review', () => {
    const s = reducer(approvedState(), attach(videoA))
    expect(s.status).toBe('draft')
    expect(isApprovalCurrent(s)).toBe(false)
  })

  it('a no-op edit does not withdraw approval', () => {
    const s = reducer(approvedState(), edit('Hook one'))
    expect(s.status).toBe('approved')
  })

  it('requesting changes after approval withdraws it', () => {
    const s = reducer(approvedState(), { type: 'requestChanges', note: 'Swap the CTA', at: AT })
    expect(s.status).toBe('changes_requested')
    expect(s.approval).toBeNull()
  })

  it('editing after a change request returns to Draft, then can be approved again', () => {
    let s = run(initialState(AT), attach(videoA), watched, { type: 'requestChanges', note: 'Fix hook', at: AT })
    s = reducer(s, edit('Better hook'))
    expect(s.status).toBe('draft')
    s = reducer(s, approve)
    expect(s.status).toBe('approved')
    expect(s.approval?.briefVersion).toBe(2)
  })

  it('commits brief edits as new versions and logs the changed fields', () => {
    const s = run(initialState(AT), edit('A'), { type: 'commit', at: AT }, { type: 'commit', at: AT })
    expect(s.briefVersion).toBe(2)
    expect(s.activity.filter((e) => e.kind === 'brief_edited')).toHaveLength(1)
    expect(s.activity.at(-1)?.text).toBe('Brief v2: edited Hook')
  })

  it('loading the sample brief is a labelled new version', () => {
    const s = reducer(approvedState(), { type: 'loadSample', brief: SAMPLE_BRIEF, at: AT })
    expect(s.isSample).toBe(true)
    expect(s.status).toBe('draft')
    expect(s.activity.at(-1)?.kind).toBe('sample_loaded')
  })
})

describe('local persistence', () => {
  it('round-trips brief, notes and activity, but never the attached video', () => {
    const store = memoryStore()
    const s = run(initialState(AT), edit('Saved hook'), attach(videoA), watched, {
      type: 'requestChanges',
      note: 'Shorter intro',
      at: AT,
    })
    expect(saveState(store, s)).toBe(true)
    const raw = store.raw.get(STORAGE_KEY)!
    expect(Object.keys(JSON.parse(raw))).not.toContain('session')

    const loaded = loadState(store, AT)
    expect(loaded.brief.hook).toBe('Saved hook')
    expect(loaded.activity).toEqual(s.activity)
    expect(loaded.activity.some((e) => e.note === 'Shorter intro')).toBe(true)
    expect(loaded.session).toEqual({ attached: null, watched: false })
  })

  it('after a reload, approval needs the video reattached and watched again', () => {
    const store = memoryStore()
    saveState(store, run(initialState(AT), edit('Hook'), attach(videoA)))
    let s = loadState(store, AT)
    expect(approvalBlockers(s)).toEqual(['Reattach the video. Files are not kept between sessions.'])
    s = reducer(s, attach(videoA))
    expect(approvalBlockers(s)).toEqual(['Watch the preview through to the end.'])
    s = run(s, watched, approve)
    expect(s.status).toBe('approved')
  })

  it('falls back to a fresh Draft on corrupt or missing storage', () => {
    const store = memoryStore()
    store.setItem(STORAGE_KEY, '{not json')
    expect(loadState(store, AT).status).toBe('draft')
    expect(loadState(null, AT).activity).toHaveLength(1)
  })
})

function currentVersion(s: State) {
  return s.videos.find((v) => v.hash === s.currentVideoHash)?.version
}

describe('approval reliability regressions', () => {
  it('reload clears current approval but retains history until explicit reapproval', () => {
    const store = memoryStore()
    saveState(store, approvedState())
    let s = loadState(store, AT)
    expect(s.status).toBe('draft')
    expect(s.approval).toBeNull()
    expect(s.activity.some(e => e.kind === 'approved')).toBe(true)
    s = run(s, attach(videoA), approve)
    expect(s.status).toBe('draft')
    s = run(s, watched)
    expect(s.status).toBe('draft')
    s = run(s, approve)
    expect(isApprovalCurrent(s)).toBe(true)
    expect(s.activity.filter(e => e.kind === 'approved')).toHaveLength(2)
  })

  it('metadata-only files cannot be approved, even after watching', () => {
    const weak = { ...videoA, hash: 'fp:same:100:0', hashKind: 'fingerprint' as const }
    const s = run(initialState(AT), { type: 'attach', video: weak, at: AT }, watched, approve)
    expect(s.approval).toBeNull()
    expect(approvalBlockers(s)[0]).toContain('SHA-256')
  })

  it('legacy fingerprint approval cannot survive reload or reattachment', () => {
    const store = memoryStore()
    const legacy = approvedState()
    legacy.videos[0] = { ...legacy.videos[0], hashKind: 'fingerprint' }
    saveState(store, legacy)
    const s = run(loadState(store, AT), { type: 'attach', video: legacy.videos[0], at: AT }, watched, approve)
    expect(isApprovalCurrent(s)).toBe(false)
    expect(s.status).toBe('draft')
  })
})
