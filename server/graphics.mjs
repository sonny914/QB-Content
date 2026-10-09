// Motion-graphic scenes: structured text, media and caption layers drawn frame by frame on a canvas
// and encoded with ffmpeg into a clip the assembly step treats like any other video. Only these
// templates and properties are understood; nothing here interprets free-text visual descriptions.
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { spawn } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { FFMPEG, run } from './ffmpeg.mjs'

export const WIDTH = 720
export const HEIGHT = 1280
export const FPS = 30
export const PALETTE = {
  black: '#000000',
  cream: '#F2EEE5',
  orange: '#FF5A00',
  creamDim: 'rgba(242,238,229,0.62)',
  creamLine: 'rgba(242,238,229,0.30)',
  panel: '#0A0A0A',
  ink: '#111111',
  inkDim: 'rgba(17,17,17,0.60)',
  inkLine: 'rgba(17,17,17,0.18)',
  lightPanel: '#FBF9F4',
}
export const TEMPLATES = ['title', 'card', 'notes', 'question', 'hero', 'device', 'presenter', 'ticket']
/** Templates that can show an uploaded image or clip in a media slot. */
export const MEDIA_TEMPLATES = ['device', 'presenter']
/** Templates where the headline is optional (the picture or the interface carries the scene). */
export const OPTIONAL_HEADLINE_TEMPLATES = ['device', 'presenter', 'ticket']
export const EVENT_TYPES = ['request', 'note', 'action', 'shift']
export const GRAPHIC_LIMITS = {
  headline: 90, support: 160, label: 24, items: 4, itemLabel: 20, itemText: 60, captions: 12, caption: 80,
  ticketTitle: 44, ticketMeta: 60, ticketTime: 12, ticketStatus: 16, ticketShift: 20, ticketApp: 24,
  events: 6, eventText: 70, eventBy: 20, disclaimer: 48,
}
/** Every ticket scene carries this on screen unless the plan supplies other wording. It cannot be blank. */
export const DEFAULT_DISCLAIMER = 'Illustration · not a real app'

/** Words a viewer can comfortably read per second of screen time, plus a settle-in allowance. */
export const READ_WORDS_PER_SECOND = 3
export const READ_SETTLE_SECONDS = 1.2

const SAFE_X = 72
const CONTENT_W = WIDTH - SAFE_X * 2
const SAFE_TOP = 160
const SAFE_BOTTOM = HEIGHT - 200 // leave room for player overlays at the bottom of a reel
const CAPTION_BOTTOM = HEIGHT - 150
const FAMILY = 'QB Inter'

