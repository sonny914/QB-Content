// Single-reel review workflow: brief, content plan, video versions, revision requests and approval.
// Pure state + reducer so the approval rules can be tested without a browser.
import { EMPTY_PLAN_INPUTS, normaliseScene, planSnapshot, planSummary, type ContentPlan, type GraphicSpec, type PlanInputField, type PlanInputs, type PlanScene } from './plan'

export type BriefField = 'title' | 'audience' | 'objective' | 'hook' | 'script' | 'cta'
export type Brief = Record<BriefField, string>

export const BRIEF_FIELDS: { key: BriefField; label: string; multiline: boolean }[] = [
  { key: 'title', label: 'Title', multiline: false },
  { key: 'audience', label: 'Audience', multiline: false },
  { key: 'objective', label: 'Objective', multiline: true },
  { key: 'hook', label: 'Hook', multiline: false },
  { key: 'script', label: 'Script', multiline: true },
  { key: 'cta', label: 'CTA', multiline: false },
]

export const EMPTY_BRIEF: Brief = { title: '', audience: '', objective: '', hook: '', script: '', cta: '' }

export type Status = 'draft' | 'changes_requested' | 'approved'

/** One distinct video file, identified by its content hash. Only metadata is kept, never the file. */
export interface VideoVersion {
  hash: string
  hashKind: 'sha256' | 'fingerprint'
  name: string
  size: number
  version: number
  /** 'rendered' when the local render service assembled it from a voiceover and assets. */
  origin?: 'attached' | 'rendered'
  /** Set when the render came from the content plan: which plan version and which arrangement of files. */
  renderSource?: RenderSource
  /** True when the render had no voiceover: a silent preview. */
  silent?: boolean
}

export interface RenderSource {
  planVersion: number
  /** Fingerprint of the scene → asset assignments and the voiceover file used for the render. */
  fingerprint: string
}

/** The content plan as persisted: the prompt inputs, the imported plan and its edit version. */
export interface PlanState {
  inputs: PlanInputs
  imported: ContentPlan | null
  /** 0 until a plan is imported; +1 on each import or committed edit. */
  version: number
  committedSnapshot: string
}

export const EMPTY_PLAN_STATE: PlanState = { inputs: { ...EMPTY_PLAN_INPUTS }, imported: null, version: 0, committedSnapshot: '' }

export interface Approval {
  briefSnapshot: string
  briefVersion: number
  planVersion: number
  videoHash: string
  videoVersion: number
  at: string
}

export type ActivityKind =
  | 'created'
  | 'brief_edited'
  | 'sample_loaded'
  | 'plan_imported'
  | 'plan_edited'
  | 'video_attached'
  | 'video_rendered'
  | 'video_reattached'
  | 'video_replaced'
  | 'video_reviewed'
  | 'approval_withdrawn'
  | 'back_to_draft'
  | 'changes_requested'
  | 'approved'

export interface ActivityEntry {
  id: number
  at: string
  kind: ActivityKind
  text: string
  note?: string
  briefVersion: number
  planVersion?: number
  videoVersion: number | null
}

/** Everything that survives a reload. */
export interface PersistedState {
  schema: 1
  brief: Brief
  committedBrief: Brief
  briefVersion: number
  isSample: boolean
  plan: PlanState
  status: Status
  approval: Approval | null
  videos: VideoVersion[]
  /** The video version the brief is currently paired with (may not be attached this session). */
  currentVideoHash: string | null
  activity: ActivityEntry[]
}

/** Exists only for this page load. The video file itself is never persisted. */
export interface SessionState {
  attached: VideoVersion | null
  watched: boolean
  /** Fingerprint of the current scene → asset arrangement in the plan panel, or null when there is none. */
  arrangementFingerprint: string | null
}

export interface State extends PersistedState {
  session: SessionState
}

export type Action =
  | { type: 'edit'; field: BriefField; value: string; at: string }
  | { type: 'commit'; at: string }
  | { type: 'loadSample'; brief: Brief; at: string }
  | { type: 'attach'; video: Omit<VideoVersion, 'version'>; at: string; detail?: string }
  | { type: 'planInput'; field: PlanInputField; value: string }
  | { type: 'importPlan'; plan: ContentPlan; at: string }
  | { type: 'editScene'; index: number; field: 'narration' | 'visual' | 'seconds'; value: string | number; at: string }
  | { type: 'editScene'; index: number; field: 'kind'; value: 'asset' | 'graphic'; at: string }
  | { type: 'editScene'; index: number; field: 'graphic'; value: GraphicSpec; at: string }
  | { type: 'replaceScenes'; scenes: PlanScene[]; reason: string; at: string }
  | { type: 'chooseHook'; index: number; at: string }
  | { type: 'commitPlan'; at: string }
  | { type: 'setArrangement'; fingerprint: string | null }
  | { type: 'watched'; at: string }
  | { type: 'requestChanges'; note: string; at: string }
  | { type: 'approve'; at: string }
  | { type: 'reset'; at: string }

