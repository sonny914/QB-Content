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

test('the faceless style test renders through the app with no uploads: hero, then one ticket carried across three scenes', async ({ page }, info) => {
  test.setTimeout(180_000)
  await page.getByLabel("Paste Claude's JSON reply").fill(STYLE)
  await page.getByTestId('import-plan').click()
  await expect(page.getByTestId('scene')).toHaveCount(4)

  // Nothing in this plan needs a file, so it can render straight away (silent until a voiceover is chosen).
  await expect(page.getByTestId('plan-blockers')).not.toContainText('Assign an asset')
  await expect(page.getByTestId('create-from-plan')).toBeEnabled()
  await expect(page.getByTestId('create-from-plan')).toHaveText('Create silent preview from plan v1')
  await expect(page.getByLabel('Template for scene 2')).toHaveValue('ticket')
  await expect(page.getByLabel('Ticket title for scene 2')).toHaveValue('Leak under the kitchen sink')
  await expect(page.getByLabel('Event 1 type for scene 2')).toHaveValue('request')
  await expect(page.getByLabel('Event 1 at for scene 2')).toHaveValue('0.7')
  await expect(page.getByLabel('Fiction label for scene 2')).toHaveValue('Illustration · not a real app')
  await expect(page.getByLabel('Continues previous scene for scene 2')).not.toBeChecked()
  await expect(page.getByLabel('Continues previous scene for scene 3')).toBeChecked()
  await expect(page.getByLabel('Event 1 at for scene 3')).toHaveValue('') // already happened before this scene
  await expect(page.getByLabel('Event 2 text for scene 3')).toHaveValue('Logged. Will check after rounds.')
  await expect(page.getByLabel('Event 4 type for scene 4')).toHaveValue('shift')
  await expect(page.getByLabel('Caption 2 highlight for scene 4')).toHaveValue('out.')

  await page.getByTestId('plan-voice-input').setInputFiles(VOICE)
  await expect(page.getByTestId('create-from-plan')).toHaveText('Create preview from plan v1')
  await page.getByTestId('create-from-plan').click()
  await expect(page.getByTestId('plan-render-status-message')).toContainText('Preview ready: 720×1280, 10.4s', { timeout: 120_000 })
  await expect(page.getByTestId('player')).toBeVisible()
  await expect(page.getByTestId('activity')).toContainText('from plan v1: 4 scenes (4 motion graphics) + voiceover, 10.4s')
  await expect(status(page)).toHaveText('Draft')
  await page.screenshot({ path: `test-results/screens/style-${info.project.name}.png`, fullPage: true })

  // Editing an event is a plan change like any other.
  await page.getByLabel('Event 3 text for scene 4').fill('Tightened the fitting.')
  await page.getByLabel('Event 3 text for scene 4').blur()
  await expect(page.getByRole('heading', { name: 'Content plan · v2' })).toBeVisible()
  await expect(page.getByTestId('stale-render')).toContainText('rendered from plan v1; the plan is now v2')

  // The fiction label cannot be removed.
  await page.getByLabel('Fiction label for scene 2').fill('')
  await page.getByLabel('Fiction label for scene 2').blur()
  await expect(page.getByTestId('plan-blockers')).toContainText('Scene 2 needs a fiction label')
  await expect(page.getByTestId('create-from-plan')).toBeDisabled()
  await page.getByLabel('Fiction label for scene 2').fill('Illustration only')
  await page.getByLabel('Fiction label for scene 2').blur()
  await expect(page.getByTestId('plan-blockers')).not.toContainText('fiction label')

  // A presenter scene is faceless by default and never blocks; choosing a clip makes it an asset scene.
  await page.getByLabel('Template for scene 1').selectOption('presenter')
  await expect(page.getByLabel('Media for scene 1')).toHaveValue('none')
  await expect(page.getByTestId('plan-blockers')).not.toContainText('Assign an asset')
  await expect(page.getByTestId('create-from-plan')).toBeEnabled()
  await page.getByLabel('Media for scene 1').selectOption('asset')
  await expect(page.getByTestId('plan-blockers')).toContainText('Assign an asset to')
  await expect(page.getByTestId('create-from-plan')).toBeDisabled()
  await page.getByTestId('plan-asset-input').setInputFiles([CLIP])
  await page.getByLabel('Asset for scene 1').selectOption({ label: '1. clip-blue-1s.webm' })
  await expect(page.getByTestId('plan-blockers')).not.toContainText('Assign an asset')
  await expect(page.getByTestId('create-from-plan')).toBeEnabled()
})