let fontsReady = false
/** Register the bundled Inter faces (SIL OFL, see node_modules/@expo-google-fonts/inter/LICENSE_FONT). */
export function ensureFonts() {
  if (fontsReady) return
  const require = createRequire(import.meta.url)
  const dir = path.dirname(require.resolve('@expo-google-fonts/inter/package.json'))
  GlobalFonts.registerFromPath(path.join(dir, '700Bold', 'Inter_700Bold.ttf'), FAMILY)
  GlobalFonts.registerFromPath(path.join(dir, '500Medium', 'Inter_500Medium.ttf'), FAMILY)
  fontsReady = true
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Normalise a graphic spec or throw a message that names the problem. `where` prefixes messages. */
export function validateGraphic(raw, where = 'graphic') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object`)
  const template = str(raw.template) || 'title'
  if (!TEMPLATES.includes(template)) throw new Error(`${where}.template must be one of ${TEMPLATES.join(', ')} (got "${raw.template}")`)
  const headline = str(raw.headline)
  const needsHeadline = !OPTIONAL_HEADLINE_TEMPLATES.includes(template)
  if (needsHeadline && !headline) throw new Error(`${where}.headline is required`)
  if (headline.length > GRAPHIC_LIMITS.headline) throw new Error(`${where}.headline must be ${GRAPHIC_LIMITS.headline} characters or fewer (got ${headline.length})`)
  const support = str(raw.support)
  if (support.length > GRAPHIC_LIMITS.support) throw new Error(`${where}.support must be ${GRAPHIC_LIMITS.support} characters or fewer`)
  const label = str(raw.label)
  if (label.length > GRAPHIC_LIMITS.label) throw new Error(`${where}.label must be ${GRAPHIC_LIMITS.label} characters or fewer`)
  let items = []
  if (raw.items !== undefined && raw.items !== null) {
    if (!Array.isArray(raw.items)) throw new Error(`${where}.items must be an array`)
    if (raw.items.length > GRAPHIC_LIMITS.items) throw new Error(`${where}.items can hold at most ${GRAPHIC_LIMITS.items} items`)
    items = raw.items.map((it, i) => {
      if (!it || typeof it !== 'object') throw new Error(`${where}.items[${i}] must be an object with label and text`)
      const l = str(it.label)
      const t = str(it.text)
      if (!t) throw new Error(`${where}.items[${i}].text is required`)
      if (l.length > GRAPHIC_LIMITS.itemLabel) throw new Error(`${where}.items[${i}].label must be ${GRAPHIC_LIMITS.itemLabel} characters or fewer`)
      if (t.length > GRAPHIC_LIMITS.itemText) throw new Error(`${where}.items[${i}].text must be ${GRAPHIC_LIMITS.itemText} characters or fewer`)
      return { label: l, text: t }
    })
  }
  let emphasize = null
  if (raw.emphasize !== undefined && raw.emphasize !== null && raw.emphasize !== '') {
    if (raw.emphasize === 'headline') emphasize = 'headline'
    else if (Number.isInteger(raw.emphasize) && raw.emphasize >= 0 && raw.emphasize < items.length) emphasize = raw.emphasize
    else throw new Error(`${where}.emphasize must be "headline" or an item index 0 to ${Math.max(items.length - 1, 0)}`)
  }
  const gather = template === 'notes' && raw.gather === true
  if (template === 'notes' && items.length === 0) throw new Error(`${where}: the notes template needs at least one item`)

  const theme = raw.theme === undefined ? 'dark' : raw.theme
  if (theme !== 'dark' && theme !== 'light') throw new Error(`${where}.theme must be "dark" or "light"`)
  const accent = str(raw.accent)

  // Media slot. 'asset' consumes the next uploaded file. A presenter scene defaults to 'none': it then
  // runs faceless, with its captions as large type, so missing footage never blocks a render and no
  // placeholder is ever drawn into an export. A device card has nothing to show without a file.
  let media = 'none'
  if (template === 'presenter') {
    media = raw.media === undefined ? 'none' : raw.media
    if (media !== 'asset' && media !== 'none') throw new Error(`${where}.media must be "asset" or "none"`)
  } else if (template === 'device') {
    media = raw.media === undefined ? 'asset' : raw.media
    if (media !== 'asset') throw new Error(`${where}.media must be "asset": a device card needs an uploaded screenshot or recording`)
  }
  const frame = raw.frame === undefined ? 'auto' : raw.frame
  if (!['auto', 'phone', 'desktop'].includes(frame)) throw new Error(`${where}.frame must be auto, phone or desktop`)
  let focus = null
  if (raw.focus !== undefined && raw.focus !== null) {
    const f = raw.focus
    const vals = ['x', 'y', 'w', 'h'].map((k) => num(f?.[k]))
    if (vals.some((v) => v === null || v < 0 || v > 1) || vals[2] <= 0 || vals[3] <= 0 || vals[0] + vals[2] > 1.0001 || vals[1] + vals[3] > 1.0001) {
      throw new Error(`${where}.focus must be { x, y, w, h } as fractions of the media that stay inside it`)
    }
    focus = { x: vals[0], y: vals[1], w: vals[2], h: vals[3] }
  }
  let zoom = null
  if (raw.zoom !== undefined && raw.zoom !== null) {
    const s = num(raw.zoom?.start)
    const e = num(raw.zoom?.end)
    if (s === null || e === null || s < 0 || e <= s) throw new Error(`${where}.zoom must be { start, end } seconds with end after start`)
    zoom = { start: s, end: e }
  }
  const beat = raw.beat === undefined || raw.beat === null ? null : num(raw.beat)
  if (raw.beat !== undefined && raw.beat !== null && (beat === null || beat < 0)) throw new Error(`${where}.beat must be a time in seconds`)
  const land = raw.land === undefined || raw.land === null ? 0.3 : num(raw.land)
  if (land === null || land < 0) throw new Error(`${where}.land must be a time in seconds`)

  let captions = []
  if (raw.captions !== undefined && raw.captions !== null) {
    if (!Array.isArray(raw.captions)) throw new Error(`${where}.captions must be an array`)
    if (raw.captions.length > GRAPHIC_LIMITS.captions) throw new Error(`${where}.captions can hold at most ${GRAPHIC_LIMITS.captions} cues`)
    captions = raw.captions.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`${where}.captions[${i}] must be an object with start, end and text`)
      const text = str(c.text)
      const start = num(c.start)
      const end = num(c.end)
      if (!text) throw new Error(`${where}.captions[${i}].text is required`)
      if (text.length > GRAPHIC_LIMITS.caption) throw new Error(`${where}.captions[${i}].text must be ${GRAPHIC_LIMITS.caption} characters or fewer`)
      if (start === null || end === null || start < 0 || end <= start) throw new Error(`${where}.captions[${i}] needs start and end seconds with end after start`)
      return { text, start, end, highlight: str(c.highlight) }
    })
  }

  // Ticket: an original, clearly fictional maintenance-request interface, driven by timed events.
  let ticket = null
  let events = []
  let disclaimer = ''
  if (template === 'ticket') {
    const tk = raw.ticket
    if (!tk || typeof tk !== 'object' || Array.isArray(tk)) throw new Error(`${where}.ticket must be an object with at least a title`)
    const field = (key, limit, fallback = '') => {
      const v = str(tk[key]) || fallback
      if (v.length > limit) throw new Error(`${where}.ticket.${key} must be ${limit} characters or fewer`)
      return v
    }
    ticket = {
      title: field('title', GRAPHIC_LIMITS.ticketTitle),
      meta: field('meta', GRAPHIC_LIMITS.ticketMeta),
      time: field('time', GRAPHIC_LIMITS.ticketTime),
      status: field('status', GRAPHIC_LIMITS.ticketStatus, 'Open'),
      shift: field('shift', GRAPHIC_LIMITS.ticketShift, 'Day shift'),
      app: field('app', GRAPHIC_LIMITS.ticketApp, 'Requests'),
    }
    if (!ticket.title) throw new Error(`${where}.ticket.title is required`)
    if (raw.events !== undefined && raw.events !== null) {
      if (!Array.isArray(raw.events)) throw new Error(`${where}.events must be an array`)
      if (raw.events.length > GRAPHIC_LIMITS.events) throw new Error(`${where}.events can hold at most ${GRAPHIC_LIMITS.events} events`)
      events = raw.events.map((ev, i) => {
        if (!ev || typeof ev !== 'object') throw new Error(`${where}.events[${i}] must be an object with a type`)
        if (!EVENT_TYPES.includes(ev.type)) throw new Error(`${where}.events[${i}].type must be one of ${EVENT_TYPES.join(', ')} (got "${ev.type}")`)
        // `at` is seconds into the scene. Omitted (or null) means the event already happened before
        // the scene starts, so a later scene can carry the ticket on from an earlier one.
        let at = null
        if (ev.at !== undefined && ev.at !== null) {
          at = num(ev.at)
          if (at === null || at < 0) throw new Error(`${where}.events[${i}].at must be a time in seconds, or omitted for "already happened"`)
        }
        const text = str(ev.text)
        const by = str(ev.by)
        const time = str(ev.time)
        if (text.length > GRAPHIC_LIMITS.eventText) throw new Error(`${where}.events[${i}].text must be ${GRAPHIC_LIMITS.eventText} characters or fewer`)
        if (by.length > GRAPHIC_LIMITS.eventBy) throw new Error(`${where}.events[${i}].by must be ${GRAPHIC_LIMITS.eventBy} characters or fewer`)
        if (time.length > GRAPHIC_LIMITS.ticketTime) throw new Error(`${where}.events[${i}].time must be ${GRAPHIC_LIMITS.ticketTime} characters or fewer`)
        if ((ev.type === 'note' || ev.type === 'action' || ev.type === 'shift') && !text) throw new Error(`${where}.events[${i}].text is required for a ${ev.type} event`)
        return { type: ev.type, at, text, by, time }
      })
    }
    disclaimer = raw.disclaimer === undefined || raw.disclaimer === null ? DEFAULT_DISCLAIMER : str(raw.disclaimer)
    if (!disclaimer) throw new Error(`${where}.disclaimer cannot be blank: a fictional interface must say so on screen`)
    if (disclaimer.length > GRAPHIC_LIMITS.disclaimer) throw new Error(`${where}.disclaimer must be ${GRAPHIC_LIMITS.disclaimer} characters or fewer`)
  }
  // `continues`: this scene carries on the previous scene's picture. The previous graphic then does not
  // fade out at the cut, and this one skips its entrance.
  const continues = raw.continues === true

  return { template, theme, headline, support, label, accent, items, emphasize, gather, media, frame, focus, zoom, beat, land, captions, ticket, events, disclaimer, continues }
}

export function graphicWordCount(spec) {
  const text = [spec.headline, spec.support, spec.label, spec.ticket?.title ?? '', ...spec.items.flatMap((i) => [i.label, i.text])].join(' ')
  return text.split(/\s+/).filter(Boolean).length
}

/** Seconds a viewer needs to read everything on the scene (captions are timed, so they are excluded). */
export const readingSeconds = (spec) => Math.round((READ_SETTLE_SECONDS + graphicWordCount(spec) / READ_WORDS_PER_SECOND) * 10) / 10

// ---------- colours per theme ----------

function colors(theme) {
  return theme === 'light'
    ? { bg: PALETTE.cream, text: PALETTE.ink, dim: PALETTE.inkDim, line: PALETTE.inkLine, panel: PALETTE.lightPanel, accent: PALETTE.orange }
    : { bg: PALETTE.black, text: PALETTE.cream, dim: PALETTE.creamDim, line: PALETTE.creamLine, panel: PALETTE.panel, accent: PALETTE.orange }
}

// ---------- text layout ----------

function wrapLine(ctx, text, maxWidth, state) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate
      // A single word wider than the line is broken by characters so it can never leave the frame.
      while (ctx.measureText(current).width > maxWidth && current.length > 1) {
        let cut = current.length - 1
        while (cut > 1 && ctx.measureText(current.slice(0, cut)).width > maxWidth) cut--
        lines.push(current.slice(0, cut))
        current = current.slice(cut)
        if (state) state.broken = true
      }
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

export function wrapText(ctx, text, maxWidth, state) {
  return text.split(/\n/).flatMap((line) => (line.trim() ? wrapLine(ctx, line.trim(), maxWidth, state) : ['']))
}

/**
 * Pick the largest size whose wrapped text fits in maxLines without breaking a word. If no size
 * manages that, the smallest size is used, and a word may be broken so nothing leaves the frame.
 */
export function fitText(ctx, text, { weight, sizes, maxWidth, maxLines, lineHeight = 1.18 }) {
  let chosen = null
  for (const size of sizes) {
    ctx.font = `${weight} ${size}px "${FAMILY}"`
    const state = { broken: false }
    const lines = wrapText(ctx, text, maxWidth, state)
    chosen = { size, lines, lineHeight: Math.round(size * lineHeight), broken: state.broken }
    if (lines.length <= maxLines && !state.broken) break
  }
  return chosen
}

function drawLines(ctx, lines, x, y, { size, weight, color, lineHeight, align = 'left', alpha = 1 }) {
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.font = `${weight} ${size}px "${FAMILY}"`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  lines.forEach((line, i) => ctx.fillText(line, x, y + size + i * lineHeight))
  ctx.restore()
  return lines.length * lineHeight
}

/** Draw lines word by word so some words can carry a different colour (the accent). */
function drawAccentLines(ctx, lines, x, y, { size, weight, color, accentColor, accent, lineHeight, align = 'left', alpha = 1 }) {
  if (!accent) return drawLines(ctx, lines, x, y, { size, weight, color, lineHeight, align, alpha })
  const strip = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const accentWords = new Set(accent.split(/\s+/).map(strip).filter(Boolean))
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.font = `${weight} ${size}px "${FAMILY}"`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  const space = ctx.measureText(' ').width
  lines.forEach((line, i) => {
    const words = line.split(' ')
    const total = words.reduce((w, word) => w + ctx.measureText(word).width, 0) + space * (words.length - 1)
    let cx = align === 'center' ? x - total / 2 : x
    for (const word of words) {
      ctx.fillStyle = accentWords.has(strip(word)) ? accentColor : color
      ctx.fillText(word, cx, y + size + i * lineHeight)
      cx += ctx.measureText(word).width + space
    }
  })
  ctx.restore()
  return lines.length * lineHeight
}

function drawLabel(ctx, text, x, y, { color = PALETTE.orange, alpha = 1, size = 22 } = {}) {
  if (!text) return 0
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.font = `700 ${size}px "${FAMILY}"`
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  // Letter-spaced small caps, drawn character by character.
  let cx = x
  for (const ch of text.toUpperCase()) {
    ctx.fillText(ch, cx, y + size)
    cx += ctx.measureText(ch).width + size * 0.12
  }
  ctx.restore()
  return size + 8
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

// ---------- animation helpers ----------

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeOut = (p) => 1 - Math.pow(1 - p, 3)
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const lerp = (a, b, p) => a + (b - a) * p
/** 0..1 entrance progress for an element that starts at `start` and takes `dur` seconds. */
const enter = (t, start, dur = 0.5) => easeOut(clamp01((t - start) / dur))
const ENTER_RISE = 26

/** When the emphasis fires: a little past the middle of the scene, once the entrance has finished. */
function emphasisTime(seconds) {
  return Math.max(0.9, Math.min(seconds - 0.8, seconds * 0.55))
}
/** 0..1 "lit" progress and a scale pulse for emphasis. */
function emphasis(t, seconds) {
  const te = emphasisTime(seconds)
  const lit = clamp01((t - te) / 0.25)
  const p = clamp01((t - te) / 0.45)
  const pulse = 1 + 0.045 * Math.sin(Math.PI * p)
  return { lit, pulse }
}

function withRise(ctx, progress, draw) {
  ctx.save()
  ctx.globalAlpha *= progress
  ctx.translate(0, (1 - progress) * ENTER_RISE)
  draw()
  ctx.restore()
}

/** Mix text colour → orange as lit goes 0 → 1, by drawing the base colour and overlaying orange. */
function drawLitLines(ctx, lines, x, y, opts, lit, base = PALETTE.cream) {
  if (lit <= 0) return drawLines(ctx, lines, x, y, { ...opts, color: base })
  if (lit >= 1) return drawLines(ctx, lines, x, y, { ...opts, color: PALETTE.orange })
  drawLines(ctx, lines, x, y, { ...opts, color: base })
  return drawLines(ctx, lines, x, y, { ...opts, color: PALETTE.orange, alpha: lit })
}

// ---------- backgrounds ----------

/**
 * Theme background: plain black, or cream with a faint dot grid and one orange form off a corner.
 * `night` (0..1) darkens a light background to black: the ticket's shift change turns the lights out.
 */
function drawBackground(ctx, theme, t, seconds, night = 0) {
  const c = colors(theme)
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  if (theme !== 'light') return
  if (night >= 1) {
    ctx.fillStyle = PALETTE.black
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
    return
  }
  ctx.save()
  ctx.fillStyle = 'rgba(17,17,17,0.11)'
  for (let y = 24; y < HEIGHT; y += 36) for (let x = 24; x < WIDTH; x += 36) ctx.fillRect(x, y, 3, 3)
  // The orange form drifts in slowly over the scene, so even a still frame has a little life.
  const drift = easeInOut(clamp01(t / Math.max(seconds, 0.1)))
  ctx.fillStyle = PALETTE.orange
  ctx.beginPath()
  ctx.arc(WIDTH + 40 - drift * 30, -60 + drift * 20, 230, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(-90 + drift * 14, HEIGHT - 20, 170, 0, Math.PI * 2)
  ctx.fill()
  if (night > 0) {
    ctx.globalAlpha = night
    ctx.fillStyle = PALETTE.black
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
  }
  ctx.restore()
}

// ---------- captions ----------

/**
 * Timed caption cues at the bottom of the frame. One highlighted word reads in orange. `theme` is the
 * scene theme or a function of the cue, so a cue keeps one style even if the scene darkens under it.
 */
function drawCaptions(ctx, spec, t, theme = spec.theme) {
  for (const cue of spec.captions) {
    if (t < cue.start || t >= cue.end) continue
    const cueTheme = typeof theme === 'function' ? theme(cue) : theme
    const c = colors(cueTheme)
    const pop = easeOut(clamp01((t - cue.start) / 0.16))
    const fit = fitText(ctx, cue.text, { weight: 700, sizes: [44, 40, 36, 32], maxWidth: CONTENT_W - 20, maxLines: 2, lineHeight: 1.15 })
    const h = fit.lines.length * fit.lineHeight
    const y = CAPTION_BOTTOM - h
    ctx.save()
    ctx.globalAlpha *= pop
    ctx.translate(WIDTH / 2, y + h / 2)
    ctx.scale(lerp(0.92, 1, pop), lerp(0.92, 1, pop))
    ctx.translate(-WIDTH / 2, -(y + h / 2))
    if (cueTheme === 'light') {
      ctx.fillStyle = 'rgba(251,249,244,0.92)'
      const w = Math.max(...fit.lines.map((l) => ctx.measureText(l).width)) + 44
      roundRect(ctx, WIDTH / 2 - w / 2, y - 12, w, h + 20, 14)
      ctx.fill()
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.75)'
      ctx.shadowBlur = 18
      ctx.shadowOffsetY = 2
    }
    drawAccentLines(ctx, fit.lines, WIDTH / 2, y, { size: fit.size, weight: 700, color: c.text, accentColor: PALETTE.orange, accent: cue.highlight, lineHeight: fit.lineHeight, align: 'center' })
    ctx.restore()
  }
}

// ---------- templates: text ----------

function layoutHeadline(ctx, text, sizes, maxLines, maxWidth = CONTENT_W, lineHeight) {
  return fitText(ctx, text, { weight: 700, sizes, maxWidth, maxLines, lineHeight })
}
function layoutBody(ctx, text, sizes, maxLines, maxWidth = CONTENT_W) {
  return fitText(ctx, text, { weight: 500, sizes, maxWidth, maxLines })
}

function drawTitle(ctx, spec, t, seconds) {
  const c = colors(spec.theme)
  const head = layoutHeadline(ctx, spec.headline, [76, 68, 60, 52, 46], 4)
  const body = spec.support ? layoutBody(ctx, spec.support, [36, 32, 28], 4) : null
  const labelH = spec.label ? 22 + 24 : 0
  const headH = head.lines.length * head.lineHeight
  const bodyH = body ? body.lines.length * body.lineHeight + 28 : 0
  const barH = 6 + 28
  const total = labelH + headH + barH + bodyH
  let y = Math.round(Math.max(SAFE_TOP, (SAFE_TOP + SAFE_BOTTOM) / 2 - total / 2))

  if (spec.label) {
    withRise(ctx, enter(t, 0), () => drawLabel(ctx, spec.label, SAFE_X, y))
    y += labelH
  }
  const { lit, pulse } = emphasis(t, seconds)
  const litHead = spec.emphasize === 'headline' ? lit : 0
  const scale = spec.emphasize === 'headline' ? pulse : 1
  withRise(ctx, enter(t, 0.1), () => {
    ctx.save()
    ctx.translate(SAFE_X, y + headH / 2)
    ctx.scale(scale, scale)
    ctx.translate(-SAFE_X, -(y + headH / 2))
    drawLitLines(ctx, head.lines, SAFE_X, y, { size: head.size, weight: 700, lineHeight: head.lineHeight }, litHead, c.text)
    ctx.restore()
  })
  y += headH + 20
  const barW = Math.round(88 * enter(t, 0.35, 0.45))
  ctx.fillStyle = PALETTE.orange
  if (barW > 0) {
    roundRect(ctx, SAFE_X, y, barW, 6, 3)
    ctx.fill()
  }
  y += barH - 6
  if (body) {
    withRise(ctx, enter(t, 0.45), () => drawLines(ctx, body.lines, SAFE_X, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: c.dim }))
  }
}

/** Measure the rows of a card so the card can be sized before drawing. */
function layoutCardRows(ctx, items, width) {
  const labelW = 132
  const textW = width - labelW
  return items.map((it) => {
    const body = layoutBody(ctx, it.text, [30, 27, 24], 2, textW)
    const h = Math.max(44, body.lines.length * body.lineHeight + 12)
    return { ...it, body, h, labelW }
  })
}

function drawCardRow(ctx, row, x, y, width, lit, pulse, c) {
  ctx.save()
  ctx.translate(x, y + row.h / 2)
  ctx.scale(pulse, pulse)
  ctx.translate(-x, -(y + row.h / 2))
  if (lit > 0) {
    ctx.save()
    ctx.globalAlpha *= lit
    ctx.fillStyle = PALETTE.orange
    roundRect(ctx, x - 20, y + 4, 5, row.h - 8, 2.5)
    ctx.fill()
    ctx.restore()
  }
  drawLabel(ctx, row.label, x, y + 8, { color: c.dim, size: 18 })
  drawLitLines(ctx, row.body.lines, x + row.labelW, y + 2, { size: row.body.size, weight: 500, lineHeight: row.body.lineHeight }, lit, c.text)
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = c.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y + row.h + 8)
  ctx.lineTo(x + width, y + row.h + 8)
  ctx.stroke()
  ctx.restore()
}

function panel(ctx, x, y, w, h, r, theme) {
  const c = colors(theme)
  ctx.save()
  if (theme === 'light') {
    ctx.shadowColor = 'rgba(0,0,0,0.18)'
    ctx.shadowBlur = 40
    ctx.shadowOffsetY = 18
  }
  ctx.fillStyle = c.panel
  roundRect(ctx, x, y, w, h, r)
  ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = c.line
  ctx.lineWidth = theme === 'light' ? 1 : 2
  roundRect(ctx, x, y, w, h, r)
  ctx.stroke()
  ctx.restore()
}

function drawCard(ctx, spec, t, seconds) {
  const c = colors(spec.theme)
  const pad = 36
  const innerW = CONTENT_W - pad * 2
  const head = layoutHeadline(ctx, spec.headline, [48, 42, 36, 32], 3, innerW)
  const body = spec.support ? layoutBody(ctx, spec.support, [28, 25], 3, innerW) : null
  const rows = layoutCardRows(ctx, spec.items, innerW)
  const labelH = spec.label ? 22 + 20 : 0
  const headH = head.lines.length * head.lineHeight
  const bodyH = body ? body.lines.length * body.lineHeight + 16 : 0
  const rowsH = rows.reduce((sum, r) => sum + r.h + 20, rows.length ? 16 : 0)
  const cardH = pad + labelH + headH + bodyH + rowsH + pad
  const top = Math.round(Math.max(SAFE_TOP, (SAFE_TOP + SAFE_BOTTOM) / 2 - cardH / 2))

  withRise(ctx, enter(t, 0, 0.55), () => {
    panel(ctx, SAFE_X, top, CONTENT_W, cardH, 22, spec.theme)
    let y = top + pad
    if (spec.label) {
      drawLabel(ctx, spec.label, SAFE_X + pad, y)
      y += labelH
    }
    const { lit, pulse } = emphasis(t, seconds)
    drawLitLines(ctx, head.lines, SAFE_X + pad, y, { size: head.size, weight: 700, lineHeight: head.lineHeight }, spec.emphasize === 'headline' ? lit : 0, c.text)
    y += headH
    if (body) {
      y += 12
      drawLines(ctx, body.lines, SAFE_X + pad, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: c.dim })
      y += bodyH - 12
    }
    if (rows.length) y += 16
    rows.forEach((row, i) => {
      const p = enter(t, 0.45 + i * 0.22, 0.45)
      withRise(ctx, p, () => drawCardRow(ctx, row, SAFE_X + pad, y, innerW, spec.emphasize === i ? lit : 0, spec.emphasize === i ? pulse : 1, c))
      y += row.h + 20
    })
  })
}

/** Scattered-note positions and tilts for up to four items. */
const NOTE_SLOTS = [
  { x: 72, y: 470, w: 290, h: 180, rot: -0.07 },
  { x: 372, y: 540, w: 276, h: 180, rot: 0.05 },
  { x: 110, y: 720, w: 280, h: 180, rot: -0.03 },
  { x: 380, y: 800, w: 268, h: 180, rot: 0.06 },
]

function drawNote(ctx, item, slot, alpha, lit, pulse, asRow, theme) {
  const c = colors(theme)
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.translate(slot.x + slot.w / 2, slot.y + slot.h / 2)
  ctx.rotate(slot.rot)
  ctx.scale(pulse, pulse)
  ctx.translate(-slot.w / 2, -slot.h / 2)
  if (theme === 'light') {
    ctx.shadowColor = 'rgba(0,0,0,0.16)'
    ctx.shadowBlur = 28
    ctx.shadowOffsetY = 12
  }
  ctx.fillStyle = c.panel
  roundRect(ctx, 0, 0, slot.w, slot.h, 16)
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = lit > 0 ? PALETTE.orange : c.line
  ctx.lineWidth = lit > 0 ? 2 : 1.5
  ctx.stroke()
  const pad = asRow ? 20 : 22
  if (asRow) {
    drawLabel(ctx, item.label, pad, pad - 2, { color: c.dim, size: 17 })
    const body = layoutBody(ctx, item.text, [28, 25, 22], 2, slot.w - pad * 2 - 130)
    drawLitLines(ctx, body.lines, pad + 130, pad - 6, { size: body.size, weight: 500, lineHeight: body.lineHeight }, lit, c.text)
  } else {
    drawLabel(ctx, item.label, pad, pad - 2, { color: c.dim, size: 17 })
    const body = layoutHeadline(ctx, item.text, [30, 27, 24, 22], 3, slot.w - pad * 2)
    drawLitLines(ctx, body.lines, pad, pad + 26, { size: body.size, weight: 700, lineHeight: body.lineHeight }, lit, c.text)
  }
  ctx.restore()
}

function drawNotes(ctx, spec, t, seconds) {
  const c = colors(spec.theme)
  const head = layoutHeadline(ctx, spec.headline, [56, 48, 42, 36], 3)
  const headTop = SAFE_TOP + 20
  withRise(ctx, enter(t, 0), () => drawLines(ctx, head.lines, SAFE_X, headTop, { size: head.size, weight: 700, lineHeight: head.lineHeight, color: c.text }))

  const n = spec.items.length
  const { lit, pulse } = emphasis(t, seconds)
  // Gather: notes travel from their scattered slots into one card.
  const tg = spec.gather ? Math.max(1.2, Math.min(seconds - 1.6, seconds * 0.42)) : Infinity
  const g = spec.gather ? easeInOut(clamp01((t - tg) / 0.9)) : 0
  const rowH = 92
  const cardPad = 28
  const cardTop = 470
  const cardH = cardPad * 2 + n * rowH + (n - 1) * 14
  if (g > 0) {
    ctx.save()
    ctx.globalAlpha *= g
    panel(ctx, SAFE_X, cardTop, CONTENT_W, cardH, 22, spec.theme)
    ctx.restore()
  }
  spec.items.forEach((item, i) => {
    const from = NOTE_SLOTS[i]
    const to = { x: SAFE_X + cardPad, y: cardTop + cardPad + i * (rowH + 14), w: CONTENT_W - cardPad * 2, h: rowH, rot: 0 }
    const slot = {
      x: lerp(from.x, to.x, g),
      y: lerp(from.y, to.y, g),
      w: lerp(from.w, to.w, g),
      h: lerp(from.h, to.h, g),
      rot: from.rot * (1 - g),
    }
    const alpha = enter(t, 0.35 + i * 0.2, 0.45)
    const itemLit = spec.emphasize === i && (!spec.gather || g >= 1) ? lit : 0
    drawNote(ctx, item, slot, alpha, itemLit, spec.emphasize === i ? pulse : 1, g > 0.5, spec.theme)
  })
  if (spec.support) {
    const body = layoutBody(ctx, spec.support, [32, 28, 25], 3)
    const y = SAFE_BOTTOM - body.lines.length * body.lineHeight - 10
    const start = spec.gather ? tg + 0.7 : 0.35 + n * 0.2 + 0.2
    withRise(ctx, enter(t, start), () => drawLines(ctx, body.lines, SAFE_X, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: c.dim }))
  }
}

function drawQuestion(ctx, spec, t, seconds) {
  const c = colors(spec.theme)
  const head = layoutHeadline(ctx, spec.headline, [72, 64, 56, 50, 44], 5)
  const body = spec.support ? layoutBody(ctx, spec.support, [32, 28], 3) : null
  const labelH = spec.label ? 22 + 28 : 0
  const headH = head.lines.length * head.lineHeight
  const bodyH = body ? body.lines.length * body.lineHeight + 32 : 0
  const total = labelH + headH + 46 + bodyH
  let y = Math.round(Math.max(SAFE_TOP, (SAFE_TOP + SAFE_BOTTOM) / 2 - total / 2))
  if (spec.label) {
    withRise(ctx, enter(t, 0), () => drawLabel(ctx, spec.label, SAFE_X, y))
    y += labelH
  }
  withRise(ctx, enter(t, 0.1, 0.6), () => drawAccentLines(ctx, head.lines, SAFE_X, y, { size: head.size, weight: 700, color: c.text, accentColor: PALETTE.orange, accent: spec.accent, lineHeight: head.lineHeight }))
  y += headH + 24
  // The emphasis here is the orange rule drawing across under the question.
  const barP = easeOut(clamp01((t - emphasisTime(seconds) + 0.4) / 0.6))
  if (barP > 0) {
    ctx.fillStyle = PALETTE.orange
    roundRect(ctx, SAFE_X, y, Math.round(CONTENT_W * barP), 8, 4)
    ctx.fill()
  }
  y += 46
  if (body) withRise(ctx, enter(t, 0.6), () => drawLines(ctx, body.lines, SAFE_X, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: c.dim }))
}

// ---------- templates: hero (oversized type with scale beats) ----------

/** A word-sized punch: scale from `from` to 1 with an overshoot, over `dur`. */
function punch(t, start, dur = 0.32, from = 1.5) {
  const p = clamp01((t - start) / dur)
  const e = 1 - Math.pow(1 - p, 4)
  return { alpha: clamp01(p * 2.5), scale: lerp(from, 1, e) * (1 + 0.06 * Math.sin(Math.PI * p)) }
}

function drawHero(ctx, spec, t, seconds) {
  const c = colors(spec.theme)
  const beat = spec.beat ?? (spec.support ? Math.round(seconds * 0.5 * 10) / 10 : Infinity)
  const head = layoutHeadline(ctx, spec.headline, [150, 132, 116, 100, 88, 76], 2, CONTENT_W, 1.0)
  const headH = head.lines.length * head.lineHeight
  const sub = spec.support ? layoutHeadline(ctx, spec.support, [92, 80, 70, 60, 52], 3, CONTENT_W, 1.04) : null
  const subH = sub ? sub.lines.length * sub.lineHeight : 0

  // Phase one: the headline alone, huge, centred. Phase two: it shrinks to the top and the
  // support line lands at the same scale the headline had. Deliberate change of scale.
  const g = sub ? easeInOut(clamp01((t - beat) / 0.5)) : 0
  const headScale = lerp(1, 0.46, g)
  const centreY = (SAFE_TOP + SAFE_BOTTOM) / 2
  const headY = lerp(centreY - headH / 2, SAFE_TOP + 10, g)
  const landed = punch(t, spec.land)

  if (spec.label) withRise(ctx, enter(t, 0.05), () => drawLabel(ctx, spec.label, SAFE_X, lerp(centreY - headH / 2 - 56, SAFE_TOP - 46, g), { color: c.accent }))

  // Scale about the headline's top-left so it stays anchored to the safe margin.
  ctx.save()
  ctx.globalAlpha *= landed.alpha
  ctx.translate(SAFE_X, headY)
  ctx.scale(landed.scale * headScale, landed.scale * headScale)
  drawAccentLines(ctx, head.lines, 0, 0, { size: head.size, weight: 700, color: c.text, accentColor: PALETTE.orange, accent: spec.accent, lineHeight: head.lineHeight })
  ctx.restore()

  if (sub && t >= beat + 0.2) {
    // The second line lands once the headline has mostly made room for it, under its current height.
    const sp = punch(t, beat + 0.2, 0.34, 1.35)
    const subY = headY + headH * headScale + 36
    ctx.save()
    ctx.globalAlpha *= sp.alpha
    ctx.translate(SAFE_X, subY)
    ctx.scale(sp.scale, sp.scale)
    drawAccentLines(ctx, sub.lines, 0, 0, { size: sub.size, weight: 700, color: c.text, accentColor: PALETTE.orange, accent: spec.accent, lineHeight: sub.lineHeight })
    ctx.restore()
    void subH
  }
}

// ---------- templates: media (device card, presenter) ----------

/** Card geometry for a device slot, from the frame type and the media's aspect ratio. */
export function deviceCard(frame, mediaAspect) {
  const phone = frame === 'phone' || (frame === 'auto' && (mediaAspect ?? 0.5) < 1)
  if (phone) return { kind: 'phone', w: 400, h: 832, x: (WIDTH - 400) / 2, y: 190, r: 36 }
  return { kind: 'desktop', w: 600, h: 376, x: (WIDTH - 600) / 2, y: 440, r: 18 }
}

/** Source rectangle (in media pixels) for the current moment: full frame, or pushed into `focus`. */
function sourceRect(spec, media, t) {
  const full = { sx: 0, sy: 0, sw: media.w, sh: media.h }
  if (!spec.focus) return full
  const z = spec.zoom ?? { start: 0.4, end: 1.6 }
  const p = easeInOut(clamp01((t - z.start) / Math.max(z.end - z.start, 0.05)))
  const target = { sx: spec.focus.x * media.w, sy: spec.focus.y * media.h, sw: spec.focus.w * media.w, sh: spec.focus.h * media.h }
  // Keep the card's aspect ratio while zooming: fit the focus box inside a rect of the card's aspect.
  const aspect = media.w / media.h
  let tw = target.sw
  let th = target.sh
  if (tw / th > aspect) th = tw / aspect
  else tw = th * aspect
  const tx = Math.min(Math.max(target.sx + target.sw / 2 - tw / 2, 0), media.w - tw)
  const ty = Math.min(Math.max(target.sy + target.sh / 2 - th / 2, 0), media.h - th)
  return { sx: lerp(full.sx, tx, p), sy: lerp(full.sy, ty, p), sw: lerp(full.sw, tw, p), sh: lerp(full.sh, th, p) }
}

function drawDevice(ctx, spec, t, seconds, media) {
  const c = colors(spec.theme)
  const card = deviceCard(spec.frame, media ? media.w / media.h : null)
  const p = enter(t, 0, 0.6)
  const drift = easeInOut(clamp01(t / Math.max(seconds, 0.1)))
  const tilt = (spec.theme === 'light' ? -0.028 : -0.012) * (1 - drift * 0.5)
  const grow = lerp(1, 1.03, drift)

  if (spec.label) withRise(ctx, enter(t, 0.05), () => drawLabel(ctx, spec.label, SAFE_X, card.y - 62, { color: c.accent }))
  if (spec.headline) {
    const head = layoutHeadline(ctx, spec.headline, [44, 38, 32], 2)
    withRise(ctx, enter(t, 0.15), () => drawAccentLines(ctx, head.lines, SAFE_X, card.y - 62 - head.lines.length * head.lineHeight - 8, { size: head.size, weight: 700, color: c.text, accentColor: PALETTE.orange, accent: spec.accent, lineHeight: head.lineHeight }))
  }

  ctx.save()
  ctx.globalAlpha *= p
  ctx.translate(card.x + card.w / 2, card.y + card.h / 2 + (1 - p) * 40)
  ctx.rotate(tilt)
  ctx.scale(grow, grow)
  ctx.translate(-card.w / 2, -card.h / 2)
  drawBezel(ctx, card, spec.theme)
  const bezel = card.kind === 'phone' ? 10 : 8
  ctx.save()
  roundRect(ctx, bezel, bezel, card.w - bezel * 2, card.h - bezel * 2, card.r - bezel)
  ctx.clip()
  if (media?.image) {
    const s = sourceRect(spec, media, t)
    ctx.drawImage(media.image, s.sx, s.sy, s.sw, s.sh, bezel, bezel, card.w - bezel * 2, card.h - bezel * 2)
  } else {
    // Validation requires a file for a device card; a frame drawn without one stays a dark screen.
    ctx.fillStyle = PALETTE.panel
    ctx.fillRect(0, 0, card.w, card.h)
  }
  ctx.restore()
  drawBezelEdge(ctx, card)
  ctx.restore()

  drawCaptions(ctx, spec, t)
}

/** Shadowed black device body. Drawn in card-local coordinates. */
function drawBezel(ctx, card, theme) {
  ctx.save()
  ctx.shadowColor = theme === 'light' ? 'rgba(0,0,0,0.30)' : 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 60
  ctx.shadowOffsetY = 28
  ctx.fillStyle = '#050505'
  roundRect(ctx, 0, 0, card.w, card.h, card.r)
  ctx.fill()
  ctx.restore()
}
function drawBezelEdge(ctx, card) {
  ctx.strokeStyle = 'rgba(242,238,229,0.22)'
  ctx.lineWidth = 1.5
  roundRect(ctx, 0.75, 0.75, card.w - 1.5, card.h - 1.5, card.r)
  ctx.stroke()
}

/**
 * Presenter. With a clip: the owner to camera, full frame, with a slow push and bottom captions.
 * Without one (the default, faceless production): the same captions become large type in the middle
 * of the frame, each cue punching in as it is spoken. Nothing stands in for a person.
 */
function drawPresenter(ctx, spec, t, seconds, media) {
  const c = colors(spec.theme)
  const hasClip = Boolean(media?.image)
  if (hasClip) {
    const push = lerp(1.0, 1.08, easeInOut(clamp01(t / Math.max(seconds, 0.1))))
    const s = sourceRect(spec, media, t)
    ctx.save()
    ctx.translate(WIDTH / 2, HEIGHT / 2)
    ctx.scale(push, push)
    ctx.translate(-WIDTH / 2, -HEIGHT / 2)
    ctx.drawImage(media.image, s.sx, s.sy, s.sw, s.sh, 0, 0, WIDTH, HEIGHT)
    ctx.restore()
    const grad = ctx.createLinearGradient(0, HEIGHT - 420, 0, HEIGHT)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.72)')
    ctx.fillStyle = grad
    ctx.fillRect(0, HEIGHT - 420, WIDTH, 420)
  }
  const labelY = hasClip ? SAFE_TOP - 100 : SAFE_TOP - 20
  if (spec.label) withRise(ctx, enter(t, 0.1), () => drawLabel(ctx, spec.label, SAFE_X, labelY, { color: PALETTE.orange }))
  if (spec.headline) {
    const head = layoutHeadline(ctx, spec.headline, [56, 48, 42], 2)
    withRise(ctx, enter(t, 0.2), () => drawAccentLines(ctx, head.lines, SAFE_X, labelY + 40, { size: head.size, weight: 700, color: hasClip ? PALETTE.cream : c.text, accentColor: PALETTE.orange, accent: spec.accent, lineHeight: head.lineHeight }))
  }
  if (hasClip) drawCaptions(ctx, spec, t)
  else drawSpokenType(ctx, spec, t)
}

/** The faceless presenter: each caption cue as oversized centred type, held until the next cue. */
function drawSpokenType(ctx, spec, t) {
  const c = colors(spec.theme)
  const cues = spec.captions
  let current = -1
  for (let i = 0; i < cues.length; i++) if (t >= cues[i].start) current = i
  if (current < 0) return
  const cue = cues[current]
  const next = cues[current + 1]
  if (t >= cue.end && (!next || t >= next.start) && next) return
  const fit = fitText(ctx, cue.text, { weight: 700, sizes: [96, 84, 74, 64, 56, 48], maxWidth: CONTENT_W, maxLines: 4, lineHeight: 1.02 })
  const h = fit.lines.length * fit.lineHeight
  const top = Math.max(SAFE_TOP + 80, (SAFE_TOP + 80 + SAFE_BOTTOM) / 2 - h / 2)
  const land = punch(t, cue.start, 0.3, 1.3)
  ctx.save()
  ctx.globalAlpha *= land.alpha
  ctx.translate(SAFE_X, top + h / 2)
  ctx.scale(land.scale, land.scale)
  ctx.translate(-SAFE_X, -(top + h / 2))
  drawAccentLines(ctx, fit.lines, SAFE_X, top, { size: fit.size, weight: 700, color: c.text, accentColor: PALETTE.orange, accent: cue.highlight, lineHeight: fit.lineHeight })
  ctx.restore()
}

// ---------- template: ticket (an original, fictional request interface driven by events) ----------

/**
 * MOCK INTERFACE. Everything drawn here is fictional and drawn by this renderer: no real product,
 * customer or request. Every frame carries `spec.disclaimer` so the export says so too.
 */
const TICKET_CARD = { kind: 'phone', w: 400, h: 800, x: (WIDTH - 400) / 2, y: 170, r: 36 }
const TICKET_BEZEL = 10
const UI = { bg: '#121212', surface: '#1E1E1E', line: 'rgba(242,238,229,0.14)', text: PALETTE.cream, dim: 'rgba(242,238,229,0.55)' }
const EVENT_DUR = { request: 0.5, note: 0.45, action: 0.45, shift: 0.45 }

/** Events in order, with an implicit request at the start if the plan did not include one. */
function ticketEvents(spec) {
  const list = [...spec.events]
  if (!list.some((e) => e.type === 'request')) list.unshift({ type: 'request', at: null, text: '', by: '', time: spec.ticket.time })
  const key = (e) => (e.at === null ? -1 : e.at)
  return list.map((e, i) => ({ ...e, i })).sort((a, b) => key(a) - key(b) || a.i - b.i)
}
/** 0..1 progress of an event at time t; 1 for events that already happened. */
const eventProgress = (ev, t, dur = EVENT_DUR[ev.type]) => (ev.at === null ? 1 : easeOut(clamp01((t - ev.at) / dur)))
const eventStarted = (ev, t) => ev.at === null || t >= ev.at

function initials(name) {
  const parts = name.split(/\s+/).filter(Boolean)
  return parts.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '·'
}

/** Reveal the first n characters of wrapped lines (typing). */
function revealLines(lines, n) {
  const out = []
  let left = n
  for (const line of lines) {
    if (left <= 0) break
    out.push(line.slice(0, left))
    left -= line.length + 1
  }
  return out
}

function chip(ctx, text, x, y, { fill, stroke, color, size = 13, padX = 12, h = 30, alpha = 1, align = 'left' }) {
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.font = `700 ${size}px "${FAMILY}"`
  const letters = text.toUpperCase()
  let w = 0
  for (const ch of letters) w += ctx.measureText(ch).width + size * 0.1
  w += padX * 2 - size * 0.1
  const left = align === 'right' ? x - w : x
  roundRect(ctx, left, y, w, h, h / 2)
  if (fill) {
    ctx.fillStyle = fill
    ctx.fill()
  }
  if (stroke) {
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  let cx = left + padX
  for (const ch of letters) {
    ctx.fillText(ch, cx, y + h / 2 + 1)
    cx += ctx.measureText(ch).width + size * 0.1
  }
  ctx.restore()
  return { w, h }
}

function checkCircle(ctx, cx, cy, r, ring, tick, color) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2.5
  if (ring > 0) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ring)
    ctx.stroke()
  }
  if (tick > 0) {
    // A two-segment tick drawn progressively.
    const a = { x: cx - r * 0.45, y: cy + r * 0.02 }
    const b = { x: cx - r * 0.1, y: cy + r * 0.38 }
    const d = { x: cx + r * 0.5, y: cy - r * 0.32 }
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    if (tick < 0.4) ctx.lineTo(lerp(a.x, b.x, tick / 0.4), lerp(a.y, b.y, tick / 0.4))
    else {
      ctx.lineTo(b.x, b.y)
      const q = (tick - 0.4) / 0.6
      ctx.lineTo(lerp(b.x, d.x, q), lerp(b.y, d.y, q))
    }
    ctx.stroke()
  }
  ctx.restore()
}

function clockIcon(ctx, cx, cy, r, color) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx, cy - r * 0.55)
  ctx.lineTo(cx, cy)
  ctx.lineTo(cx + r * 0.45, cy + r * 0.25)
  ctx.stroke()
  ctx.restore()
}

/** Lay out the activity rows for the events that have started by t. Card-local coordinates. */
function layoutTicketRows(ctx, spec, events, t, top, width) {
  const rows = []
  let y = top
  for (const ev of events) {
    if (!eventStarted(ev, t)) continue
    let text
    let meta
    if (ev.type === 'request') {
      text = 'Request opened'
      meta = ['Resident', ev.time || spec.ticket.time].filter(Boolean).join(' · ')
    } else if (ev.type === 'shift') {
      text = 'Shift change'
      meta = [`${prevShift(spec, events, ev)} → ${ev.text}`, ev.time].filter(Boolean).join(' · ')
    } else {
      text = ev.text
      meta = [ev.by, ev.time].filter(Boolean).join(' · ')
    }
    const body = layoutBody(ctx, text, [21, 19], 2, width - 60)
    const h = body.lines.length * body.lineHeight + (meta ? 24 : 6) + 14
    rows.push({ ev, text, meta, body, y, h })
    y += h
  }
  return rows
}

function prevShift(spec, events, ev) {
  let name = spec.ticket.shift
  for (const e of events) {
    if (e === ev) break
    if (e.type === 'shift') name = e.text
  }
  return name
}

/** The camera inside the card: pushes toward a new note or action, pulls back out on a shift change. */
function ticketCamera(events, rows, t, iw, ih) {
  const centre = { z: 1, fx: iw / 2, fy: ih / 2 }
  const keys = []
  for (const ev of events) {
    if (!eventStarted(ev, t) && ev.at !== null) continue
    const row = rows.find((r) => r.ev === ev)
    if ((ev.type === 'note' || ev.type === 'action') && row) keys.push({ time: ev.at === null ? -Infinity : ev.at + 0.15, z: 1.12, fx: iw / 2, fy: row.y + row.h / 2 + 40 })
    else if (ev.type === 'shift') keys.push({ time: ev.at === null ? -Infinity : ev.at + 0.1, ...centre })
  }
  let from = centre
  let state = centre
  let lastTime = -Infinity
  for (const k of keys) {
    const p = k.time === -Infinity ? 1 : easeInOut(clamp01((k.time - lastTime) / 0.9))
    from = { z: lerp(from.z, state.z, p), fx: lerp(from.fx, state.fx, p), fy: lerp(from.fy, state.fy, p) }
    state = k
    lastTime = k.time
  }
  const p = lastTime === -Infinity ? 1 : easeInOut(clamp01((t - lastTime) / 0.9))
  return { z: lerp(from.z, state.z, p), fx: lerp(from.fx, state.fx, p), fy: lerp(from.fy, state.fy, p) }
}

function drawTicket(ctx, spec, t, seconds) {
  const c = colors(spec.theme)
  const card = TICKET_CARD
  const tk = spec.ticket
  const events = ticketEvents(spec)
  const request = events.find((e) => e.type === 'request')
  const shift = events.find((e) => e.type === 'shift' && eventStarted(e, t))
  const shiftP = shift ? eventProgress(shift, t) : 0
  // Lights out: a light scene goes black as the shift changes, and the open request stays lit.
  const night = spec.theme === 'light' && shift ? (shift.at === null ? 1 : easeInOut(clamp01((t - shift.at - 0.25) / 0.6))) : 0
  // The background is drawn by drawGraphicFrame without the night overlay; redraw it here with it.
  drawBackground(ctx, spec.theme, t, seconds, night)

  const p = spec.continues ? 1 : enter(t, 0, 0.5)
  // The chapter label above the card rolls over to the new shift's name with the shift change.
  const roll = shift ? (shift.at === null ? 1 : easeInOut(clamp01((t - shift.at) / 0.4))) : 0
  if (spec.label) {
    withRise(ctx, spec.continues ? 1 : enter(t, 0.05), () => {
      if (roll < 1) drawLabel(ctx, spec.label, SAFE_X, card.y - 62 - roll * 22, { color: PALETTE.orange, alpha: p * (1 - roll) })
      if (roll > 0) drawLabel(ctx, shift.text, SAFE_X, card.y - 62 + (1 - roll) * 22, { color: PALETTE.orange, alpha: p * roll })
    })
  }
  if (spec.headline) {
    const head = layoutHeadline(ctx, spec.headline, [44, 38, 32], 2)
    withRise(ctx, spec.continues ? 1 : enter(t, 0.15), () => drawAccentLines(ctx, head.lines, SAFE_X, card.y - 62 - head.lines.length * head.lineHeight - 8, { size: head.size, weight: 700, color: night > 0.5 ? PALETTE.cream : c.text, accentColor: PALETTE.orange, accent: spec.accent, lineHeight: head.lineHeight }))
  }

  ctx.save()
  ctx.globalAlpha *= p
  ctx.translate(card.x, card.y + (1 - p) * 40)
  drawBezel(ctx, card, night > 0.5 ? 'dark' : spec.theme)
  const b = TICKET_BEZEL
  const iw = card.w - b * 2
  const ih = card.h - b * 2
  ctx.save()
  roundRect(ctx, b, b, iw, ih, card.r - b)
  ctx.clip()
  ctx.translate(b, b)
  ctx.fillStyle = UI.bg
  ctx.fillRect(0, 0, iw, ih)

  // ----- layout (interior coordinates) -----
  const pad = 30
  const contentW = iw - pad * 2
  const reqP = request ? eventProgress(request, t) : 0
  const reqStarted = request ? eventStarted(request, t) : false
  const headerH = 128
  const title = layoutHeadline(ctx, tk.title, [31, 28, 25], 2, contentW, 1.12)
  const blockH = 30 + 12 + title.lines.length * title.lineHeight + (tk.meta ? 30 : 8) + 44 + 18
  const feedTop = headerH + blockH + 26
  const rows = layoutTicketRows(ctx, spec, events, t, feedTop + 34, contentW)
  const cam = ticketCamera(events, rows, t, iw, ih)

  ctx.save()
  ctx.translate(cam.fx, cam.fy)
  ctx.scale(cam.z, cam.z)
  ctx.translate(-cam.fx, -cam.fy)
  ctx.fillStyle = UI.bg
  ctx.fillRect(-iw, -ih, iw * 3, ih * 3)

  // Status strip: the time of the latest thing that happened.
  const latest = [...events].reverse().find((e) => eventStarted(e, t) && e.time)
  ctx.font = `500 15px "${FAMILY}"`
  ctx.fillStyle = UI.dim
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(latest?.time || tk.time || '', pad, 34)
  ctx.fillStyle = UI.dim
  roundRect(ctx, iw - pad - 26, 22, 26, 12, 4)
  ctx.fill()

  // Header: app name and the shift chip, which rolls over on a shift change.
  ctx.font = `700 28px "${FAMILY}"`
  ctx.fillStyle = UI.text
  ctx.fillText(tk.app, pad, 86)
  ctx.font = `500 16px "${FAMILY}"`
  ctx.fillStyle = UI.dim
  ctx.fillText('Maintenance', pad, 112)
  const chipY = 60
  const chipH = 30
  ctx.save()
  ctx.beginPath()
  ctx.rect(iw / 2, chipY - 6, iw / 2, chipH + 12)
  ctx.clip()
  const oldShift = shift ? prevShift(spec, events, shift) : tk.shift
  if (roll < 1) chip(ctx, oldShift, iw - pad, chipY - roll * (chipH + 10), { fill: PALETTE.orange, color: PALETTE.black, alpha: 1 - roll, align: 'right' })
  if (roll > 0) chip(ctx, shift.text, iw - pad, chipY + (1 - roll) * (chipH + 10), { fill: UI.surface, stroke: 'rgba(242,238,229,0.5)', color: UI.text, alpha: roll, align: 'right' })
  ctx.restore()
  ctx.fillStyle = UI.line
  ctx.fillRect(0, headerH - 1, iw, 1)

  // Request block, or the empty state before it arrives.
  if (!reqStarted || reqP < 1) {
    const emptyAlpha = reqStarted ? 1 - clamp01(reqP * 2) : 1
    ctx.save()
    ctx.globalAlpha *= emptyAlpha
    checkCircle(ctx, iw / 2, headerH + 110, 26, 1, 1, UI.dim)
    ctx.font = `500 20px "${FAMILY}"`
    ctx.fillStyle = UI.dim
    ctx.textAlign = 'center'
    ctx.fillText('No open requests', iw / 2, headerH + 176)
    ctx.restore()
  }
  if (reqStarted) {
    const slide = (1 - reqP) * -140
    // A notification sweep across the top of the screen as the request comes in.
    if (request.at !== null && t - request.at < 0.7) {
      const sw = clamp01((t - request.at) / 0.55)
      ctx.fillStyle = PALETTE.orange
      ctx.fillRect(0, 0, iw * sw, 4)
    }
    ctx.save()
    ctx.globalAlpha *= clamp01(reqP * 1.6)
    ctx.translate(0, slide)
    let y = headerH + 22
    if (shiftP > 0) {
      // Still open after the handover: the block gets an orange edge.
      ctx.save()
      ctx.globalAlpha *= shiftP
      ctx.fillStyle = PALETTE.orange
      roundRect(ctx, 8, y - 4, 4, blockH - 14, 2)
      ctx.fill()
      ctx.restore()
    }
    const pop = request.at === null ? { alpha: 1, scale: 1 } : punch(t, request.at + 0.25, 0.3, 1.6)
    const worked = events.find((e) => (e.type === 'note' || e.type === 'action') && eventStarted(e, t))
    const newAlpha = pop.alpha * (worked ? 1 - eventProgress(worked, t) : 1)
    if (newAlpha > 0) {
      ctx.save()
      ctx.globalAlpha *= newAlpha
      ctx.translate(pad + 24, y + 15)
      ctx.scale(pop.scale, pop.scale)
      ctx.translate(-(pad + 24), -(y + 15))
      chip(ctx, 'New', pad, y, { fill: PALETTE.orange, color: PALETTE.black, size: 12, h: 28 })
      ctx.restore()
    }
    ctx.font = `500 16px "${FAMILY}"`
    ctx.fillStyle = UI.dim
    ctx.textAlign = 'right'
    ctx.fillText(request.time || tk.time || '', iw - pad, y + 20)
    ctx.textAlign = 'left'
    y += 30 + 12
    drawLines(ctx, title.lines, pad, y, { size: title.size, weight: 700, lineHeight: title.lineHeight, color: UI.text })
    y += title.lines.length * title.lineHeight
    if (tk.meta) {
      ctx.font = `500 17px "${FAMILY}"`
      ctx.fillStyle = UI.dim
      ctx.fillText(tk.meta, pad, y + 22)
      y += 30
    } else y += 8
    // Status chip: outlined while the shift works it, filled and pulsing once the shift has gone.
    const lit = shiftP
    chip(ctx, tk.status, pad, y + 6, { stroke: PALETTE.orange, color: PALETTE.orange, size: 12, h: 28, alpha: 1 - lit })
    const dims = chip(ctx, tk.status, pad, y + 6, { fill: PALETTE.orange, color: PALETTE.black, size: 12, h: 28, alpha: lit })
    if (shift && shiftP >= 1) {
      const t0 = shift.at === null ? 0 : shift.at + 0.45
      if (t >= t0) {
        const q = ((t - t0) % 1.2) / 1.2
        ctx.save()
        ctx.globalAlpha *= (1 - q) * 0.8
        ctx.strokeStyle = PALETTE.orange
        ctx.lineWidth = 2.5
        roundRect(ctx, pad - 4 - q * 18, y + 2 - q * 18, dims.w + 8 + q * 36, dims.h + 8 + q * 36, (dims.h + 8) / 2 + q * 18)
        ctx.stroke()
        ctx.restore()
      }
    }
    ctx.restore()

    // Activity feed.
    const feedP = request.at === null ? 1 : enter(t, request.at + 0.3, 0.4)
    ctx.save()
    ctx.globalAlpha *= feedP
    ctx.fillStyle = UI.line
    ctx.fillRect(pad, feedTop, contentW, 1)
    drawLabel(ctx, 'Activity', pad, feedTop + 10, { color: UI.dim, size: 13 })
    ctx.restore()
    for (const row of rows) {
      const ev = row.ev
      const rp = ev === request ? feedP : eventProgress(ev, t)
      ctx.save()
      ctx.globalAlpha *= rp
      ctx.translate(0, (1 - rp) * 18)
      const ax = pad + 20
      const ay = row.y + 22
      if (ev.type === 'action') {
        const ring = ev.at === null ? 1 : clamp01((t - ev.at - 0.1) / 0.35)
        const tick = ev.at === null ? 1 : clamp01((t - ev.at - 0.4) / 0.3)
        checkCircle(ctx, ax, ay, 18, ring, tick, PALETTE.orange)
      } else if (ev.type === 'shift') {
        clockIcon(ctx, ax, ay, 17, UI.text)
      } else {
        ctx.fillStyle = UI.surface
        ctx.beginPath()
        ctx.arc(ax, ay, 19, 0, Math.PI * 2)
        ctx.fill()
        ctx.font = `700 14px "${FAMILY}"`
        ctx.fillStyle = UI.text
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(ev.type === 'request' ? 'R' : initials(ev.by || 'Note'), ax, ay + 1)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }
      let lines = row.body.lines
      if (ev.type === 'note' && ev.at !== null) {
        // A note is typed in; a caret blinks while it is.
        const total = row.text.length
        const typed = Math.min(total, Math.floor(clamp01((t - ev.at - 0.1) / 0.75) * total))
        lines = revealLines(row.body.lines, typed)
        if (typed < total && lines.length) {
          const last = lines[lines.length - 1]
          ctx.font = `500 ${row.body.size}px "${FAMILY}"`
          const cx = pad + 56 + ctx.measureText(last).width + 3
          const cy = row.y + 4 + (lines.length - 1) * row.body.lineHeight
          if (Math.floor(t * 6) % 2 === 0) {
            ctx.fillStyle = PALETTE.orange
            ctx.fillRect(cx, cy + 2, 2.5, row.body.size)
          }
        }
      }
      drawLines(ctx, lines, pad + 56, row.y + 4, { size: row.body.size, weight: 500, lineHeight: row.body.lineHeight, color: UI.text })
      if (row.meta) {
        ctx.font = `500 15px "${FAMILY}"`
        ctx.fillStyle = UI.dim
        ctx.fillText(row.meta, pad + 56, row.y + 4 + row.body.lines.length * row.body.lineHeight + 18)
      }
      ctx.restore()
    }
  }
  ctx.restore() // camera
  ctx.restore() // clip + interior
  drawBezelEdge(ctx, card)
  ctx.restore() // card

  // The fiction is labelled on every frame, under the card, in a colour that reads on cream and black.
  ctx.save()
  ctx.font = `700 15px "${FAMILY}"`
  let dw = -15 * 0.12
  for (const ch of spec.disclaimer.toUpperCase()) dw += ctx.measureText(ch).width + 15 * 0.12
  drawLabel(ctx, spec.disclaimer, WIDTH / 2 - dw / 2, card.y + card.h + 20, { color: '#8C8A85', size: 15, alpha: p })
  ctx.restore()

  // A caption keeps the style it started with: cues that start after lights-out use the dark style.
  const nightAt = (cue) => {
    if (spec.theme !== 'light' || !shift) return spec.theme
    const started = shift.at === null ? 1 : easeInOut(clamp01((cue.start - shift.at - 0.25) / 0.6))
    return started > 0.5 ? 'dark' : 'light'
  }
  drawCaptions(ctx, spec, t, nightAt)
}

const DRAW = { title: drawTitle, card: drawCard, notes: drawNotes, question: drawQuestion, hero: drawHero, device: drawDevice, presenter: drawPresenter, ticket: drawTicket }
/** Templates that draw their own captions (over media, or styled per cue). */
const OWN_CAPTIONS = ['device', 'presenter', 'ticket']

/** The colour a scene should fade to at its end so the cut into `next` (a graphic spec or null) doesn't pop. */
export function fadeColorBefore(next) {
  if (!next) return PALETTE.black
  if (next.continues) return null
  return colors(next.theme).bg
}

/**
 * Draw one frame of a graphic scene at time t (seconds) into ctx. `media` is the slot's current frame.
 * `fadeTo` is the colour the last 0.22 s fade into (black by default), or null for a hard cut.
 */
export function drawGraphicFrame(ctx, spec, t, seconds, media = null, { fadeTo = PALETTE.black } = {}) {
  ctx.save()
  ctx.globalAlpha = 1
  drawBackground(ctx, spec.theme, t, seconds)
  DRAW[spec.template](ctx, spec, t, seconds, media)
  if (!OWN_CAPTIONS.includes(spec.template) && spec.captions.length) drawCaptions(ctx, spec, t)
  // Short fade at the end so cuts between graphics don't pop; skipped when the next scene continues this one.
  const out = fadeTo ? clamp01((t - (seconds - 0.22)) / 0.22) : 0
  if (out > 0) {
    ctx.globalAlpha = out
    ctx.fillStyle = fadeTo
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
  }
  ctx.restore()
}

/** Render a single frame to a canvas (used by tests and previews). */
export function renderGraphicFrame(spec, t, seconds, media = null, options = {}) {
  ensureFonts()
  const canvas = createCanvas(WIDTH, HEIGHT)
  drawGraphicFrame(canvas.getContext('2d'), spec, t, seconds, media, options)
  return canvas
}

/**
 * Pre-render an uploaded asset for a media slot: frames at the clip rate, scaled to cover the slot
 * (at `scale`× when a zoom needs the extra pixels), a short clip holding its last frame. Returns
 * the frame folder, the frame count (1 for a still) and the frame size.
 */
export async function prepareMedia({ assetPath, kind, seconds, slot, scale = 1, outDir, signal }) {
  await mkdir(outDir, { recursive: true })
  const w = Math.round(slot.w * scale) & ~1
  const h = Math.round(slot.h * scale) & ~1
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error']
  if (kind === 'image') {
    args.push('-i', assetPath, '-frames:v', '1', '-vf', cover, '-q:v', '2', path.join(outDir, 'f%05d.jpg'))
  } else {
    const frames = Math.max(1, Math.round(seconds * FPS))
    args.push('-i', assetPath, '-an', '-vf', `${cover},fps=${FPS},tpad=stop_mode=clone:stop_duration=${seconds}`, '-frames:v', String(frames), '-q:v', '2', path.join(outDir, 'f%05d.jpg'))
  }
  await run(FFMPEG, args, { signal })
  const files = (await readdir(outDir)).filter((f) => f.endsWith('.jpg')).sort()
  if (files.length === 0) throw new Error('The media for this scene produced no frames')
  return { dir: outDir, count: files.length, w, h }
}

/** Resolve the media frame for frame index i: a still is loaded once, a clip frame by frame. */
async function mediaFrame(prepared, i, cache) {
  if (!prepared) return null
  const idx = Math.min(i, prepared.count - 1)
  if (cache.index === idx && cache.image) return { image: cache.image, w: prepared.w, h: prepared.h }
  const image = await loadImage(path.join(prepared.dir, `f${String(idx + 1).padStart(5, '0')}.jpg`))
  cache.index = idx
  cache.image = image
  return { image, w: prepared.w, h: prepared.h }
}

/**
 * Render a graphic scene to an H.264 clip of exactly `seconds` by piping raw RGBA frames into
 * ffmpeg. The clip has no audio; the assembly step adds the voiceover (or silence).
 */
export function renderGraphicClip({ spec, seconds, output, media = null, fadeTo = PALETTE.black, onProgress, signal }) {
  ensureFonts()
  const frames = Math.max(1, Math.round(seconds * FPS))
  const args = [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${WIDTH}x${HEIGHT}`, '-r', String(FPS), '-i', 'pipe:0',
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    output,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, signal })
    let stderr = ''
    let failed = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    child.on('error', (err) => { failed = true; reject(err.code === 'ENOENT' ? new Error(`${FFMPEG} is not installed or not on PATH`) : err) })
    child.on('close', (code) => (code === 0 ? resolve({ frames }) : reject(new Error(`Graphic render failed (ffmpeg exit ${code}): ${stderr.trim().split('\n').pop() || 'no output'}`))))
    child.stdin.on('error', () => {}) // a failing ffmpeg closes the pipe; 'close' carries the real error

    const canvas = createCanvas(WIDTH, HEIGHT)
    const ctx = canvas.getContext('2d')
    const cache = { index: -1, image: null }
    const write = (buf) => new Promise((res) => (child.stdin.write(buf) ? res() : child.stdin.once('drain', res)))
    ;(async () => {
      for (let i = 0; i < frames; i++) {
        if (signal?.aborted || failed) return child.kill()
        const m = await mediaFrame(media, i, cache)
        drawGraphicFrame(ctx, spec, i / FPS, seconds, m, { fadeTo })
        const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data
        if (onProgress && (i + 1) % 15 === 0) onProgress((i + 1) / frames)
        await write(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))
      }
      child.stdin.end()
    })().catch((err) => { failed = true; child.kill(); reject(err) })
  })
}
