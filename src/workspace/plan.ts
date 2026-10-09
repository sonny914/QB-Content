// Content plan: the versioned JSON a writing session (your own Claude session) hands back,
// plus validation that reports every problem without touching existing work.

export const PLAN_FORMAT = 'qb-content-plan'
export const PLAN_VERSION = 1
export const MIN_SCENES = 1
export const MAX_SCENES = 20
export const MIN_SECONDS = 0.5
export const MAX_SECONDS = 300
const MAX_HOOKS = 5

export type PlanInputField = 'business' | 'audience' | 'offer' | 'topic' | 'tone' | 'cta'
export type PlanInputs = Record<PlanInputField, string>

export const PLAN_INPUT_FIELDS: { key: PlanInputField; label: string; multiline: boolean; hint: string }[] = [
  { key: 'business', label: 'Business description', multiline: true, hint: 'What you do, for whom, where. Only facts you can stand behind.' },
  { key: 'audience', label: 'Audience', multiline: false, hint: 'Who this reel is for.' },
  { key: 'offer', label: 'Offer', multiline: true, hint: 'The product, service or thing on offer, as it really is.' },
  { key: 'topic', label: 'Topic of this reel', multiline: false, hint: 'The one idea this reel covers.' },
  { key: 'tone', label: 'Tone', multiline: false, hint: 'e.g. calm and direct, warm, dry.' },
  { key: 'cta', label: 'Call to action', multiline: false, hint: 'The exact ask at the end.' },
]

export const EMPTY_PLAN_INPUTS: PlanInputs = { business: '', audience: '', offer: '', topic: '', tone: '', cta: '' }

export interface PlanScene {
  id: string
  narration: string
  visual: string
  seconds: number
}

export interface ContentPlan {
  format: typeof PLAN_FORMAT
  version: typeof PLAN_VERSION
  hooks: string[]
  recommendedHook: number
  script: string
  scenes: PlanScene[]
  claimsToVerify: string[]
}

export type ImportResult = { ok: true; plan: ContentPlan; warnings: string[] } | { ok: false; errors: string[] }

const r1 = (n: number) => Math.round(n * 10) / 10

