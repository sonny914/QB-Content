import { describe, expect, it } from 'vitest'
import { EMPTY_GRAPHIC, EMPTY_PLAN_INPUTS, extractJson, graphicReadingSeconds, parsePlan, planSnapshot, scaleScenes, totalSeconds, type ContentPlan } from './plan'
import { buildPlanningPrompt } from './planPrompt'

const valid = {
  format: 'qb-content-plan',
  version: 1,
  hooks: ['Before you build it, try to kill it.', 'Most ideas fail before launch.', 'Test the idea, not your patience.'],
  recommendedHook: 0,
  script: 'Before you build it, try to kill it. We look for the reason it will not work. Send us the idea.',
  scenes: [
    { narration: 'Before you build it, try to kill it.', visual: 'Owner at the desk, looking up.', seconds: 3 },
    { narration: 'We look for the reason it will not work.', visual: 'Hands marking up a printed page.', seconds: 5 },
    { narration: 'Send us the idea.', visual: 'Text card with the call to action.', seconds: 2.5 },
  ],
  claimsToVerify: [],
}

describe('parsePlan', () => {
  it('accepts a valid plan and assigns scene ids in order', () => {
    const r = parsePlan(JSON.stringify(valid))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toEqual([])
    expect(r.plan.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(totalSeconds(r.plan.scenes)).toBe(10.5)
    expect(r.plan.recommendedHook).toBe(0)
  })

  it('accepts a ```json fence around the object', () => {
    const r = parsePlan('Here you go:\n```json\n' + JSON.stringify(valid) + '\n```\nLet me know.')
    expect(r.ok).toBe(true)
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('explains invalid JSON and empty input', () => {
    const r = parsePlan('{ not json')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/^Not valid JSON: /)
    expect(r.errors[0]).toMatch(/Paste only the JSON object/)
    const e = parsePlan('   ')
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.errors).toEqual(['Nothing to import. Paste the JSON object Claude returned.'])
    const a = parsePlan('[1,2]')
    if (!a.ok) expect(a.errors[0]).toMatch(/not an array/)
  })

  it('rejects the wrong format or version', () => {
    const r = parsePlan(JSON.stringify({ ...valid, format: 'other', version: 2 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContain('"format" must be "qb-content-plan" (got "other").')
    expect(r.errors).toContain('This plan is version 2; this app understands version 1.')
  })

  it('lists every field problem with its path', () => {
    const r = parsePlan(
      JSON.stringify({
        format: 'qb-content-plan',
        version: 1,
        hooks: ['ok', 42, ''],
        recommendedHook: 7,
        script: '',
        scenes: [{ narration: 'x', visual: '', seconds: 'four' }, 'nope', { narration: 'y', visual: 'z', seconds: 0.1 }],
        claimsToVerify: 'later',
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      'hooks[1] must be a non-empty string (got 42).',
      'hooks[2] must be a non-empty string (got "").',
      '"recommendedHook" must be an index into hooks, 0 to 0 (got 7).',
      '"script" must be a non-empty string with the full narration (got "").',
      'scenes[0].visual must be a non-empty string (got "").',
      'scenes[0].seconds must be a number between 0.5 and 300 (got "four").',
      'scenes[1] must be an object with narration, visual and seconds (got "nope").',
      'scenes[2].seconds must be a number between 0.5 and 300 (got 0.1).',
      '"claimsToVerify" must be an array of strings (got "later").',
    ])
  })

  it('rejects missing scenes and too many hooks', () => {
    const r = parsePlan(JSON.stringify({ ...valid, scenes: [], hooks: ['a', 'b', 'c', 'd', 'e', 'f'] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContain('"scenes" needs at least one scene.')
    expect(r.errors).toContain('"hooks" has 6 entries; at most 5 are allowed.')
  })

  it('warns, without failing, about hook count, unknown fields, length and unlisted placeholders', () => {
    const r = parsePlan(
      JSON.stringify({
        ...valid,
        hooks: ['only one'],
        extra: true,
        script: 'We have served [number] customers since [year].',
        scenes: [{ narration: 'a', visual: 'b', seconds: 50, mood: 'x' }, { narration: 'c', visual: 'd', seconds: 50 }],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toEqual([
      'Expected 3 hooks, got 1.',
      'scenes[0]: ignored unknown field(s) mood.',
      'Ignored unknown field(s): extra.',
      'The scenes add up to 100s; short reels usually run 20–45s.',
      'The script contains [bracketed placeholders] but "claimsToVerify" is empty. Check what still needs filling in.',
    ])
  })
})

describe('graphic scenes', () => {
  const graphicScene = {
    narration: 'Day shift logs it.',
    visual: 'Request card',
    seconds: 4,
    kind: 'graphic',
    graphic: { template: 'card', label: 'Day shift', headline: 'Logged.', items: [{ label: 'Tried', text: 'The easy fix' }], emphasize: 0 },
  }

  it('imports graphic scenes and keeps asset scenes as the default', () => {
    const r = parsePlan(JSON.stringify({ ...valid, scenes: [valid.scenes[0], graphicScene] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.scenes[0]).toMatchObject({ kind: 'asset', graphic: null })
    expect(r.plan.scenes[1]).toMatchObject({ kind: 'graphic', graphic: { template: 'card', headline: 'Logged.', gather: false, emphasize: 0 } })
    // A graphic object without kind also counts as a graphic scene.
    const implicit = parsePlan(JSON.stringify({ ...valid, scenes: [{ ...graphicScene, kind: undefined }] }))
    expect(implicit.ok && implicit.plan.scenes[0].kind).toBe('graphic')
  })

  it('lists graphic problems with their paths and warns when there is too much to read', () => {
    const r = parsePlan(JSON.stringify({ ...valid, scenes: [{ ...graphicScene, graphic: { template: 'poster', headline: '', items: [{ label: 'x' }], emphasize: 5 } }, { ...graphicScene, kind: 'photo' }] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      'scenes[0].graphic.template must be one of title, card, notes, question (got "poster").',
      'scenes[0].graphic.headline is required.',
      'scenes[0].graphic.items[0].text is required.',
      'scenes[0].graphic.emphasize must be "headline" or an item index 0 to 0 (got 5).',
      'scenes[1].kind must be "asset" or "graphic" (got "photo").',
    ])
    const slow = parsePlan(JSON.stringify({ ...valid, scenes: [{ ...graphicScene, seconds: 1 }] }))
    expect(slow.ok && slow.warnings[0]).toMatch(/needs about [\d.]+s to read but the scene is 1s/)
  })

  it('reading time counts every word on screen', () => {
    expect(graphicReadingSeconds({ ...EMPTY_GRAPHIC, headline: 'one two three', items: [{ label: 'a', text: 'b c' }] })).toBe(3.2)
  })
})

describe('plan helpers', () => {
  const plan = (parsePlan(JSON.stringify(valid)) as { ok: true; plan: ContentPlan }).plan

  it('scales scene durations to a target while keeping proportions', () => {
    const scaled = scaleScenes(plan.scenes, 21)
    expect(scaled.map((s) => s.seconds)).toEqual([6, 10, 5])
    expect(totalSeconds(scaled)).toBe(21)
    expect(scaleScenes([], 10)).toEqual([])
  })

  it('snapshot changes when any plan content changes', () => {
    const a = planSnapshot(plan)
    const edited = { ...plan, scenes: plan.scenes.map((s, i) => (i === 1 ? { ...s, visual: 'different' } : s)) }
    expect(planSnapshot(edited)).not.toBe(a)
    expect(planSnapshot({ ...plan, recommendedHook: 2 })).not.toBe(a)
    expect(planSnapshot(null)).toBe('')
  })
})

describe('planning prompt', () => {
  it('includes every supplied input, marks missing ones, and sets the rules and schema', () => {
    const p = buildPlanningPrompt({ ...EMPTY_PLAN_INPUTS, business: 'Quiet Bands, a small studio\nin Lisbon', cta: 'Send us the idea.' })
    expect(p).toContain('Business description: Quiet Bands, a small studio in Lisbon')
    expect(p).toContain('Audience: (not provided)')
    expect(p).toContain('Call to action: Send us the idea.')
    expect(p).toContain('Do not invent facts, numbers, prices, results, testimonials')
    expect(p).toContain('"claimsToVerify"')
    expect(p).toContain('"format": "qb-content-plan"')
    expect(p).toContain('"version": 1')
    expect(p).toContain('Nothing will be generated by AI')
    expect(p).not.toMatch(/\d+ views|followers|went viral/i)
  })
})
