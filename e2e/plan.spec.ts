import { expect, test, type Page } from '@playwright/test'

const FX = 'test-results/fixtures'
const VOICE = `${FX}/voice-tone-4s.wav`
const ORANGE = `${FX}/frame-orange.png`
const CREAM = `${FX}/frame-cream-portrait.png`

// Test data only: a plan in the documented format (docs/content-plan-format.md). Nothing here is a
// real client, offer or result.
const VALID_PLAN = {
  format: 'qb-content-plan',
  version: 1,
  hooks: ['Before you build it, try to kill it.', 'Most ideas fail before launch.', 'Test the idea, not your patience.'],
  recommendedHook: 0,
  script: 'Before you build it, try to kill it. We look for the reason it will not work. Send us the idea.',
  scenes: [
    { narration: 'Before you build it, try to kill it.', visual: 'Owner at the desk, looking up.', seconds: 2 },
    { narration: 'We look for the reason it will not work.', visual: 'Hands marking up a printed page.', seconds: 2 },
    { narration: 'Send us the idea.', visual: 'Text card with the call to action.', seconds: 1 },
  ],
  claimsToVerify: ['Confirm the studio has run this process for clients before saying so'],
}

const status = (page: Page) => page.getByTestId('status')
const approveBtn = (page: Page) => page.getByRole('button', { name: 'Approve' })

async function watchToEnd(page: Page) {
  await page.getByTestId('player').evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    await v.play()
  })
  await expect(page.getByTestId('watched')).toHaveText('Watched to the end', { timeout: 20_000 })
}

async function importPlan(page: Page, json: string) {
  await page.getByLabel("Paste Claude's JSON reply").fill(json)
  await page.getByTestId('import-plan').click()
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('"Copy planning prompt" copies our prompt with the inputs; it calls nothing', async ({ page }) => {
  await page.getByLabel('Business description').fill('A two-person design studio in Lisbon')
  await page.getByLabel('Call to action').fill('Send us the idea you are about to build.')
  await expect(page.getByText('It does not call Claude, any AI service, or anything outside this page.')).toBeVisible()

  await page.getByTestId('copy-prompt').click()
  await expect(page.getByTestId('copy-status')).toHaveText('Copied to the clipboard.')
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboard).toContain('Business description: A two-person design studio in Lisbon')
  expect(clipboard).toContain('Call to action: Send us the idea you are about to build.')
  expect(clipboard).toContain('Audience: (not provided)')
  expect(clipboard).toContain('Do not invent facts, numbers, prices, results, testimonials')
  expect(clipboard).toContain('"format": "qb-content-plan"')

  await page.getByRole('button', { name: 'Show the prompt' }).click()
  await expect(page.getByTestId('prompt-text')).toHaveValue(clipboard)

  // Inputs persist across a reload.
  await page.reload()
  await expect(page.getByLabel('Business description')).toHaveValue('A two-person design studio in Lisbon')
  await expect(page.getByRole('button', { name: /Generate/ })).toHaveCount(0)
})

test('invalid imports are explained and never overwrite the current plan', async ({ page }) => {
  await importPlan(page, '{ "format": "qb-content-plan", "version": 2, "hooks": [], "script": "", "scenes": "soon" }')
  const errors = page.getByTestId('import-errors')
  await expect(errors).toContainText('This plan is version 2; this app understands version 1.')
  await expect(errors).toContainText('"hooks" needs at least one hook.')
  await expect(errors).toContainText('"scenes" must be an array (got "soon").')
  await expect(page.getByTestId('scene')).toHaveCount(0)

  await importPlan(page, 'not json at all')
  await expect(errors).toContainText('Not valid JSON:')

  // A fenced reply, as Claude often pastes it, imports fine.
  await importPlan(page, 'Here is the plan:\n```json\n' + JSON.stringify(VALID_PLAN, null, 2) + '\n```')
  await expect(page.getByTestId('scene')).toHaveCount(3)
  await expect(page.getByTestId('hooks').getByRole('radio')).toHaveCount(3)
  await expect(page.getByTestId('plan-script')).toContainText('Before you build it, try to kill it.')
  await expect(page.getByTestId('claims')).toContainText('Verify before publishing.')
  await expect(page.getByTestId('claims')).toContainText('Confirm the studio has run this process')
  await expect(page.getByRole('heading', { name: 'Content plan · v1' })).toBeVisible()
  await expect(page.getByTestId('activity')).toContainText('Plan v1 imported: 3 hooks, 3 scenes, 5s')

  // A bad paste afterwards leaves plan v1 exactly as it was.
  await page.getByLabel('Narration for scene 2').fill('We look for the reason it will not work, together.')
  await page.getByLabel('Narration for scene 2').blur()
  await expect(page.getByRole('heading', { name: 'Content plan · v2' })).toBeVisible()
  await importPlan(page, '{"format":"qb-content-plan","version":1,"hooks":["x"],"script":"s","scenes":[{"narration":"n","visual":"v","seconds":0}]}')
  await expect(errors).toContainText('Not imported. Plan v2 is unchanged.')
  await expect(errors).toContainText('scenes[0].seconds must be a number between 0.5 and 300 (got 0).')
  await expect(page.getByTestId('scene')).toHaveCount(3)
  await expect(page.getByLabel('Narration for scene 2')).toHaveValue('We look for the reason it will not work, together.')

  // The plan survives a reload.
  await page.reload()
  await expect(page.getByTestId('scene')).toHaveCount(3)
  await expect(page.getByLabel('Narration for scene 2')).toHaveValue('We look for the reason it will not work, together.')
  await expect(page.getByRole('heading', { name: 'Content plan · v2' })).toBeVisible()
})

