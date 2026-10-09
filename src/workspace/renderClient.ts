// Browser-side client for the local render service (server/index.mjs), reached through the
// same-origin /api proxy. Files go to the render process on this computer and nowhere else.

export interface RenderTools {
  ffmpeg: string | null
  ffprobe: string | null
  ok: boolean
  problem: string | null
}

export type RenderHealth =
  | { reachable: true; ok: boolean; tools: RenderTools; limits: { maxAssets: number; maxFileBytes: number } }
  | { reachable: false; ok: false; error: string }

export interface RenderOutput {
  duration: number
  width: number
  height: number
  size: number
  ext: string
  mime: string
  timeline: number
  voiceDuration: number
  assetCount: number
}

export interface RenderJob {
  id: string
  status: 'uploading' | 'checking' | 'rendering' | 'done' | 'failed'
  progress: number
  message: string
  error: string | null
  notes: string[]
  output: RenderOutput | null
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error || fallback
  } catch {
    return fallback
  }
}

export async function fetchHealth(): Promise<RenderHealth> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    if (!res.ok) return { reachable: false, ok: false, error: await readError(res, `Render service answered ${res.status}`) }
    const body = (await res.json()) as { ok: boolean; tools: RenderTools; limits: { maxAssets: number; maxFileBytes: number } }
    return { reachable: true, ...body }
  } catch {
    return { reachable: false, ok: false, error: 'The local render service is not running.' }
  }
}

/** Upload with progress. Resolves with the job id once the server has accepted the files. */
export function submitRender(form: FormData, onUploadProgress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/renders')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress(e.loaded / e.total)
    }
    xhr.onerror = () => reject(new Error('Could not reach the local render service. Is it running?'))
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { id?: string; error?: string }
      if (xhr.status === 202 && body.id) resolve(body.id)
      else reject(new Error(body.error || `Render service answered ${xhr.status}`))
    }
    xhr.send(form)
  })
}

export async function getJob(id: string): Promise<RenderJob> {
  const res = await fetch(`/api/renders/${encodeURIComponent(id)}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(await readError(res, `Render job lookup failed (${res.status})`))
  return (await res.json()) as RenderJob
}

export async function fetchOutput(id: string, output: RenderOutput): Promise<File> {
  const res = await fetch(`/api/renders/${encodeURIComponent(id)}/output`, { cache: 'no-store' })
  if (!res.ok) throw new Error(await readError(res, `Could not fetch the rendered file (${res.status})`))
  return new File([await res.blob()], `qb-preview-${id.slice(0, 8)}.${output.ext}`, { type: output.mime })
}

export async function deleteJob(id: string): Promise<void> {
  await fetch(`/api/renders/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined)
}

/** Read a media file's duration in the browser, or null if this browser can't decode it. */
export function mediaDuration(file: File, kind: 'audio' | 'video'): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(kind)
    const url = URL.createObjectURL(file)
    const done = (value: number | null) => {
      URL.revokeObjectURL(url)
      el.removeAttribute('src')
      resolve(value)
    }
    el.preload = 'metadata'
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null)
    el.onerror = () => done(null)
    el.src = url
  })
}
