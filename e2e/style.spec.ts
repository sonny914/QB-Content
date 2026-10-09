import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const FX = 'test-results/fixtures'
const VOICE = `${FX}/voice-tone-4s.wav`
const CLIP = `${FX}/clip-blue-1s.webm`
const STYLE = readFileSync('docs/examples/style-test-plan.json', 'utf8')

const status = (page: Page) => page.getByTestId('status')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the style test plan renders through the app: hero, device with an uploaded clip, presenter placeholder, captions', async ({ page }, info) => {
  test.setTimeout(180_000)
  await page.getByLabel("Paste Claude's JSON reply").fill(STYLE)
  await page.getByTestId('import-plan').click()
  await expect(page.getByTestId('scene')).toHaveCount(3)

  // Scene 2 is a device graphic that takes an uploaded recording; it blocks until one is assigned.
  await expect(page.getByTestId('plan-blockers')).toContainText('Assign an asset to every asset scene') // scene 2 is the only one needing a file
  await expect(page.getByTestId('create-from-plan')).toBeDisabled()
  await expect(page.getByLabel('Theme for scene 1')).toHaveValue('light')
  await expect(page.getByLabel('Headline lands at for scene 1')).toHaveValue('0.8')
  await expect(page.getByLabel('Media for scene 3')).toHaveValue('placeholder')
  await expect(page.getByLabel('Caption 1 text for scene 3')).toHaveValue('tries the easy fix,')
  await expect(page.getByLabel('Caption 1 highlight for scene 3')).toHaveValue('easy')

  await page.getByTestId('plan-asset-input').setInputFiles([CLIP])
  await page.getByLabel('Asset for scene 2').selectOption({ label: '1. clip-blue-1s.webm' })
  await expect(page.getByTestId('create-from-plan')).toBeEnabled()
  await expect(page.getByTestId('create-from-plan')).toHaveText('Create silent preview from plan v1')

  await page.getByTestId('plan-voice-input').setInputFiles(VOICE)
  await expect(page.getByTestId('create-from-plan')).toHaveText('Create preview from plan v1')
  await page.getByTestId('create-from-plan').click()
  await expect(page.getByTestId('plan-render-status-message')).toContainText('Preview ready: 720×1280, 10.4s', { timeout: 120_000 })
  await expect(page.getByTestId('player')).toBeVisible()
  await expect(page.getByTestId('activity')).toContainText('from plan v1: 3 scenes (3 motion graphics) + voiceover, 10.4s')
  await expect(status(page)).toHaveText('Draft')
  await page.screenshot({ path: `test-results/screens/style-${info.project.name}.png`, fullPage: true })

  // Editing a caption is a plan change like any other.
  await page.getByLabel('Caption 2 text for scene 3').fill('clocks out!')
  await page.getByLabel('Caption 2 text for scene 3').blur()
  await expect(page.getByRole('heading', { name: 'Content plan · v2' })).toBeVisible()
  await expect(page.getByTestId('stale-render')).toContainText('rendered from plan v1; the plan is now v2')

  // Switching the presenter slot to an uploaded clip makes it an asset scene for the arrangement.
  await page.getByLabel('Media for scene 3').selectOption('asset')
  await expect(page.getByTestId('plan-blockers')).toContainText('Assign an asset to scene 3')
  await page.getByLabel('Asset for scene 3').selectOption({ label: '1. clip-blue-1s.webm' })
  await expect(page.getByTestId('plan-blockers')).not.toContainText('Assign an asset')
})
