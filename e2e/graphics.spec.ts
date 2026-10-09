import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const FX = 'test-results/fixtures'
const VOICE = `${FX}/voice-tone-4s.wav`
const EXAMPLE = readFileSync('docs/examples/handoff-reel-plan.json', 'utf8')

const status = (page: Page) => page.getByTestId('status')
const approveBtn = (page: Page) => page.getByRole('button', { name: 'Approve' })

async function watchToEnd(page: Page) {
  await page.getByTestId('player').evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    v.playbackRate = 4
    await v.play()
  })
  await expect(page.getByTestId('watched')).toHaveText('Watched to the end', { timeout: 60_000 })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the handoff example renders a complete silent preview from graphics alone, then with a voiceover', async ({ page }, info) => {
  test.setTimeout(240_000)
  await page.getByLabel("Paste Claude's JSON reply").fill(EXAMPLE)
  await page.getByTestId('import-plan').click()
  await expect(page.getByTestId('scene')).toHaveCount(7)
  await expect(page.getByTestId('graphic-editor')).toHaveCount(7)
  await expect(page.getByTestId('plan-timeline')).toContainText('Timeline 30s · no voiceover: the preview will be silent')

  // No uploads, no voiceover: still renderable, clearly as a silent preview.
  const create = page.getByTestId('create-from-plan')
  await expect(create).toHaveText('Create silent preview from plan v1')
  await expect(create).toBeEnabled()
  await expect(page.getByTestId('plan-blockers')).toContainText('No voiceover chosen: the preview will be rendered silent')
  await create.click()
  await expect(page.getByTestId('plan-render-status-message')).toContainText('Silent preview ready: 720×1280, 30s', { timeout: 180_000 })
  await expect(page.getByTestId('plan-render-status-notes')).toContainText('Silent preview: no voiceover was attached')
  await expect(page.getByTestId('player')).toBeVisible()
  await expect(page.getByTestId('silent-notice')).toContainText('Silent preview.')
  await expect(page.getByText('rendered locally from plan v1', { exact: false })).toBeVisible()
  await expect(page.getByTestId('activity')).toContainText('from plan v1: 7 scenes (7 motion graphics) + silent preview, no voiceover, 30s')
  await expect(status(page)).toHaveText('Draft')

  const duration = await page.getByTestId('player').evaluate((v: HTMLVideoElement) =>
    new Promise<number>((resolve) => (v.readyState >= 1 ? resolve(v.duration) : v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true }))),
  )
  expect(duration).toBeGreaterThan(29.8)
  expect(duration).toBeLessThan(30.3)
  await page.screenshot({ path: `test-results/screens/graphics-${info.project.name}.png`, fullPage: true })

  // Editing a graphic's structured fields is a plan change: the render goes stale and approval is blocked.
  await page.getByLabel('Headline for scene 7').fill('Where does your team lose the thread?')
  await page.getByLabel('Headline for scene 7').blur()
  await expect(page.getByRole('heading', { name: 'Content plan · v2' })).toBeVisible()
  await expect(page.getByTestId('stale-render')).toContainText('rendered from plan v1; the plan is now v2')
  await expect(approveBtn(page)).toBeDisabled()

  // With the recording, the result is a normal preview with the voiceover; scenes scaled to its length.
  await page.getByTestId('plan-voice-input').setInputFiles(VOICE)
  await page.getByTestId('scale-to-voice').click()
  // Seven scenes can't all shrink below the 0.5 s minimum, so a 4 s target lands at 4.1 s.
  await expect(page.getByTestId('plan-timeline')).toContainText(/Timeline 4(\.1)?s · voiceover 4s/)
  await expect(page.getByTestId('reading-time').first()).toContainText('Give it more time or fewer words')
  await expect(create).toHaveText('Create preview from plan v3')
  await create.click()
  await expect(page.getByTestId('plan-render-status-message')).toContainText(/Preview ready: 720×1280, 4(\.1)?s/, { timeout: 120_000 })
  await expect(page.getByTestId('plan-render-status-message')).not.toContainText('Silent')
  await expect(page.getByTestId('silent-notice')).toHaveCount(0)
  await expect(page.getByTestId('video-version')).toContainText('Video v2')
  await watchToEnd(page)
  await approveBtn(page).click()
  await expect(status(page)).toHaveText('Approved')
  await expect(page.getByTestId('download')).toBeEnabled()
})

test('switching a scene to a motion graphic in the editor needs no upload for that scene', async ({ page }) => {
  const plan = JSON.parse(EXAMPLE) as { scenes: { kind?: string; graphic?: unknown }[] }
  for (const s of plan.scenes) {
    delete s.kind
    delete s.graphic
  }
  await page.getByLabel("Paste Claude's JSON reply").fill(JSON.stringify(plan))
  await page.getByTestId('import-plan').click()
  await expect(page.getByTestId('graphic-editor')).toHaveCount(0)
  await expect(page.getByTestId('plan-blockers')).toContainText('Assign an asset to every asset scene, or switch them to motion graphics.')

  for (let i = 1; i <= 7; i++) await page.getByRole('radiogroup', { name: `Visual source for scene ${i}` }).getByLabel('Motion graphic').check()
  await expect(page.getByTestId('graphic-editor')).toHaveCount(7)
  await expect(page.getByLabel('Headline for scene 1')).toHaveValue('Morning.')
  await expect(page.getByTestId('plan-blockers')).not.toContainText('Assign an asset')
  await expect(page.getByTestId('create-from-plan')).toBeEnabled()
  await expect(page.getByTestId('activity')).toContainText('Plan v8: edited scene 7')

  // Items: add, fill, emphasise.
  await page.getByRole('button', { name: 'Add item' }).first().click()
  await page.getByLabel('Item 1 label for scene 1').fill('Request')
  await page.getByLabel('Item 1 text for scene 1').fill('Leak under the sink')
  await page.getByLabel('Item 1 text for scene 1').blur()
  await page.getByLabel('Emphasis for scene 1').selectOption('0')
  await expect(page.getByRole('heading', { name: /Content plan · v1[0-9]/ })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Item 1 text for scene 1')).toHaveValue('Leak under the sink')
  await expect(page.getByLabel('Emphasis for scene 1')).toHaveValue('0')
})