export function initialState(at: string): State {
  const base: State = {
    schema: 1,
    brief: { ...EMPTY_BRIEF },
    committedBrief: { ...EMPTY_BRIEF },
    briefVersion: 1,
    isSample: false,
    plan: { ...EMPTY_PLAN_STATE, inputs: { ...EMPTY_PLAN_INPUTS } },
    status: 'draft',
    approval: null,
    videos: [],
    currentVideoHash: null,
    activity: [],
    session: { attached: null, watched: false, arrangementFingerprint: null },
  }
  return log(base, at, 'created', 'Workspace created in Draft')
}

export function fromPersisted(p: PersistedState): State {
  // Historical approvals remain in activity; each page load needs explicit review.
  const plan = p.plan ?? { ...EMPTY_PLAN_STATE, inputs: { ...EMPTY_PLAN_INPUTS } }
  // Plans saved before graphic scenes existed get the asset default; the snapshot stays as committed.
  const imported = plan.imported ? { ...plan.imported, scenes: plan.imported.scenes.map(normaliseScene) } : null
  return {
    ...p,
    plan: { ...plan, imported, committedSnapshot: imported ? planSnapshot(imported) : plan.committedSnapshot },
    status: p.status === 'approved' ? 'draft' : p.status,
    approval: null,
    session: { attached: null, watched: false, arrangementFingerprint: null },
  }
}

export function toPersisted(s: State): PersistedState {
  const { session: _session, ...rest } = s
  return rest
}

export const snapshot = (b: Brief) => JSON.stringify(BRIEF_FIELDS.map((f) => b[f.key]))

export function currentVideo(s: State): VideoVersion | null {
  return s.videos.find((v) => v.hash === s.currentVideoHash) ?? null
}

/** True only when the stored approval matches the brief and video exactly as they are now. */
export function isApprovalCurrent(s: State): boolean {
  return (
    s.status === 'approved' &&
    s.approval !== null &&
    s.session.attached?.hashKind === 'sha256' &&
    s.session.attached.hash === s.currentVideoHash &&
    s.session.watched &&
    s.approval.briefSnapshot === snapshot(s.brief) &&
    s.approval.planVersion === s.plan.version &&
    s.approval.videoHash === s.currentVideoHash
  )
}

/**
 * Why the attached preview no longer matches the plan it was rendered from, or null if it does
 * (or it wasn't rendered from the plan). Shown on the player and used to block approval.
 */
export function staleRenderReason(s: State): string | null {
  const src = s.session.attached?.renderSource
  if (!src) return null
  if (src.planVersion !== s.plan.version) {
    return `This preview was rendered from plan v${src.planVersion}; the plan is now v${s.plan.version}, so the video does not reflect the latest edits. Create the preview again.`
  }
  if (s.session.arrangementFingerprint !== null && src.fingerprint !== s.session.arrangementFingerprint) {
    return 'The assets or voiceover assigned to the scenes changed after this preview was rendered, so the video does not reflect them. Create the preview again.'
  }
  return null
}

/** Reasons approval is blocked right now. Empty means Approve is allowed. */
export function approvalBlockers(s: State): string[] {
  if (isApprovalCurrent(s)) return ['Already approved for this brief and video version.']
  const reasons: string[] = []
  if (!s.session.attached) {
    reasons.push(
      s.currentVideoHash
        ? 'Reattach the video. Files are not kept between sessions.'
        : 'Attach the reel video.',
    )
  } else if (s.session.attached.hashKind !== 'sha256') {
    reasons.push('Approval requires SHA-256 verification. Open this app over HTTPS or localhost and reattach the video.')
  } else if (staleRenderReason(s)) {
    reasons.push(staleRenderReason(s)!)
  } else if (!s.session.watched) {
    reasons.push('Watch the preview through to the end.')
  }
  return reasons
}

function log(
  s: State,
  at: string,
  kind: ActivityKind,
  text: string,
  note?: string,
): State {
  const entry: ActivityEntry = {
    id: (s.activity.at(-1)?.id ?? 0) + 1,
    at,
    kind,
    text,
    briefVersion: s.briefVersion,
    ...(s.plan.version > 0 ? { planVersion: s.plan.version } : {}),
    videoVersion: currentVideo(s)?.version ?? null,
    ...(note !== undefined ? { note } : {}),
  }
  return { ...s, activity: [...s.activity, entry] }
}

