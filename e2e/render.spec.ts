import { expect, test, type Page } from '@playwright/test'
import { statSync } from 'node:fs'

const FX = 'test-results/fixtures'
const VOICE = `${FX}/voice-tone-4s.wav`
const ORANGE = `${FX}/frame-orange.png`
const CREAM = `${FX}/frame-cream-portrait.png`
// The browser tests run the render service with QB_RENDER_FORMAT=webm because Playwright's Chromium
// has no H.264/AAC decoders. The product default (MP4) is verified by server/render.test.mjs.
const CLIP = `${FX}/clip-blue-1s.webm`

const status = (page: Page) => page.getByTestId('status')
const approveBtn = (page: Page) => page.getByRole('button', { name: 'Approve' })

async function watchToEnd(page: Page) {
  await page.getByTestId('player').evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    await v.play()
  })
  await expect(page.getByTestId('watched')).toHaveText('Watched to the end', { timeout: 20_000 })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('render service is reachable and ffmpeg is available', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Create a preview' })).toBeVisible()
  await expect(page.getByTestId('service-warning')).toHaveCount(0)
  await expect(page.getByTestId('create-preview')).toBeDisabled()
})

test('creates a preview from a voiceover and assets, then review, approve and download', async ({ page }, info) => {
  await page.getByTestId('voice-input').setInputFiles(VOICE)
  await expect(page.getByTestId('voice-info')).toContainText('voice-tone-4s.wav')
  await expect(page.getByTestId('voice-info')).toContainText('4s')

  await page.getByTestId('asset-input').setInputFiles([ORANGE, CREAM])
  const seconds = page.getByRole('spinbutton', { name: /Seconds for asset/ })
  await expect(seconds).toHaveCount(2)
  await expect(seconds.nth(0)).toHaveValue('2') // 4s voiceover divided evenly
  await expect(seconds.nth(1)).toHaveValue('2')
  await expect(page.getByTestId('timeline')).toContainText('Timeline 4s · voiceover 4s')

  // Editable: shorten the second asset and see the mismatch warning.
  await seconds.nth(1).fill('1.5')
  await expect(page.getByTestId('timeline')).toContainText('Timeline 3.5s')
  await expect(page.getByTestId('timeline')).toContainText('narration will be cut off at 3.5s')

  // Download is locked and nothing is approved yet.
  await expect(page.getByTestId('download')).toBeDisabled()

  await page.getByTestId('create-preview').click()
  await expect(page.getByTestId('render-message')).toContainText('Preview ready: 720×1280, 3.5s', { timeout: 60_000 })
  await expect(page.getByTestId('render-notes')).toContainText('shorter than the voiceover')

  // The render landed in the review player as video v1, unapproved and unwatched.
  await expect(page.getByTestId('player')).toBeVisible()
  await expect(page.getByTestId('video-version')).toContainText('Video v1 · SHA-256')
  await expect(page.getByText('rendered locally', { exact: false }).first()).toBeVisible()
  await expect(page.getByTestId('activity')).toContainText('Video v1 rendered locally (2 assets + voiceover, 3.5s)')
  await expect(status(page)).toHaveText('Draft')
  await expect(approveBtn(page)).toBeDisabled()

  const playerDuration = await page.getByTestId('player').evaluate((v: HTMLVideoElement) =>
    new Promise<number>((resolve) => {
      if (v.readyState >= 1) resolve(v.duration)
      else v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true })
    }),
  )
  expect(playerDuration).toBeGreaterThan(3.4)
  expect(playerDuration).toBeLessThan(3.7)

  await watchToEnd(page)
  await approveBtn(page).click()
  await expect(status(page)).toHaveText('Approved')
  await page.screenshot({ path: `test-results/screens/render-${info.project.name}.png`, fullPage: true })

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()])
  expect(download.suggestedFilename()).toBe('qb-reel-v1.webm')
  const saved = await download.path()
  expect(statSync(saved!).size).toBeGreaterThan(10_000)

  // A second render is a new version and withdraws the approval.
  await page.getByTestId('asset-input').setInputFiles([CLIP])
  await expect(page.getByTestId('short-clip')).toContainText('This clip is 1s but set to')
  await page.getByTestId('create-preview').click()
  await expect(page.getByTestId('render-message')).toContainText('Preview ready', { timeout: 60_000 })
  await expect(page.getByTestId('video-version')).toContainText('Video v2')
  await expect(status(page)).toHaveText('Draft')
  await expect(page.getByTestId('activity')).toContainText('Approval withdrawn: new render')
  await expect(page.getByTestId('download')).toBeDisabled()
})

test('"Use clip length" and reordering adjust the timeline', async ({ page }) => {
  await page.getByTestId('voice-input').setInputFiles(VOICE)
  await page.getByTestId('asset-input').setInputFiles([CLIP, ORANGE])
  await expect(page.getByTestId('short-clip')).toContainText('its last frame will hold for 1s', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Use clip length' }).click()
  await expect(page.getByRole('spinbutton', { name: 'Seconds for asset 1' })).toHaveValue('1')
  await expect(page.getByTestId('short-clip')).toHaveCount(0)
  await page.getByRole('button', { name: 'Move asset 2 up' }).click()
  await expect(page.getByTestId('assets').locator('li').first()).toContainText('frame-orange.png')
  await page.getByRole('button', { name: 'Remove asset 1' }).click()
  await expect(page.getByTestId('assets').locator('li')).toHaveCount(1)
})

test('a failed render shows the service error', async ({ page }) => {
  await page.getByTestId('voice-input').setInputFiles(ORANGE) // an image is not a voiceover
  await page.getByTestId('asset-input').setInputFiles([CREAM])
  await page.getByTestId('create-preview').click()
  await expect(page.getByTestId('render-message')).toContainText('not a supported audio type', { timeout: 30_000 })
  await expect(page.getByTestId('player')).toHaveCount(0)
})
