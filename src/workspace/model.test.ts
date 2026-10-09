import { describe, expect, it } from 'vitest'
import { approvalBlockers, initialState, isApprovalCurrent, reducer, type Action, type State } from './model'
import { SAMPLE_BRIEF } from './sample'
import { loadState, saveState, STORAGE_KEY } from './storage'
import { staleRenderReason } from './model'
import { parsePlan, type ContentPlan } from './plan'

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
    expect(loaded.session).toEqual({ attached: null, watched: false, arrangementFingerprint: null })
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

describe('rendered previews', () => {
  const rendered = { hash: 'sha256:ccc', hashKind: 'sha256' as const, name: 'qb-preview.mp4', size: 300, origin: 'rendered' as const }

  it('a render arrives as a new, unapproved video version with its own activity entry', () => {
    const s = run(initialState(AT), { type: 'attach', video: rendered, at: AT, detail: '2 assets + voiceover, 4s' })
    expect(s.status).toBe('draft')
    expect(s.session.watched).toBe(false)
    expect(approvalBlockers(s)).toEqual(['Watch the preview through to the end.'])
    expect(s.activity.at(-1)).toMatchObject({ kind: 'video_rendered', text: 'Video v1 rendered locally (2 assets + voiceover, 4s): qb-preview.mp4' })
    expect(currentVersion(s)).toBe(1)
  })

  it('a new render replaces the current video and withdraws approval', () => {
    const s = reducer(approvedState(), { type: 'attach', video: rendered, at: AT })
    expect(s.status).toBe('draft')
    expect(s.approval).toBeNull()
    expect(currentVersion(s)).toBe(2)
    expect(s.activity.map((e) => e.kind).slice(-2)).toEqual(['video_rendered', 'approval_withdrawn'])
    expect(s.activity.at(-2)?.text).toContain('(replaces v1)')
  })
})

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