/** Any change to the brief or video moves the reel back to Draft and drops a prior approval. */
function backToDraft(s: State, at: string, reason: string): State {
  if (s.status === 'approved') {
    return log({ ...s, status: 'draft', approval: null }, at, 'approval_withdrawn', `Approval withdrawn: ${reason}`)
  }
  if (s.status === 'changes_requested') {
    return log({ ...s, status: 'draft' }, at, 'back_to_draft', `Back to Draft for revision: ${reason}`)
  }
  return s
}

function commit(s: State, at: string): State {
  const changed = BRIEF_FIELDS.filter((f) => s.brief[f.key] !== s.committedBrief[f.key])
  if (changed.length === 0) return s
  const next = { ...s, briefVersion: s.briefVersion + 1, committedBrief: { ...s.brief } }
  return log(next, at, 'brief_edited', `Brief v${next.briefVersion}: edited ${changed.map((f) => f.label).join(', ')}`)
}

/** Bump the plan version when its content differs from the last committed snapshot. */
function commitPlan(s: State, at: string, detail: string): State {
  const plan = s.plan.imported
  if (!plan) return s
  const snap = planSnapshot(plan)
  if (snap === s.plan.committedSnapshot) return s
  const next = { ...s, plan: { ...s.plan, version: s.plan.version + 1, committedSnapshot: snap } }
  return log(next, at, 'plan_edited', `Plan v${next.plan.version}: ${detail}`)
}