/** Pull the JSON out of a pasted reply: a ```json fence is accepted, surrounding prose is not. */
export function extractJson(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  return (fence ? fence[1] : text).trim()
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const show = (x: unknown) => {
  const s = JSON.stringify(x)
  return s === undefined ? 'undefined' : s.length > 40 ? s.slice(0, 37) + '…' : s
}

/** Validate pasted text. On failure every problem is listed; nothing is imported. */
export function parsePlan(text: string): ImportResult {
  const source = extractJson(text)
  if (!source) return { ok: false, errors: ['Nothing to import. Paste the JSON object Claude returned.'] }
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, errors: [`Not valid JSON: ${msg}. Paste only the JSON object Claude returned (a \`\`\`json block is fine).`] }
  }
  if (!isRecord(raw)) return { ok: false, errors: [`The plan must be a JSON object, not ${Array.isArray(raw) ? 'an array' : typeof raw}.`] }

  const errors: string[] = []
  const warnings: string[] = []

  if (raw.format !== PLAN_FORMAT) errors.push(`"format" must be "${PLAN_FORMAT}" (got ${show(raw.format)}).`)
  if (raw.version !== PLAN_VERSION) {
    errors.push(
      typeof raw.version === 'number'
        ? `This plan is version ${raw.version}; this app understands version ${PLAN_VERSION}.`
        : `"version" must be the number ${PLAN_VERSION} (got ${show(raw.version)}).`,
    )
  }

  // hooks
  let hooks: string[] = []
  if (!Array.isArray(raw.hooks)) errors.push(`"hooks" must be an array of strings (got ${show(raw.hooks)}).`)
  else {
    raw.hooks.forEach((h, i) => {
      if (typeof h !== 'string' || !h.trim()) errors.push(`hooks[${i}] must be a non-empty string (got ${show(h)}).`)
    })
    hooks = raw.hooks.filter((h): h is string => typeof h === 'string').map((h) => h.trim()).filter(Boolean)
    if (raw.hooks.length < 1) errors.push('"hooks" needs at least one hook.')
    if (raw.hooks.length > MAX_HOOKS) errors.push(`"hooks" has ${raw.hooks.length} entries; at most ${MAX_HOOKS} are allowed.`)
    else if (raw.hooks.length !== 3) warnings.push(`Expected 3 hooks, got ${raw.hooks.length}.`)
  }

  // recommendedHook
  let recommendedHook = 0
  if (raw.recommendedHook !== undefined) {
    if (!Number.isInteger(raw.recommendedHook) || (raw.recommendedHook as number) < 0 || (raw.recommendedHook as number) >= Math.max(hooks.length, 1)) {
      errors.push(`"recommendedHook" must be an index into hooks, 0 to ${Math.max(hooks.length - 1, 0)} (got ${show(raw.recommendedHook)}).`)
    } else recommendedHook = raw.recommendedHook as number
  }

  // script
  const script = typeof raw.script === 'string' ? raw.script.trim() : ''
  if (!script) errors.push(`"script" must be a non-empty string with the full narration (got ${show(raw.script)}).`)

  // scenes
  const scenes: PlanScene[] = []
  if (!Array.isArray(raw.scenes)) errors.push(`"scenes" must be an array (got ${show(raw.scenes)}).`)
  else {
    if (raw.scenes.length < MIN_SCENES) errors.push('"scenes" needs at least one scene.')
    if (raw.scenes.length > MAX_SCENES) errors.push(`"scenes" has ${raw.scenes.length} entries; at most ${MAX_SCENES} are allowed.`)
    raw.scenes.forEach((s, i) => {
      const at = `scenes[${i}]`
      if (!isRecord(s)) {
        errors.push(`${at} must be an object with narration, visual and seconds (got ${show(s)}).`)
        return
      }
      const narration = typeof s.narration === 'string' ? s.narration.trim() : ''
      const visual = typeof s.visual === 'string' ? s.visual.trim() : ''
      if (!narration) errors.push(`${at}.narration must be a non-empty string (got ${show(s.narration)}).`)
      if (!visual) errors.push(`${at}.visual must be a non-empty string (got ${show(s.visual)}).`)
      const seconds = s.seconds
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
        errors.push(`${at}.seconds must be a number between ${MIN_SECONDS} and ${MAX_SECONDS} (got ${show(seconds)}).`)
      }
      const known = new Set(['id', 'narration', 'visual', 'seconds'])
      const extra = Object.keys(s).filter((k) => !known.has(k))
      if (extra.length) warnings.push(`${at}: ignored unknown field(s) ${extra.join(', ')}.`)
      scenes.push({ id: `s${i + 1}`, narration, visual, seconds: typeof seconds === 'number' ? r1(seconds) : 0 })
    })
  }

  // claimsToVerify
  let claimsToVerify: string[] = []
  if (raw.claimsToVerify !== undefined) {
    if (!Array.isArray(raw.claimsToVerify)) errors.push(`"claimsToVerify" must be an array of strings (got ${show(raw.claimsToVerify)}).`)
    else {
      raw.claimsToVerify.forEach((c, i) => {
        if (typeof c !== 'string') errors.push(`claimsToVerify[${i}] must be a string (got ${show(c)}).`)
      })
      claimsToVerify = raw.claimsToVerify.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean)
    }
  }

  const knownTop = new Set(['format', 'version', 'inputs', 'hooks', 'recommendedHook', 'script', 'scenes', 'claimsToVerify'])
  const extraTop = Object.keys(raw).filter((k) => !knownTop.has(k))
  if (extraTop.length) warnings.push(`Ignored unknown field(s): ${extraTop.join(', ')}.`)

  if (errors.length) return { ok: false, errors }

  const total = totalSeconds(scenes)
  if (total > 90) warnings.push(`The scenes add up to ${total}s; short reels usually run 20–45s.`)
  const words = script.split(/\s+/).filter(Boolean).length
  if (words > 160) warnings.push(`The script is ${words} words; around 90–140 is comfortable to say in a short reel.`)
  if (/\[[^\]]+\]/.test(script) && claimsToVerify.length === 0) {
    warnings.push('The script contains [bracketed placeholders] but "claimsToVerify" is empty. Check what still needs filling in.')
  }

  return {
    ok: true,
    warnings,
    plan: { format: PLAN_FORMAT, version: PLAN_VERSION, hooks, recommendedHook, script, scenes, claimsToVerify },
  }
}

export const totalSeconds = (scenes: PlanScene[]) => r1(scenes.reduce((sum, s) => sum + s.seconds, 0))

export const planSnapshot = (plan: ContentPlan | null) =>
  plan === null ? '' : JSON.stringify([plan.hooks, plan.recommendedHook, plan.script, plan.scenes.map((s) => [s.narration, s.visual, s.seconds]), plan.claimsToVerify])

export const planSummary = (plan: ContentPlan) =>
  `${plan.hooks.length} hook${plan.hooks.length === 1 ? '' : 's'}, ${plan.scenes.length} scene${plan.scenes.length === 1 ? '' : 's'}, ${totalSeconds(plan.scenes)}s`

/** Scale every scene so the total matches `target` seconds, keeping proportions, in tenths of a second. */
export function scaleScenes(scenes: PlanScene[], target: number): PlanScene[] {
  const total = totalSeconds(scenes)
  if (scenes.length === 0 || total <= 0 || target <= 0) return scenes
  const scaled = scenes.map((s) => ({ ...s, seconds: Math.max(MIN_SECONDS, r1((s.seconds / total) * target)) }))
  const sumButLast = scaled.slice(0, -1).reduce((sum, s) => sum + s.seconds, 0)
  scaled[scaled.length - 1] = { ...scaled[scaled.length - 1], seconds: Math.max(MIN_SECONDS, r1(target - sumButLast)) }
  return scaled
}
