export const FIXTURE_DIR: string
export function makeFixtures(dir?: string): Promise<{ voice: string; orange: string; cream: string; clip: string; clipWebm: string; silentVideo: string }>
export function meanColorAt(file: string, seconds: number): Promise<number[]>
