import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkTools, probe } from './ffmpeg.mjs'
import { meanColorAt } from './fixtures.mjs'
import * as graphicsModule from './graphics.mjs'
import {
  ensureFonts,
  fitText,
  graphicWordCount,
  readingSeconds,
  renderGraphicClip,
  renderGraphicFrame,
  validateGraphic,
  wrapText,
  WIDTH,
  HEIGHT,
} from './graphics.mjs'

let scratch
beforeAll(async () => {
  const tools = await checkTools()
  if (!tools.ok) throw new Error(`These tests need ffmpeg: ${tools.problem}`)
  scratch = await mkdtemp(path.join(tmpdir(), 'qb-graphics-test-'))
  ensureFonts()
})
afterAll(() => rm(scratch, { recursive: true, force: true }))

/** Does the canvas hold any pixel of the given colour class inside a region? */
function count(canvas, test, region = { x: 0, y: 0, w: WIDTH, h: HEIGHT }) {
  const d = canvas.getContext('2d').getImageData(region.x, region.y, region.w, region.h).data
  let n = 0
  for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++
  return n
}
const isCream = (r, g, b) => r > 200 && g > 195 && b > 180
const isOrange = (r, g, b) => r > 200 && g > 50 && g < 140 && b < 60
const isLit = (r, g, b) => r > 40 || g > 40 || b > 40

describe('validateGraphic', () => {
  it('normalises a full spec and rejects bad ones with the field named', () => {
    const spec = validateGraphic({ template: 'card', headline: ' Logged. ', label: 'Day shift', items: [{ label: 'Tried', text: 'The easy fix' }], emphasize: 0 }, 'scenes[1].graphic')
    expect(spec).toMatchObject({ template: 'card', headline: 'Logged.', label: 'Day shift', emphasize: 0, gather: false })
    expect(() => validateGraphic({ headline: '' })).toThrow('graphic.headline is required')
    expect(() => validateGraphic({ template: 'poster', headline: 'x' })).toThrow(/template must be one of title, card, notes, question/)
    expect(() => validateGraphic({ headline: 'x'.repeat(91) })).toThrow(/90 characters or fewer/)
    expect(() => validateGraphic({ headline: 'x', items: [1, 2, 3, 4, 5] })).toThrow(/at most 4 items/)
    expect(() => validateGraphic({ headline: 'x', items: [{ label: 'a' }] })).toThrow('graphic.items[0].text is required')
    expect(() => validateGraphic({ headline: 'x', items: [{ text: 'a' }], emphasize: 3 }, 'scenes[2].graphic')).toThrow('scenes[2].graphic.emphasize must be "headline" or an item index 0 to 0')
    expect(() => validateGraphic({ template: 'notes', headline: 'x' })).toThrow(/notes template needs at least one item/)
    expect(validateGraphic({ template: 'title', headline: 'x', gather: true }).gather).toBe(false) // gather is a notes thing
  })

  it('estimates reading time from the words on screen', () => {
    const spec = validateGraphic({ headline: 'One two three', support: 'four five six', items: [{ label: 'a', text: 'seven eight' }] })
    expect(graphicWordCount(spec)).toBe(9)
    expect(readingSeconds(spec)).toBe(4.2)
  })
})

describe('text layout', () => {
  it('wraps to the width and breaks words that would leave the frame', () => {
    const canvas = renderGraphicFrame(validateGraphic({ headline: 'x' }), 0, 1)
    const ctx = canvas.getContext('2d')
    ctx.font = '700 72px "QB Inter"'
    const lines = wrapText(ctx, 'A resident reports a leak under the sink this morning', 576)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(ctx.measureText(l).width).toBeLessThanOrEqual(576)
    const long = wrapText(ctx, 'Supercalifragilisticexpialidociousness', 300)
    for (const l of long) expect(ctx.measureText(l).width).toBeLessThanOrEqual(300)
    expect(long.join('')).toBe('Supercalifragilisticexpialidociousness')
  })

  it('shrinks a long headline to fit its line budget', () => {
    const canvas = renderGraphicFrame(validateGraphic({ headline: 'x' }), 0, 1)
    const ctx = canvas.getContext('2d')
    const short = fitText(ctx, 'Leak under the sink', { weight: 700, sizes: [76, 60, 46], maxWidth: 576, maxLines: 4 })
    expect(short.size).toBe(76)
    const long = fitText(ctx, 'A'.repeat(0) + 'The resident calls back in the evening and a different person asks them to explain everything again', { weight: 700, sizes: [76, 60, 46], maxWidth: 576, maxLines: 4 })
    expect(long.size).toBeLessThan(76)
    expect(long.lines.length).toBeLessThanOrEqual(5)
  })
})

