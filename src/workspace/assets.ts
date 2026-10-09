// Session-only media picked in the browser. Files never leave the page except to the local render service.
import { mediaDuration } from './renderClient'

export interface LibraryAsset {
  id: number
  file: File
  kind: 'image' | 'video'
  url: string
  /** Source clip length when the browser can read it; null for images or undecodable clips. */
  sourceDuration: number | null
}

let nextAssetId = 1

export const detectKind = (file: File): LibraryAsset['kind'] =>
  file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|3gp)$/i.test(file.name) ? 'video' : 'image'

export async function toLibraryAssets(files: File[]): Promise<LibraryAsset[]> {
  const out: LibraryAsset[] = []
  for (const file of files) {
    const kind = detectKind(file)
    out.push({
      id: nextAssetId++,
      file,
      kind,
      url: URL.createObjectURL(file),
      sourceDuration: kind === 'video' ? await mediaDuration(file, 'video') : null,
    })
  }
  return out
}

export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

export const r1 = (n: number) => Math.round(n * 10) / 10

/** Identify a file for change detection without reading it: name, size and modification time. */
export const fileKey = (file: File | null) => (file ? [file.name, file.size, file.lastModified] : null)