describe('content plan rules', () => {
  const planJson = {
    format: 'qb-content-plan',
    version: 1,
    hooks: ['Hook A', 'Hook B', 'Hook C'],
    recommendedHook: 0,
    script: 'One. Two.',
    scenes: [
      { narration: 'One.', visual: 'First visual', seconds: 2 },
      { narration: 'Two.', visual: 'Second visual', seconds: 2 },
    ],
    claimsToVerify: ['Confirm the opening year'],
  }
  const plan = (parsePlan(JSON.stringify(planJson)) as { ok: true; plan: ContentPlan }).plan
  const imported = () => reducer(initialState(AT), { type: 'importPlan', plan, at: AT })
  const fromPlan = (fingerprint = 'fp-1', planVersion = 1) =>
    ({ hash: 'sha256:ddd', hashKind: 'sha256' as const, name: 'qb-preview.mp4', size: 400, origin: 'rendered' as const, renderSource: { planVersion, fingerprint } })

  it('imports a plan as v1 and logs a summary', () => {
    const s = imported()
    expect(s.plan.version).toBe(1)
    expect(s.plan.imported?.scenes).toHaveLength(2)
    expect(s.activity.at(-1)).toMatchObject({ kind: 'plan_imported', text: 'Plan v1 imported: 3 hooks, 2 scenes, 4s', planVersion: 1 })
  })

  it('plan inputs persist without creating versions or touching approval', () => {
    let s = run(approvedState(), { type: 'planInput', field: 'business', value: 'A small studio' })
    expect(s.status).toBe('approved')
    expect(s.plan.inputs.business).toBe('A small studio')
    const store = memoryStore()
    saveState(store, s)
    s = loadState(store, AT)
    expect(s.plan.inputs.business).toBe('A small studio')
  })

  it('a scene edit returns to Draft at once and becomes the next plan version on commit', () => {
    let s = run(imported(), attach(videoA), watched, approve)
    expect(s.status).toBe('approved')
    expect(s.approval?.planVersion).toBe(1)
    s = reducer(s, { type: 'editScene', index: 1, field: 'narration', value: 'Two, revised.', at: AT })
    expect(s.status).toBe('draft')
    expect(s.approval).toBeNull()
    expect(s.plan.version).toBe(1) // not committed yet
    s = reducer(s, { type: 'commitPlan', at: AT })
    expect(s.plan.version).toBe(2)
    expect(s.activity.at(-1)?.text).toBe('Plan v2: edited scene 2')
    expect(reducer(s, { type: 'commitPlan', at: AT })).toBe(s) // nothing further to commit
  })

  it('choosing another hook and scaling scenes are plan versions too', () => {
    let s = reducer(imported(), { type: 'chooseHook', index: 2, at: AT })
    expect(s.plan.version).toBe(2)
    expect(s.activity.at(-1)?.text).toBe('Plan v2: hook 3 chosen')
    s = reducer(s, { type: 'replaceScenes', scenes: s.plan.imported!.scenes.map((sc) => ({ ...sc, seconds: 5 })), reason: 'scene durations scaled to the voiceover (10s)', at: AT })
    expect(s.plan.version).toBe(3)
    expect(s.activity.at(-1)?.text).toBe('Plan v3: scene durations scaled to the voiceover (10s)')
  })

  it('replacing a plan withdraws approval', () => {
    const s = reducer(run(imported(), attach(videoA), watched, approve), { type: 'importPlan', plan, at: AT })
    expect(s.status).toBe('draft')
    expect(s.plan.version).toBe(2)
    expect(s.activity.map((e) => e.kind).slice(-2)).toEqual(['approval_withdrawn', 'plan_imported'])
  })

  it('a render from the plan is stale once the plan or the arrangement changes, and approval is blocked', () => {
    let s = run(imported(), { type: 'setArrangement', fingerprint: 'fp-1' }, { type: 'attach', video: fromPlan(), at: AT, detail: 'from plan v1' }, watched)
    expect(staleRenderReason(s)).toBeNull()
    expect(approvalBlockers(s)).toEqual([])

    const edited = run(s, { type: 'editScene', index: 0, field: 'seconds', value: 3, at: AT }, { type: 'commitPlan', at: AT })
    expect(staleRenderReason(edited)).toMatch(/rendered from plan v1; the plan is now v2/)
    expect(approvalBlockers(edited)).toEqual([expect.stringMatching(/Create the preview again/)])
    expect(reducer(edited, approve).status).toBe('draft')

    const rearranged = reducer(s, { type: 'setArrangement', fingerprint: 'fp-2' })
    expect(staleRenderReason(rearranged)).toMatch(/assets or voiceover assigned to the scenes changed/)

    // A fresh render from the current plan and arrangement clears it.
    s = run(edited, { type: 'attach', video: { ...fromPlan('fp-1', 2), hash: 'sha256:eee' }, at: AT }, watched)
    expect(staleRenderReason(s)).toBeNull()
    expect(reducer(s, approve).status).toBe('approved')
    expect(reducer(s, approve).activity.at(-1)?.text).toBe('Approved brief v1, plan v2 with video v2')
  })

  it('a manually attached file is never judged against the plan', () => {
    const s = run(imported(), attach(videoA), watched, { type: 'editScene', index: 0, field: 'visual', value: 'x', at: AT }, { type: 'commitPlan', at: AT })
    expect(staleRenderReason(s)).toBeNull()
  })

  it('old saved data without a plan loads with an empty plan', () => {
    const store = memoryStore()
    const legacy = JSON.parse(JSON.stringify(run(initialState(AT), edit('h')))) as Record<string, unknown>
    delete legacy.plan
    store.setItem(STORAGE_KEY, JSON.stringify(legacy))
    const s = loadState(store, AT)
    expect(s.plan.version).toBe(0)
    expect(s.plan.imported).toBeNull()
    expect(s.brief.hook).toBe('h')
  })
})