test('plan → assets + voiceover → render → review → approve, and edits make the render stale', async ({ page }, info) => {
  await importPlan(page, JSON.stringify(VALID_PLAN))
  await expect(page.getByTestId('scene')).toHaveCount(3)
  const create = page.getByTestId('create-from-plan')
  await expect(create).toBeDisabled()
  await expect(page.getByTestId('plan-blockers')).toContainText('No voiceover chosen: the preview will be rendered silent')
  await expect(page.getByTestId('plan-blockers')).toContainText('Assign an asset to every asset scene')

  await page.getByTestId('plan-voice-input').setInputFiles(VOICE)
  await expect(page.getByTestId('plan-voice-info')).toContainText('4s')
  await expect(page.getByTestId('plan-timeline')).toContainText('Timeline 5s · voiceover 4s · the last 1s will be silent')
  await page.getByTestId('scale-to-voice').click()
  await expect(page.getByTestId('plan-timeline')).toContainText('Timeline 4s · voiceover 4s')
  await expect(page.getByTestId('activity')).toContainText('Plan v2: scene durations scaled to the voiceover (4s)')
  await expect(page.getByLabel('Seconds for scene 1')).toHaveValue('1.6')

  await page.getByTestId('plan-asset-input').setInputFiles([ORANGE, CREAM])
  await expect(page.getByTestId('library').locator('li')).toHaveCount(2)
  await page.getByLabel('Asset for scene 1').selectOption({ label: '1. frame-orange.png' })
  await page.getByLabel('Asset for scene 2').selectOption({ label: '2. frame-cream-portrait.png' })
  await expect(page.getByTestId('plan-blockers')).toContainText('Assign an asset to scene 3, or switch it to a motion graphic.')
  await page.getByLabel('Asset for scene 3').selectOption({ label: '1. frame-orange.png' })
  await expect(create).toBeEnabled()
  await expect(create).toHaveText('Create preview from plan v2')

  await create.click()
  await expect(page.getByTestId('plan-render-status-message')).toContainText('Preview ready: 720×1280, 4s', { timeout: 60_000 })
  await expect(page.getByTestId('player')).toBeVisible()
  await expect(page.getByTestId('video-version')).toContainText('Video v1')
  await expect(page.getByText('rendered locally from plan v2')).toBeVisible()
  await expect(page.getByTestId('activity')).toContainText('Video v1 rendered locally (from plan v2: 3 scenes + voiceover, 4s)')
  await expect(status(page)).toHaveText('Draft')
  await expect(page.getByTestId('stale-render')).toHaveCount(0)

  await watchToEnd(page)
  await approveBtn(page).click()
  await expect(status(page)).toHaveText('Approved')
  await expect(page.getByTestId('approval-summary')).toContainText('brief v1 + plan v2 + video v1')
  await page.screenshot({ path: `test-results/screens/plan-${info.project.name}.png`, fullPage: true })

  // Editing a scene withdraws approval and marks the render out of date.
  await page.getByLabel('Visual for scene 1').fill('Owner at the desk, looking up, then to camera.')
  await expect(status(page)).toHaveText('Draft')
  await page.getByLabel('Visual for scene 1').blur()
  await expect(page.getByRole('heading', { name: 'Content plan · v3' })).toBeVisible()
  await expect(page.getByTestId('stale-render')).toContainText('rendered from plan v2; the plan is now v3')
  await expect(approveBtn(page)).toBeDisabled()
  await expect(page.getByTestId('blockers')).toContainText('Create the preview again.')
  await expect(page.getByTestId('download')).toBeDisabled()

  // Re-rendering from the current plan clears it; a changed assignment makes it stale again.
  await create.click()
  await expect(page.getByTestId('plan-render-status-message')).toContainText('Preview ready', { timeout: 60_000 })
  await expect(page.getByTestId('video-version')).toContainText('Video v2')
  await expect(page.getByTestId('stale-render')).toHaveCount(0)
  await watchToEnd(page)
  await approveBtn(page).click()
  await expect(page.getByTestId('approval-summary')).toContainText('brief v1 + plan v3 + video v2')

  await page.getByLabel('Asset for scene 3').selectOption({ label: '2. frame-cream-portrait.png' })
  await expect(page.getByTestId('stale-render')).toContainText('assets or voiceover assigned to the scenes changed')
  await expect(approveBtn(page)).toBeDisabled()
})