describe('frames', () => {
  const specs = {
    title: validateGraphic({ template: 'title', label: 'Evening', headline: '"Can you explain what happened?"', support: 'Different person. Same leak.', emphasize: 'headline' }),
    card: validateGraphic({ template: 'card', label: 'Day shift', headline: 'Logged.', items: [{ label: 'Logged', text: 'Leak under the sink' }, { label: 'Tried', text: 'The easy fix' }, { label: 'Then', text: 'Clocked out' }], emphasize: 2 }),
    notes: validateGraphic({ template: 'notes', headline: 'One handoff.', gather: true, emphasize: 3, items: [{ label: 'Request', text: 'Leak under the sink' }, { label: 'Tried', text: 'The easy fix' }, { label: 'Owner', text: 'Evening desk' }, { label: 'Next', text: 'Maintenance visit' }] }),
    question: validateGraphic({ template: 'question', headline: 'Where does your team lose the thread between shifts?' }),
  }

  it('every template starts dark, shows cream text after the entrance, and keeps text inside the safe area', () => {
    for (const [name, spec] of Object.entries(specs)) {
      const before = renderGraphicFrame(spec, 0, 6)
      const after = renderGraphicFrame(spec, 2.5, 6)
      expect(count(before, isCream), `${name} at t=0`).toBeLessThan(count(after, isCream) / 4)
      expect(count(after, isCream), `${name} text visible`).toBeGreaterThan(2000)
      // Nothing drawn in the outer margins (left/right 60px, top 140px, bottom 180px).
      expect(count(after, isLit, { x: 0, y: 0, w: 60, h: HEIGHT }), `${name} left margin`).toBe(0)
      expect(count(after, isLit, { x: WIDTH - 60, y: 0, w: 60, h: HEIGHT }), `${name} right margin`).toBe(0)
      expect(count(after, isLit, { x: 0, y: 0, w: WIDTH, h: 140 }), `${name} top margin`).toBe(0)
      expect(count(after, isLit, { x: 0, y: HEIGHT - 180, w: WIDTH, h: 180 }), `${name} bottom margin`).toBe(0)
    }
  })

  it('emphasis turns orange after the midpoint and the gather moves the notes', () => {
    const card = specs.card
    const beforeLit = count(renderGraphicFrame(card, 1.6, 6), isOrange) // only the small label chip
    const afterLit = count(renderGraphicFrame(card, 5.0, 6), isOrange) // "Clocked out" lit + bar
    expect(afterLit).toBeGreaterThan(beforeLit + 600)
    const scattered = renderGraphicFrame(specs.notes, 2.2, 8)
    const gathered = renderGraphicFrame(specs.notes, 7.0, 8)
    // Gathered rows sit inside the card's left column; scattered notes extend beyond 420px on the right.
    expect(count(scattered, isCream, { x: 420, y: 500, w: 240, h: 600 })).toBeGreaterThan(200)
    expect(count(gathered, isCream, { x: 420, y: 500, w: 240, h: 600 })).toBeGreaterThan(0)
    // A large share of the note area changes between the scattered and the gathered layout.
    const a = scattered.getContext('2d').getImageData(72, 440, 576, 600).data
    const b = gathered.getContext('2d').getImageData(72, 440, 576, 600).data
    let changed = 0
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 40 || Math.abs(a[i + 1] - b[i + 1]) > 40) changed++
    expect(changed).toBeGreaterThan(20_000)
  })

  it('hero: one-line oversized headline that lands at `land`, then shrinks as the support line takes over', () => {
    const spec = validateGraphic({ template: 'hero', theme: 'light', headline: 'Morning.', accent: 'Morning. leak', land: 0.8, support: 'A leak under the sink.', beat: 2.0 })
    const before = renderGraphicFrame(spec, 0.5, 5)
    const landed = renderGraphicFrame(spec, 1.3, 5)
    const second = renderGraphicFrame(spec, 3.2, 5)
    expect(count(before, isOrange, { x: 72, y: 300, w: 576, h: 700 })).toBeLessThan(200) // headline not yet in
    const landedOrange = count(landed, isOrange, { x: 72, y: 300, w: 576, h: 700 })
    expect(landedOrange).toBeGreaterThan(8000) // "Morning." in orange, huge
    // After the beat the headline is small at the top and the support line fills the middle.
    expect(count(second, isOrange, { x: 72, y: 300, w: 576, h: 700 })).toBeLessThan(landedOrange)
    expect(count(second, (r, g, b) => r < 60 && g < 60 && b < 60, { x: 72, y: 250, w: 576, h: 400 })).toBeGreaterThan(5000) // black type on cream
    expect(count(second, isLit, { x: 0, y: 0, w: 60, h: HEIGHT })).toBeGreaterThan(0) // the orange corner forms are allowed in the margin
  })

  it('device: shows the media inside a card and pushes into the focus region', async () => {
    const { makeFixtures } = await import('./fixtures.mjs')
    const fx = await makeFixtures()
    const spec = validateGraphic({ template: 'device', theme: 'light', label: 'Day shift', media: 'asset', frame: 'phone', focus: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, zoom: { start: 0.2, end: 1.0 }, captions: [{ start: 0.1, end: 2, text: 'Day shift logs it,', highlight: 'logs' }] })
    const { deviceCard, prepareMedia } = await import('./graphics.mjs')
    const card = deviceCard('phone', 1)
    const media = await prepareMedia({ assetPath: fx.orange, kind: 'image', seconds: 2, slot: card, scale: 2, outDir: path.join(scratch, 'media-orange') })
    expect(media).toMatchObject({ count: 1, w: 800, h: 1664 })
    const { loadImage } = await import('@napi-rs/canvas')
    const image = await loadImage(path.join(media.dir, 'f00001.jpg'))
    const frame = renderGraphicFrame(spec, 1.5, 2, { image, w: media.w, h: media.h })
    // The card interior is the orange fixture; the caption shows the highlighted word; the label is there.
    expect(count(frame, isOrange, { x: card.x + 20, y: card.y + 20, w: card.w - 40, h: card.h - 40 })).toBeGreaterThan(card.w * card.h * 0.6)
    expect(count(frame, (r, g, b) => r < 60 && g < 60 && b < 60, { x: 100, y: 960, w: 520, h: 100 })).toBeGreaterThan(300) // caption text, above the player's bottom overlay zone
    // A device card has nothing to show without a file: there is no placeholder mode.
    expect(() => validateGraphic({ template: 'device', media: 'none' })).toThrow(/device card needs an uploaded screenshot or recording/)
    expect(() => validateGraphic({ template: 'device', media: 'placeholder' })).toThrow(/media must be "asset"/)
  })

  it('presenter: faceless by default, the captions become large centred type; nothing stands in for a person', () => {
    const spec = validateGraphic({ template: 'presenter', captions: [{ start: 0.5, end: 1.5, text: 'tries the easy fix,', highlight: 'easy' }, { start: 1.5, end: 2.5, text: 'clocks out.' }] })
    expect(spec.media).toBe('none')
    const early = renderGraphicFrame(spec, 0.2, 3)
    const first = renderGraphicFrame(spec, 1.0, 3)
    const second = renderGraphicFrame(spec, 2.0, 3)
    const middle = { x: 72, y: 300, w: 576, h: 600 }
    const captionZone = { x: 100, y: 960, w: 520, h: 110 }
    expect(count(early, isLit, middle)).toBe(0) // nothing before the first cue
    expect(count(first, isOrange, middle)).toBeGreaterThan(2000) // "easy", large
    expect(count(first, isCream, middle)).toBeGreaterThan(4000) // the rest of the cue, large
    expect(count(first, isLit, captionZone)).toBe(0) // not drawn as a small bottom caption
    expect(count(second, isOrange, middle)).toBe(0)
    expect(count(second, isCream, middle)).toBeGreaterThan(2000) // "clocks out."
    expect(count(first, isOrange, { x: 60, y: 100, w: 600, h: 80 })).toBe(0) // no "not supplied" label anywhere
  })

  it('validates the new properties', () => {
    expect(() => validateGraphic({ template: 'presenter', media: 'placeholder' })).toThrow(/media must be "asset" or "none"/)
    expect(() => validateGraphic({ template: 'hero', headline: 'x', theme: 'sepia' })).toThrow(/theme must be "dark" or "light"/)
    expect(() => validateGraphic({ template: 'device', focus: { x: 0.8, y: 0, w: 0.5, h: 0.5 } })).toThrow(/focus must be/)
    expect(() => validateGraphic({ template: 'device', zoom: { start: 2, end: 1 } })).toThrow(/zoom must be/)
    expect(() => validateGraphic({ template: 'presenter', captions: [{ start: 0, end: 1, text: '' }] })).toThrow(/captions\[0\].text is required/)
    expect(() => validateGraphic({ template: 'presenter', captions: [{ start: 1, end: 0.5, text: 'x' }] })).toThrow(/needs start and end seconds/)
    expect(validateGraphic({ template: 'presenter' })).toMatchObject({ media: 'none', headline: '', theme: 'dark', land: null, continues: false, ticket: null, events: [] })
    expect(validateGraphic({ template: 'hero', headline: 'x', land: 0.8 }).land).toBe(0.8)
    expect(validateGraphic({ template: 'device' })).toMatchObject({ media: 'asset' })
  })

  describe('ticket: a fictional request interface driven by events', () => {
    const ticket = { title: 'Leak under the kitchen sink', meta: 'Unit 4B · Reported by resident', time: '7:42 AM' }
    const interior = { x: 170, y: 180, w: 380, h: 700 }
    const block = { x: 200, y: 300, w: 320, h: 230 } // the request block's area inside the card, status chip included
    const isDimInk = (r, g, b) => r > 80 && r < 130 && g > 80 && g < 130 && b > 75 && b < 125 // inkDim composited on cream
    const isUiBg = (r, g, b) => r > 10 && r < 26 && g > 10 && g < 26 && b > 10 && b < 26

    it('validates the ticket, its events and the fiction label', () => {
      const spec = validateGraphic({ template: 'ticket', ticket, events: [{ type: 'request', at: 0.7 }, { type: 'note', text: 'Logged.', by: 'Day shift', time: '7:51 AM' }] })
      expect(spec.ticket).toEqual({ ...ticket, status: 'Open', shift: 'Day shift', app: 'Requests', subtitle: '', empty: 'Nothing open', handover: 'Shift change' })
      expect(spec.events).toEqual([{ type: 'request', at: 0.7, text: 'Request opened', by: '', time: '' }, { type: 'note', at: null, text: 'Logged.', by: 'Day shift', time: '7:51 AM' }])
      expect(spec.disclaimer).toBe('Illustration · not a real app')
      expect(spec.headline).toBe('') // optional here
      expect(validateGraphic({ template: 'ticket', ticket: { ...ticket, subtitle: 'Orders', empty: 'No open orders', handover: 'Owner change' } }).ticket).toMatchObject({ subtitle: 'Orders', empty: 'No open orders', handover: 'Owner change' })
      expect(() => validateGraphic({ template: 'ticket' })).toThrow(/ticket must be an object with at least a title/)
      expect(() => validateGraphic({ template: 'ticket', ticket: { meta: 'x' } })).toThrow(/ticket.title is required/)
      expect(() => validateGraphic({ template: 'ticket', ticket, disclaimer: '  ' })).toThrow(/disclaimer cannot be blank/)
      // The label must declare the fiction: a product name or "Live demo" is rejected.
      for (const bad of ['Live demo', 'Requests by Quiet Bands', 'Real customer data']) expect(() => validateGraphic({ template: 'ticket', ticket, disclaimer: bad })).toThrow(/disclaimer must say the interface is an illustration/)
      for (const ok of ['Mock-up only', 'Fictional example', 'Sample screen, not real data']) expect(validateGraphic({ template: 'ticket', ticket, disclaimer: ok }).disclaimer).toBe(ok)
      expect(() => validateGraphic({ template: 'ticket', ticket, events: [{ type: 'alarm' }] })).toThrow(/events\[0\].type must be one of request, note, action, shift/)
      expect(() => validateGraphic({ template: 'ticket', ticket, events: [{ type: 'note', at: -1, text: 'x' }] })).toThrow(/events\[0\].at must be a time/)
      expect(() => validateGraphic({ template: 'ticket', ticket, events: [{ type: 'shift' }] })).toThrow(/events\[0\].text is required for a shift event/)
      expect(() => validateGraphic({ template: 'ticket', ticket: { title: 'x'.repeat(45) } })).toThrow(/ticket.title must be 44 characters or fewer/)
      expect(() => validateGraphic({ template: 'ticket', ticket, events: new Array(7).fill({ type: 'request' }) })).toThrow(/at most 6 events/)
      expect(validateGraphic({ template: 'ticket', ticket, continues: true }).continues).toBe(true)
    })

    it('the request arrives at its time: empty inbox before, title block with a NEW chip after; the label is on every frame', () => {
      const spec = validateGraphic({ template: 'ticket', theme: 'light', ticket, events: [{ type: 'request', at: 0.7 }] })
      const before = renderGraphicFrame(spec, 0.6, 3.5)
      const after = renderGraphicFrame(spec, 1.6, 3.5)
      expect(count(before, isOrange, block)).toBe(0) // no NEW chip or status chip yet
      expect(count(after, isOrange, block)).toBeGreaterThan(400)
      expect(count(after, isCream, block)).toBeGreaterThan(count(before, isCream, block) + 1500) // the title text
      for (const frame of [before, after]) expect(count(frame, isDimInk, { x: 100, y: 895, w: 520, h: 40 })).toBeGreaterThan(300) // "ILLUSTRATION · NOT A REAL APP" in the theme's dim ink
    })

    it('a note types in, an action draws its check, and a shift change turns the lights out while the request stays lit', () => {
      const base = { template: 'ticket', theme: 'light', ticket, events: [{ type: 'request' }] }
      const noted = validateGraphic({ ...base, events: [{ type: 'request' }, { type: 'note', at: 0.4, text: 'Logged. Will check after rounds.', by: 'Day shift', time: '7:51 AM' }] })
      const typing = renderGraphicFrame(noted, 0.7, 2)
      const typed = renderGraphicFrame(noted, 1.6, 2)
      const plain = renderGraphicFrame(validateGraphic(base), 1.6, 2)
      expect(count(typed, isCream, interior)).toBeGreaterThan(count(typing, isCream, interior) + 300) // more of the note is on screen
      expect(count(typed, isCream, interior)).toBeGreaterThan(count(plain, isCream, interior) + 1000) // than with no note at all

      const acted = validateGraphic({ ...base, events: [{ type: 'request' }, { type: 'action', at: 0.2, text: 'Tightened the fitting.', by: 'Day shift', time: '11:20 AM' }] })
      const ring = count(renderGraphicFrame(acted, 0.35, 2), isOrange, interior)
      const check = count(renderGraphicFrame(acted, 1.2, 2), isOrange, interior)
      expect(check).toBeGreaterThan(ring + 150) // the circle and tick finish drawing
      // The ring must not vanish on the frame it completes (ring reaches 1 at 0.65 s here).
      const justBefore = count(renderGraphicFrame(acted, 0.64, 2), isOrange, interior)
      const complete = count(renderGraphicFrame(acted, 0.66, 2), isOrange, interior)
      expect(complete).toBeGreaterThan(justBefore - 80)
      // The header is pinned: the shift chip stays in the same place however far the view pushes in.
      const chipZone = { x: 420, y: 220, w: 130, h: 50 }
      expect(count(renderGraphicFrame(noted, 1.8, 2), isOrange, chipZone)).toBe(count(renderGraphicFrame(validateGraphic(base), 1.8, 2), isOrange, chipZone))

      const handed = validateGraphic({ ...base, events: [{ type: 'request' }, { type: 'shift', at: 1.0, text: 'Night shift', time: '3:00 PM' }] })
      const day = renderGraphicFrame(handed, 0.8, 3)
      const night = renderGraphicFrame(handed, 2.4, 3)
      const margin = { x: 0, y: 450, w: 100, h: 300 } // left of the card: background only
      expect(count(day, isCream, margin)).toBeGreaterThan(20_000)
      expect(count(night, isCream, margin)).toBe(0) // lights out
      expect(count(night, isLit, margin)).toBe(0)
      expect(count(night, isOrange, block)).toBeGreaterThan(count(day, isOrange, block) + 300) // "OPEN" fills orange
      expect(count(night, isUiBg, interior)).toBeGreaterThan(50_000) // the card is still there, lit
    })

    it('continues: no entrance and no fade, so a ticket carries across a cut', () => {
      const spec = validateGraphic({ template: 'ticket', theme: 'light', ticket, events: [{ type: 'request' }] })
      const carried = validateGraphic({ template: 'ticket', theme: 'light', ticket, events: [{ type: 'request' }], continues: true })
      expect(count(renderGraphicFrame(spec, 0, 2), isUiBg, interior)).toBe(0) // the card is still rising in
      expect(count(renderGraphicFrame(carried, 0, 2), isUiBg, interior)).toBeGreaterThan(50_000) // already there
      const { fadeColorBefore } = graphicsModule
      expect(fadeColorBefore(carried)).toBeNull()
      expect(fadeColorBefore(spec)).toBe('light')
      expect(fadeColorBefore(validateGraphic({ headline: 'x' }))).toBe('dark')
      expect(fadeColorBefore(null)).toBe('black')
      const lastFrame = (fadeTo) => count(renderGraphicFrame(spec, 1.99, 2, null, { fadeTo }), isLit)
      expect(lastFrame(null)).toBeGreaterThan(lastFrame('black') + 100_000) // a hard cut keeps the picture to the last frame
      // Fading through the next light scene's background keeps the cream ground and its orange form; the card dissolves.
      const faded = renderGraphicFrame(spec, 1.99, 2, null, { fadeTo: 'light' })
      expect(count(faded, isCream, { x: 0, y: 0, w: 60, h: 200 })).toBeGreaterThan(10_000)
      expect(count(faded, isOrange, { x: 560, y: 0, w: 160, h: 160 })).toBeGreaterThan(5_000)
      expect(count(faded, isUiBg, interior)).toBeLessThan(2_000)
      // The ground's forms drift over the whole run, so two scenes at the same absolute time match exactly.
      const a = renderGraphicFrame(spec, 1.5, 2, null, { offset: 3, total: 10 })
      const b = renderGraphicFrame(carried, 0.5, 2, null, { offset: 4, total: 10 })
      expect(count(a, isOrange, { x: 560, y: 0, w: 160, h: 160 })).toBe(count(b, isOrange, { x: 560, y: 0, w: 160, h: 160 }))
      // The chapter label rolls over from the previous scene's label.
      const rolled = validateGraphic({ template: 'ticket', theme: 'light', label: 'Day shift', ticket, events: [{ type: 'request' }], continues: true })
      const at0 = renderGraphicFrame(rolled, 0, 2, null, { labelFrom: 'Morning' })
      const at1 = renderGraphicFrame(rolled, 1, 2, null, { labelFrom: 'Morning' })
      const labelZone = { x: 160, y: 100, w: 400, h: 44 }
      expect(count(at0, isOrange, labelZone)).toBeGreaterThan(200) // "MORNING" still there at the cut
      expect(count(at1, isOrange, labelZone)).toBeGreaterThan(200) // "DAY SHIFT" once rolled
      const a0 = at0.getContext('2d').getImageData(160, 100, 400, 44).data
      const a1 = at1.getContext('2d').getImageData(160, 100, 400, 44).data
      let diff = 0
      for (let i = 0; i < a0.length; i += 4) if (Math.abs(a0[i + 1] - a1[i + 1]) > 60) diff++ // green separates orange from cream
      expect(diff).toBeGreaterThan(300)
    })
  })

  it('renders a clip of exactly the requested length with the text visible', async () => {
    const output = path.join(scratch, 'title.mp4')
    let last = 0
    const { frames } = await renderGraphicClip({ spec: specs.question, seconds: 3, output, onProgress: (p) => (last = p) })
    expect(frames).toBe(90)
    expect(last).toBeGreaterThan(0.9)
    const info = await probe(output)
    expect(info).toMatchObject({ kind: 'video', width: 720, height: 1280 })
    expect(info.duration).toBeGreaterThan(2.9)
    expect(info.duration).toBeLessThan(3.1)
    const dark = await meanColorAt(output, 0.02)
    const bright = await meanColorAt(output, 1.6)
    expect(bright[0] + bright[1] + bright[2]).toBeGreaterThan(dark[0] + dark[1] + dark[2] + 30)
  })
})
