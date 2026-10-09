// Local persistence for the single-user prototype. Brief text, notes and activity only:
// the video file is never written anywhere.
import { fromPersisted, initialState, toPersisted, type PersistedState, type State } from './model'

export const STORAGE_KEY = 'qb-content:reel-workspace:v1'

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isPersisted(x: unknown): x is PersistedState {
  if (!x || typeof x !== 'object') return false
  const p = x as Partial<PersistedState>
  return (
    p.schema === 1 &&
    typeof p.brief === 'object' &&
    typeof p.committedBrief === 'object' &&
    typeof p.briefVersion === 'number' &&
    (p.status === 'draft' || p.status === 'changes_requested' || p.status === 'approved') &&
    Array.isArray(p.videos) &&
    Array.isArray(p.activity)
  )
}

export function loadState(store: KV | null, at: string): State {
  try {
    const raw = store?.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (isPersisted(parsed)) return fromPersisted(parsed)
    }
  } catch {
    // Unreadable or blocked storage: start fresh rather than fail.
  }
  return initialState(at)
}

/** Returns false when the browser refused the write (private mode, quota, blocked storage). */
export function saveState(store: KV | null, s: State): boolean {
  try {
    if (!store) return false
    store.setItem(STORAGE_KEY, JSON.stringify(toPersisted(s)))
    return true
  } catch {
    return false
  }
}

export function clearState(store: KV | null) {
  try {
    store?.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function browserStorage(): KV | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
