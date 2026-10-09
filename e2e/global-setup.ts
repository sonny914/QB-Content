// Generates small test media locally with ffmpeg. Nothing is downloaded or generated remotely.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { makeFixtures } from '../server/fixtures.mjs'

export const FIXTURES = 'test-results/fixtures'

export default async function globalSetup() {
  mkdirSync(FIXTURES, { recursive: true })
  for (const [name, color] of [['reel-a', 'black'], ['reel-b', 'orange']] as const) {
    const out = `${FIXTURES}/${name}.webm`
    if (existsSync(out)) continue
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:d=1:r=24`, '-c:v', 'libvpx', '-b:v', '200k', out])
  }
  await makeFixtures(FIXTURES)
}
