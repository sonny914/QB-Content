// Single-reel review workflow: brief, video versions, revision requests and approval.
// Pure state + reducer so the approval rules can be tested without a browser.

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
}

export interface Approval {
  briefSnapshot: string
  briefVersion: number
  videoHash: string
  videoVersion: number
  at: string
}

export type ActivityKind =
  | 'created'
  | 'brief_edited'
  | 'sample_loaded'
  | 'video_attached'
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
  videoVersion: number | null
}

/** Everything that survives a reload. */
export interface PersistedState {
  schema: 1
  brief: Brief
  committedBrief: Brief
  briefVersion: number
  isSample: boolean
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
}

export interface State extends PersistedState {
  session: SessionState
}

export type Action =
  | { type: 'edit'; field: BriefField; value: string; at: string }
  | { type: 'commit'; at: string }
  | { type: 'loadSample'; brief: Brief; at: string }
  | { type: 'attach'; video: Omit<VideoVersion, 'version'>; at: string }
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
    status: 'draft',
    approval: null,
    videos: [],
    currentVideoHash: null,
    activity: [],
    session: { attached: null, watched: false },
  }
  return log(base, at, 'created', 'Workspace created in Draft')
}

export function fromPersisted(p: PersistedState): State {
  // Historical approvals remain in activity; each page load needs explicit review.
  return {
    ...p,
    status: p.status === 'approved' ? 'draft' : p.status,
    approval: null,
    session: { attached: null, watched: false },
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
    s.approval.videoHash === s.currentVideoHash
  )
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

export function reducer(s: State, a: Action): State {
  switch (a.type) {
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
        session: { attached: version, watched: false },
      }
      if (prevHash === null) {
        next = log(next, a.at, 'video_attached', `Video v${version.version} attached: ${version.name}`)
      } else if (prevHash === version.hash) {
        next = backToDraft(next, a.at, 'video reattached for fresh review')
        next = log(next, a.at, 'video_reattached', `Video v${version.version} attached again for review: ${version.name}`)
      } else {
        const prev = s.videos.find((v) => v.hash === prevHash)
        next = log(next, a.at, 'video_replaced', `Video replaced: v${prev?.version ?? '?'} → v${version.version} (${version.name})`)
        next = backToDraft(next, a.at, 'video replaced')
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
      const next = { ...commit(s, a.at), status: 'changes_requested' as const, approval: null }
      return log(next, a.at, 'changes_requested', wasApproved ? 'Changes requested (approval withdrawn)' : 'Changes requested', note)
    }

    case 'approve': {
      const next = commit(s, a.at)
      if (approvalBlockers(next).length > 0) return next
      const video = next.session.attached!
      const approval: Approval = {
        briefSnapshot: snapshot(next.brief),
        briefVersion: next.briefVersion,
        videoHash: video.hash,
        videoVersion: video.version,
        at: a.at,
      }
      return log({ ...next, status: 'approved', approval }, a.at, 'approved', `Approved brief v${approval.briefVersion} with video v${approval.videoVersion}`)
    }

    case 'reset':
      return initialState(a.at)
  }
}