/** Which scene numbers differ between the committed snapshot and the current plan, for the activity log. */
function changedScenes(s: State): string {
  const plan = s.plan.imported
  if (!plan || !s.plan.committedSnapshot) return 'edited'
  let committed: [string[], number, string, unknown[][], string[]]
  try {
    committed = JSON.parse(s.plan.committedSnapshot)
  } catch {
    return 'edited'
  }
  const parts: string[] = []
  const scenesBefore = committed[3] ?? []
  const nums = plan.scenes
    .map((sc, i) => (scenesBefore[i] && JSON.stringify(scenesBefore[i]) === JSON.stringify([sc.narration, sc.visual, sc.seconds, sc.kind, sc.kind === 'graphic' ? sc.graphic : null]) ? null : i + 1))
    .filter((n): n is number => n !== null)
  if (nums.length) parts.push(`edited scene${nums.length === 1 ? '' : 's'} ${nums.join(', ')}`)
  if (committed[1] !== plan.recommendedHook) parts.push(`hook ${plan.recommendedHook + 1} chosen`)
  return parts.join('; ') || 'edited'
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'planInput': {
      if (s.plan.inputs[a.field] === a.value) return s
      return { ...s, plan: { ...s.plan, inputs: { ...s.plan.inputs, [a.field]: a.value } } }
    }

    case 'importPlan': {
      const snap = planSnapshot(a.plan)
      let next: State = { ...s, plan: { ...s.plan, imported: a.plan, version: s.plan.version + 1, committedSnapshot: snap } }
      next = backToDraft(next, a.at, s.plan.imported ? 'plan replaced' : 'plan imported')
      return log(next, a.at, 'plan_imported', `Plan v${next.plan.version} imported: ${planSummary(a.plan)}`)
    }

    case 'editScene': {
      const plan = s.plan.imported
      if (!plan || !plan.scenes[a.index]) return s
      const scene = plan.scenes[a.index]
      let patch: Partial<PlanScene>
      if (a.field === 'seconds') patch = { seconds: Math.round(Number(a.value) * 10) / 10 }
      else if (a.field === 'graphic') patch = { graphic: a.value, kind: 'graphic' }
      else if (a.field === 'kind') patch = { kind: a.value }
      else patch = { [a.field]: String(a.value) }
      const changed = (Object.keys(patch) as (keyof PlanScene)[]).some((k) => JSON.stringify(scene[k]) !== JSON.stringify(patch[k]))
      if (!changed) return s
      const scenes = plan.scenes.map((sc, i) => (i === a.index ? { ...sc, ...patch } : sc))
      const next = { ...s, plan: { ...s.plan, imported: { ...plan, scenes } } }
      return backToDraft(next, a.at, 'plan edited')
    }

    case 'replaceScenes': {
      const plan = s.plan.imported
      if (!plan) return s
      let next: State = { ...s, plan: { ...s.plan, imported: { ...plan, scenes: a.scenes } } }
      next = backToDraft(next, a.at, 'plan edited')
      return commitPlan(next, a.at, a.reason)
    }

    case 'chooseHook': {
      const plan = s.plan.imported
      if (!plan || a.index < 0 || a.index >= plan.hooks.length || plan.recommendedHook === a.index) return s
      let next: State = { ...s, plan: { ...s.plan, imported: { ...plan, recommendedHook: a.index } } }
      next = backToDraft(next, a.at, 'plan edited')
      return commitPlan(next, a.at, changedScenes(next))
    }

    case 'commitPlan':
      return commitPlan(s, a.at, changedScenes(s))

    case 'setArrangement':
      if (s.session.arrangementFingerprint === a.fingerprint) return s
      return { ...s, session: { ...s.session, arrangementFingerprint: a.fingerprint } }

    case 'edit': {
      if (s.brief[a.field] === a.value) return s
      const next = { ...s, brief: { ...s.brief, [a.field]: a.value } }
      return backToDraft(next, a.at, 'brief edited')
    }

    case 'commit':
      return commit(s, a.at)

    case 'loadSample': {
      let next: State = { ...s, brief: { ...a.brief }, isSample: true }
      if (snapshot(next.brief) === snapshot(s.brief)) return s
      next = backToDraft(next, a.at, 'brief replaced with the fictional sample')
      next = { ...next, briefVersion: next.briefVersion + 1, committedBrief: { ...next.brief } }
      return log(next, a.at, 'sample_loaded', `Brief v${next.briefVersion}: loaded the fictional sample brief`)
    }

    case 'attach': {
      const known = s.videos.find((v) => v.hash === a.video.hash)
      const version: VideoVersion = known ?? { ...a.video, version: s.videos.length + 1 }
      const prevHash = s.currentVideoHash
      let next: State = {
        ...s,
        videos: known ? s.videos : [...s.videos, version],
        currentVideoHash: version.hash,
        session: { ...s.session, attached: version, watched: false },
      }
      const rendered = a.video.origin === 'rendered'
      const describe = (v: VideoVersion) =>
        rendered ? `Video v${v.version} rendered locally${a.detail ? ` (${a.detail})` : ''}: ${v.name}` : `Video v${v.version} attached: ${v.name}`
      if (prevHash === null) {
        next = log(next, a.at, rendered ? 'video_rendered' : 'video_attached', describe(version))
      } else if (prevHash === version.hash) {
        next = backToDraft(next, a.at, 'video reattached for fresh review')
        next = log(next, a.at, 'video_reattached', `Video v${version.version} attached again for review: ${version.name}`)
      } else {
        const prev = s.videos.find((v) => v.hash === prevHash)
        next = rendered
          ? log(next, a.at, 'video_rendered', `${describe(version)} (replaces v${prev?.version ?? '?'})`)
          : log(next, a.at, 'video_replaced', `Video replaced: v${prev?.version ?? '?'} → v${version.version} (${version.name})`)
        next = backToDraft(next, a.at, rendered ? 'new render' : 'video replaced')
      }
      return next
    }

    case 'watched': {
      const v = s.session.attached
      if (!v || s.session.watched) return s
      const next = { ...s, session: { ...s.session, watched: true } }
      return log(next, a.at, 'video_reviewed', `Video v${v.version} watched to the end`)
    }

    case 'requestChanges': {
      const note = a.note.trim()
      if (!note) return s
      const wasApproved = s.status === 'approved'
      const next = { ...commitPlan(commit(s, a.at), a.at, changedScenes(s)), status: 'changes_requested' as const, approval: null }
      return log(next, a.at, 'changes_requested', wasApproved ? 'Changes requested (approval withdrawn)' : 'Changes requested', note)
    }

    case 'approve': {
      const next = commitPlan(commit(s, a.at), a.at, changedScenes(s))
      if (approvalBlockers(next).length > 0) return next
      const video = next.session.attached!
      const approval: Approval = {
        briefSnapshot: snapshot(next.brief),
        briefVersion: next.briefVersion,
        planVersion: next.plan.version,
        videoHash: video.hash,
        videoVersion: video.version,
        at: a.at,
      }
      const planPart = next.plan.version > 0 ? `, plan v${approval.planVersion}` : ''
      return log({ ...next, status: 'approved', approval }, a.at, 'approved', `Approved brief v${approval.briefVersion}${planPart} with video v${approval.videoVersion}`)
    }

    case 'reset':
      return initialState(a.at)
  }
}
