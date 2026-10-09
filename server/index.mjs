// Local render service for QB Content. Binds to 127.0.0.1 only.
// Files arrive from the browser on this computer, are rendered with ffmpeg in a temporary
// job folder, and the MP4 is served back to the player. Nothing leaves the machine.
import Busboy from 'busboy'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTools } from './ffmpeg.mjs'
import { JobStore } from './jobs.mjs'
import { MAX_ASSETS, resolveFormat } from './render.mjs'

const HOST = '127.0.0.1'
const PORT = Number(process.env.QB_RENDER_PORT || 5174)
const MAX_FILE_BYTES = 500 * 1024 * 1024
const MAX_FILES = MAX_ASSETS + 1
const VOICE_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4', '.mov', '.aif', '.aiff', '.wma', '.caf'])
const VISUAL_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.3gp'])

export function createServer(store, tools) {
  return http.createServer(async (req, res) => {
    try {
      await route(req, res, store, tools)
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Unexpected server error' })
    }
  })
}

async function route(req, res, store, tools) {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: tools.ok, tools, format: store.format.name, limits: { maxAssets: MAX_ASSETS, maxFileBytes: MAX_FILE_BYTES } })
  }

  if (parts[0] !== 'api' || parts[1] !== 'renders') return sendJson(res, 404, { error: 'Not found' })

  if (req.method === 'POST' && parts.length === 2) {
    if (!tools.ok) return sendJson(res, 503, { error: `Rendering is unavailable: ${tools.problem}` })
    return receiveRender(req, res, store)
  }

  const job = parts[2] ? store.get(parts[2]) : null
  if (!job) return sendJson(res, 404, { error: 'Render job not found. It may have expired or the render service restarted.' })

  if (req.method === 'GET' && parts.length === 3) return sendJson(res, 200, store.publicView(job))
  if (req.method === 'DELETE' && parts.length === 3) {
    await store.remove(job.id)
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === 'GET' && parts[3] === 'output' && parts.length === 4) {
    if (job.status !== 'done') return sendJson(res, 409, { error: `Render is ${job.status}, not finished` })
    return sendFile(req, res, store.outputPath(job), `qb-preview-${job.id.slice(0, 8)}.${store.format.ext}`, store.format.mime)
  }
  return sendJson(res, 404, { error: 'Not found' })
}

/** Stream the multipart upload into the job folder, then start the render. */
async function receiveRender(req, res, store) {
  let bb
  try {
    bb = Busboy({ headers: req.headers, limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 5, fieldSize: 10_000 } })
  } catch (err) {
    return sendJson(res, 400, { error: `Bad upload: ${err.message}` })
  }
  const job = await store.create()
  const files = { voiceover: null, assets: [] }
  const fields = {}
  const writes = []
  let failure = null
  let fileCount = 0

  const fail = (status, message) => {
    if (!failure) failure = { status, message }
  }

  bb.on('field', (name, value) => {
    fields[name] = value
  })
  bb.on('file', (field, stream, info) => {
    const original = sanitizeName(info.filename)
    const ext = path.extname(original).toLowerCase()
    const n = fileCount++
    let ok = true
    if (field === 'voiceover') {
      if (files.voiceover) { fail(400, 'Only one voiceover is allowed'); ok = false }
      else if (!VOICE_EXT.has(ext)) { fail(400, `Voiceover "${original}" is not a supported audio type`); ok = false }
    } else if (field === 'asset') {
      if (files.assets.length >= MAX_ASSETS) { fail(400, `At most ${MAX_ASSETS} assets per render`); ok = false }
      else if (!VISUAL_EXT.has(ext)) { fail(400, `Asset "${original}" is not a supported image or video type`); ok = false }
    } else {
      fail(400, `Unexpected file field "${field}"`); ok = false
    }
    if (!ok) { stream.resume(); return }

    // Files are stored under our own names; the browser's filename is only kept as a label.
    const dest = path.join(job.dir, `${field}-${n}${ext}`)
    const entry = { name: original, path: dest, size: 0 }
    if (field === 'voiceover') files.voiceover = entry
    else files.assets.push(entry)

    const out = createWriteStream(dest, { flags: 'wx' })
    stream.on('data', (chunk) => { entry.size += chunk.length })
    stream.on('limit', () => fail(413, `"${original}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`))
    writes.push(new Promise((resolve) => {
      out.on('error', (err) => { fail(500, `Could not write "${original}": ${err.message}`); resolve() })
      out.on('close', resolve)
      stream.pipe(out)
    }))
  })
  bb.on('filesLimit', () => fail(400, `Too many files (limit ${MAX_FILES})`))
  bb.on('error', (err) => fail(400, `Upload failed: ${err.message}`))

  const finished = new Promise((resolve) => {
    bb.on('close', resolve)
    bb.on('error', resolve)
  })
  req.pipe(bb)
  await finished
  await Promise.all(writes)

  let durations
  try {
    durations = JSON.parse(fields.durations ?? 'null')
  } catch {
    fail(400, 'The durations field is not valid JSON')
  }
  if (!failure && !files.voiceover) fail(400, 'A voiceover file is required')
  if (!failure && files.assets.length === 0) fail(400, 'Add at least one image or video clip')
  if (!failure && [files.voiceover, ...files.assets].some((f) => f.size === 0)) fail(400, 'One of the files is empty')

  if (failure) {
    await store.remove(job.id)
    return sendJson(res, failure.status, { error: failure.message })
  }

  sendJson(res, 202, { id: job.id })
  // Fire and forget: the client polls GET /api/renders/:id for status.
  void store.start(job, { voiceover: files.voiceover, assets: files.assets, durations })
}

function sanitizeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base.slice(0, 120) || 'file'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
  res.end(payload)
}

/** Serve the MP4 with HTTP Range support so the player can seek. */
async function sendFile(req, res, file, downloadName, mime) {
  const { size } = await stat(file)
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="${downloadName}"`,
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  createReadStream(file).pipe(res)
}

export async function startServer({ port = PORT, host = HOST, baseDir, format = resolveFormat() } = {}) {
  const tools = await checkTools(format.encoders)
  const store = new JobStore(baseDir, format)
  await store.init()
  const server = createServer(store, tools)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const close = async () => {
    await new Promise((resolve) => server.close(resolve))
    await store.destroy()
  }
  return { server, store, tools, close, address: server.address() }
}

// Windows paths need fileURLToPath here: a raw URL pathname (/C:/...) never equals argv[1] (C:\...).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  startServer().then(({ tools, address, close, store }) => {
    console.log(`QB render service on http://${address.address}:${address.port} (localhost only)`)
    if (tools.ok) console.log(`  ${tools.ffmpeg}; ${tools.ffprobe}; output ${store.format.name}`)
    else console.warn(`  Rendering unavailable: ${tools.problem}`)
    const stop = () => close().finally(() => process.exit(0))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  }).catch((err) => {
    console.error(`Render service failed to start: ${err.message}`)
    process.exit(1)
  })
}
