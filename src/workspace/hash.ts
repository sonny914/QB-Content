import type { VideoVersion } from './model'

/**
 * Identify a video file by content. SHA-256 needs a secure context (https or localhost);
 * elsewhere (e.g. a phone on the LAN over plain http) fall back to a weaker
 * name + size + modified-time fingerprint, labelled as such in the UI.
 */
export async function identifyVideo(file: File): Promise<Omit<VideoVersion, 'version'>> {
  const base = { name: file.name, size: file.size }
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    return { ...base, hash: `sha256:${hex}`, hashKind: 'sha256' }
  }
  return { ...base, hash: `fp:${file.name}:${file.size}:${file.lastModified}`, hashKind: 'fingerprint' }
}
