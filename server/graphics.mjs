// Motion-graphic scenes: structured text cards drawn frame by frame on a canvas and encoded with
// ffmpeg into a clip the assembly step treats like any other video. Only these templates and
// properties are understood; nothing here interprets free-text visual descriptions.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { FFMPEG } from './ffmpeg.mjs'

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
}
export const TEMPLATES = ['title', 'card', 'notes', 'question']
export const GRAPHIC_LIMITS = { headline: 90, support: 160, label: 24, items: 4, itemLabel: 20, itemText: 60 }

/** Words a viewer can comfortably read per second of screen time, plus a settle-in allowance. */
export const READ_WORDS_PER_SECOND = 3
export const READ_SETTLE_SECONDS = 1.2

const SAFE_X = 72
const CONTENT_W = WIDTH - SAFE_X * 2
const SAFE_TOP = 160
const SAFE_BOTTOM = HEIGHT - 200 // leave room for player overlays at the bottom of a reel
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

/** Normalise a graphic spec or throw a message that names the problem. `where` prefixes messages. */
export function validateGraphic(raw, where = 'graphic') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object`)
  const template = str(raw.template) || 'title'
  if (!TEMPLATES.includes(template)) throw new Error(`${where}.template must be one of ${TEMPLATES.join(', ')} (got "${raw.template}")`)
  const headline = str(raw.headline)
  if (!headline) throw new Error(`${where}.headline is required`)
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
  return { template, headline, support, label, items, emphasize, gather }
}

export function graphicWordCount(spec) {
  const text = [spec.headline, spec.support, spec.label, ...spec.items.flatMap((i) => [i.label, i.text])].join(' ')
  return text.split(/\s+/).filter(Boolean).length
}

/** Seconds a viewer needs to read everything on the scene. */
export const readingSeconds = (spec) => Math.round((READ_SETTLE_SECONDS + graphicWordCount(spec) / READ_WORDS_PER_SECOND) * 10) / 10

// ---------- text layout ----------

function wrapLine(ctx, text, maxWidth) {
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
      }
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

export function wrapText(ctx, text, maxWidth) {
  return text.split(/\n/).flatMap((line) => (line.trim() ? wrapLine(ctx, line.trim(), maxWidth) : ['']))
}

/** Pick the largest size whose wrapped text fits in maxLines; the smallest size is used regardless. */
export function fitText(ctx, text, { weight, sizes, maxWidth, maxLines }) {
  let chosen = null
  for (const size of sizes) {
    ctx.font = `${weight} ${size}px "${FAMILY}"`
    const lines = wrapText(ctx, text, maxWidth)
    chosen = { size, lines, lineHeight: Math.round(size * 1.18) }
    if (lines.length <= maxLines) break
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

/** Mix cream → orange as lit goes 0 → 1, by drawing cream and overlaying orange. */
function litColor(lit) {
  return lit <= 0 ? PALETTE.cream : lit >= 1 ? PALETTE.orange : null
}
function drawLitLines(ctx, lines, x, y, opts, lit) {
  const color = litColor(lit)
  if (color) return drawLines(ctx, lines, x, y, { ...opts, color })
  drawLines(ctx, lines, x, y, { ...opts, color: PALETTE.cream })
  return drawLines(ctx, lines, x, y, { ...opts, color: PALETTE.orange, alpha: lit })
}

// ---------- templates ----------

function layoutHeadline(ctx, text, sizes, maxLines, maxWidth = CONTENT_W) {
  return fitText(ctx, text, { weight: 700, sizes, maxWidth, maxLines })
}
function layoutBody(ctx, text, sizes, maxLines, maxWidth = CONTENT_W) {
  return fitText(ctx, text, { weight: 500, sizes, maxWidth, maxLines })
}

function drawTitle(ctx, spec, t, seconds) {
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
    drawLitLines(ctx, head.lines, SAFE_X, y, { size: head.size, weight: 700, lineHeight: head.lineHeight }, litHead)
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
    withRise(ctx, enter(t, 0.45), () => drawLines(ctx, body.lines, SAFE_X, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: PALETTE.creamDim }))
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

function drawCardRow(ctx, row, x, y, width, lit, pulse) {
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
  drawLabel(ctx, row.label, x, y + 8, { color: PALETTE.creamDim, size: 18 })
  drawLitLines(ctx, row.body.lines, x + row.labelW, y + 2, { size: row.body.size, weight: 500, lineHeight: row.body.lineHeight }, lit)
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = PALETTE.creamLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y + row.h + 8)
  ctx.lineTo(x + width, y + row.h + 8)
  ctx.stroke()
  ctx.restore()
}

function drawCard(ctx, spec, t, seconds) {
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
    ctx.fillStyle = PALETTE.panel
    roundRect(ctx, SAFE_X, top, CONTENT_W, cardH, 22)
    ctx.fill()
    ctx.strokeStyle = PALETTE.creamLine
    ctx.lineWidth = 2
    ctx.stroke()
    let y = top + pad
    if (spec.label) {
      drawLabel(ctx, spec.label, SAFE_X + pad, y)
      y += labelH
    }
    const { lit, pulse } = emphasis(t, seconds)
    drawLitLines(ctx, head.lines, SAFE_X + pad, y, { size: head.size, weight: 700, lineHeight: head.lineHeight }, spec.emphasize === 'headline' ? lit : 0)
    y += headH
    if (body) {
      y += 12
      drawLines(ctx, body.lines, SAFE_X + pad, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: PALETTE.creamDim })
      y += bodyH - 12
    }
    if (rows.length) y += 16
    rows.forEach((row, i) => {
      const p = enter(t, 0.45 + i * 0.22, 0.45)
      withRise(ctx, p, () => drawCardRow(ctx, row, SAFE_X + pad, y, innerW, spec.emphasize === i ? lit : 0, spec.emphasize === i ? pulse : 1))
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

function drawNote(ctx, item, slot, alpha, lit, pulse, asRow) {
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.translate(slot.x + slot.w / 2, slot.y + slot.h / 2)
  ctx.rotate(slot.rot)
  ctx.scale(pulse, pulse)
  ctx.translate(-slot.w / 2, -slot.h / 2)
  ctx.fillStyle = PALETTE.panel
  roundRect(ctx, 0, 0, slot.w, slot.h, 16)
  ctx.fill()
  ctx.strokeStyle = lit > 0 ? PALETTE.orange : PALETTE.creamLine
  ctx.lineWidth = lit > 0 ? 2 : 1.5
  ctx.stroke()
  const pad = asRow ? 20 : 22
  if (asRow) {
    drawLabel(ctx, item.label, pad, pad - 2, { color: PALETTE.creamDim, size: 17 })
    const body = layoutBody(ctx, item.text, [28, 25, 22], 2, slot.w - pad * 2 - 130)
    drawLitLines(ctx, body.lines, pad + 130, pad - 6, { size: body.size, weight: 500, lineHeight: body.lineHeight }, lit)
  } else {
    drawLabel(ctx, item.label, pad, pad - 2, { color: PALETTE.creamDim, size: 17 })
    const body = layoutHeadline(ctx, item.text, [30, 27, 24, 22], 3, slot.w - pad * 2)
    drawLitLines(ctx, body.lines, pad, pad + 26, { size: body.size, weight: 700, lineHeight: body.lineHeight }, lit)
  }
  ctx.restore()
}

function drawNotes(ctx, spec, t, seconds) {
  const head = layoutHeadline(ctx, spec.headline, [56, 48, 42, 36], 3)
  const headTop = SAFE_TOP + 20
  withRise(ctx, enter(t, 0), () => drawLines(ctx, head.lines, SAFE_X, headTop, { size: head.size, weight: 700, lineHeight: head.lineHeight, color: PALETTE.cream }))

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
    ctx.fillStyle = PALETTE.panel
    roundRect(ctx, SAFE_X, cardTop, CONTENT_W, cardH, 22)
    ctx.fill()
    ctx.strokeStyle = PALETTE.creamLine
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()
  }
  spec.items.forEach((item, i) => {
    const from = NOTE_SLOTS[i]
    const to = { x: SAFE_X + cardPad, y: cardTop + cardPad + i * (rowH + 14), w: CONTENT_W - cardPad * 2, h: rowH, rot: 0 }
    const slot = {
      x: from.x + (to.x - from.x) * g,
      y: from.y + (to.y - from.y) * g,
      w: from.w + (to.w - from.w) * g,
      h: from.h + (to.h - from.h) * g,
      rot: from.rot * (1 - g),
    }
    const alpha = enter(t, 0.35 + i * 0.2, 0.45)
    const itemLit = spec.emphasize === i && (!spec.gather || g >= 1) ? lit : 0
    drawNote(ctx, item, slot, alpha, itemLit, spec.emphasize === i ? pulse : 1, g > 0.5)
  })
  if (spec.support) {
    const body = layoutBody(ctx, spec.support, [32, 28, 25], 3)
    const y = SAFE_BOTTOM - body.lines.length * body.lineHeight - 10
    const start = spec.gather ? tg + 0.7 : 0.35 + n * 0.2 + 0.2
    withRise(ctx, enter(t, start), () => drawLines(ctx, body.lines, SAFE_X, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: PALETTE.creamDim }))
  }
}

function drawQuestion(ctx, spec, t, seconds) {
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
  withRise(ctx, enter(t, 0.1, 0.6), () => drawLines(ctx, head.lines, SAFE_X, y, { size: head.size, weight: 700, lineHeight: head.lineHeight, color: PALETTE.cream }))
  y += headH + 24
  // The emphasis here is the orange rule drawing across under the question.
  const barP = easeOut(clamp01((t - emphasisTime(seconds) + 0.4) / 0.6))
  if (barP > 0) {
    ctx.fillStyle = PALETTE.orange
    roundRect(ctx, SAFE_X, y, Math.round(CONTENT_W * barP), 8, 4)
    ctx.fill()
  }
  y += 46
  if (body) withRise(ctx, enter(t, 0.6), () => drawLines(ctx, body.lines, SAFE_X, y, { size: body.size, weight: 500, lineHeight: body.lineHeight, color: PALETTE.creamDim }))
}

const DRAW = { title: drawTitle, card: drawCard, notes: drawNotes, question: drawQuestion }

/** Draw one frame of a graphic scene at time t (seconds) into ctx. */
export function drawGraphicFrame(ctx, spec, t, seconds) {
  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = PALETTE.black
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  DRAW[spec.template](ctx, spec, t, seconds)
  // Short fade to black at the end so cuts between graphics don't pop.
  const out = clamp01((t - (seconds - 0.22)) / 0.22)
  if (out > 0) {
    ctx.globalAlpha = out
    ctx.fillStyle = PALETTE.black
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
  }
  ctx.restore()
}

/** Render a single frame to a canvas (used by tests and previews). */
export function renderGraphicFrame(spec, t, seconds) {
  ensureFonts()
  const canvas = createCanvas(WIDTH, HEIGHT)
  drawGraphicFrame(canvas.getContext('2d'), spec, t, seconds)
  return canvas
}

/**
 * Render a graphic scene to an H.264 clip of exactly `seconds` by piping raw RGBA frames into
 * ffmpeg. The clip has no audio; the assembly step adds the voiceover (or silence).
 */
export function renderGraphicClip({ spec, seconds, output, onProgress, signal }) {
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
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error(`${FFMPEG} is not installed or not on PATH`) : err))
    child.on('close', (code) => (code === 0 ? resolve({ frames }) : reject(new Error(`Graphic render failed (ffmpeg exit ${code}): ${stderr.trim().split('\n').pop() || 'no output'}`))))
    child.stdin.on('error', () => {}) // a failing ffmpeg closes the pipe; 'close' carries the real error

    const canvas = createCanvas(WIDTH, HEIGHT)
    const ctx = canvas.getContext('2d')
    let i = 0
    const pump = () => {
      while (i < frames) {
        if (signal?.aborted) return child.kill()
        drawGraphicFrame(ctx, spec, i / FPS, seconds)
        const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data
        i++
        if (onProgress && i % 15 === 0) onProgress(i / frames)
        if (!child.stdin.write(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))) {
          child.stdin.once('drain', pump)
          return
        }
      }
      child.stdin.end()
    }
    pump()
  })
}
