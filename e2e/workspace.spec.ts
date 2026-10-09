import { expect, test, type Page } from '@playwright/test'

const VIDEO_A = 'test-results/fixtures/reel-a.webm'
const VIDEO_B = 'test-results/fixtures/reel-b.webm'

const status = (page: Page) => page.getByTestId('status')
const approveBtn = (page: Page) => page.getByRole('button', { name: 'Approve' })
const activity = (page: Page) => page.getByTestId('activity')

async function attach(page: Page, file: string) {
  await page.getByTestId('video-input').setInputFiles(file)
  await expect(page.getByTestId('player')).toBeVisible()
}

/** Play the preview through to the end, the same as a reviewer would. */
async function watchToEnd(page: Page) {
  await page.getByTestId('player').evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    await v.play()
  })
  await expect(page.getByTestId('watched')).toHaveText('Watched to the end', { timeout: 10_000 })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('starts in Draft, labelled as a local prototype', async ({ page }) => {
  await expect(status(page)).toHaveText('Draft')
  await expect(page.getByText('Single-user local prototype')).toBeVisible()
  await expect(page.getByText(/Videos are never uploaded or stored/)).toBeVisible()
  await expect(approveBtn(page)).toBeDisabled()
  await expect(page.getByTestId('blockers')).toHaveText('Attach the reel video.')
})

test('requesting changes needs a revision note', async ({ page }) => {
  await page.getByRole('button', { name: 'Request changes' }).click()
  await expect(page.getByRole('alert')).toHaveText('Write a revision note before requesting changes.')
  await expect(status(page)).toHaveText('Draft')

  await page.getByLabel('Revision note').fill('Open on the line, not the logo.')
  await page.getByRole('button', { name: 'Request changes' }).click()
  await expect(status(page)).toHaveText('Changes requested')
  await expect(activity(page)).toContainText('Open on the line, not the logo.')
  await expect(page.getByLabel('Revision note')).toHaveValue('')
})

test('approval needs a watched video and is withdrawn by brief edits and video replacement', async ({ page }) => {
  await page.getByLabel('Hook').fill('First hook')
  await attach(page, VIDEO_A)
  await expect(approveBtn(page)).toBeDisabled()
  await expect(page.getByTestId('blockers')).toHaveText('Watch the preview through to the end.')

  await watchToEnd(page)
  await approveBtn(page).click()
  await expect(status(page)).toHaveText('Approved')
  await expect(page.getByTestId('approval-summary')).toContainText('brief v2 + video v1')

  // Editing the brief withdraws approval.
  await page.getByLabel('Hook').fill('Second hook')
  await expect(status(page)).toHaveText('Draft')
  await expect(activity(page)).toContainText('Approval withdrawn: brief edited')

  // Re-approve the new brief version with the same video.
  await approveBtn(page).click()
  await expect(status(page)).toHaveText('Approved')
  await expect(page.getByTestId('approval-summary')).toContainText('brief v3 + video v1')

  // Replacing the video withdraws approval and needs a fresh watch.
  await attach(page, VIDEO_B)
  await expect(status(page)).toHaveText('Draft')
  await expect(activity(page)).toContainText('Video replaced: v1 → v2')
  await expect(activity(page)).toContainText('Approval withdrawn: video replaced')
  await expect(approveBtn(page)).toBeDisabled()
  await watchToEnd(page)
  await approveBtn(page).click()
  await expect(page.getByTestId('approval-summary')).toContainText('brief v3 + video v2')
})

test('after a reload the brief, notes and activity persist but the video must be reattached and rewatched', async ({ page }) => {
  await page.getByLabel('Title').fill('Persisted title')
  await page.getByLabel('Script').fill('Line one\nLine two')
  await attach(page, VIDEO_A)
  await page.getByLabel('Revision note').fill('Trim the pause at 0:04')
  await page.getByRole('button', { name: 'Request changes' }).click()
  await page.getByLabel('Revision note').fill('Unsent draft note')

  await page.reload()

  await expect(page.getByLabel('Title')).toHaveValue('Persisted title')
  await expect(page.getByLabel('Script')).toHaveValue('Line one\nLine two')
  await expect(page.getByLabel('Revision note')).toHaveValue('Unsent draft note')
  await expect(status(page)).toHaveText('Changes requested')
  await expect(activity(page)).toContainText('Trim the pause at 0:04')
  await expect(page.getByTestId('player')).toHaveCount(0)
  await expect(page.getByTestId('reattach-notice')).toContainText('reel-a.webm')
  await expect(approveBtn(page)).toBeDisabled()
  await expect(page.getByTestId('blockers')).toHaveText('Reattach the video. Files are not kept between sessions.')

  await attach(page, VIDEO_A)
  await expect(activity(page)).toContainText('Video v1 attached again for review')
  await expect(approveBtn(page)).toBeDisabled()
  await watchToEnd(page)
  await approveBtn(page).click()
  await expect(status(page)).toHaveText('Approved')

  // An approved workspace must be explicitly reviewed and approved again after reload.
  await page.reload()
  await expect(status(page)).toHaveText('Draft')
  await expect(page.getByTestId('reattach-notice')).toBeVisible()
  await expect(activity(page)).toContainText('Approved brief')
  await attach(page, VIDEO_A)
  await expect(approveBtn(page)).toBeDisabled()
  await watchToEnd(page)
  await expect(status(page)).toHaveText('Draft')
  await approveBtn(page).click()
  await expect(status(page)).toHaveText('Approved')
})

test('fictional sample brief is clearly labelled', async ({ page }) => {
  await page.getByRole('button', { name: 'Load fictional sample' }).click()
  await expect(page.getByTestId('sample-flag')).toHaveText('Fictional sample brief. Not a real client, campaign or result.')
  await expect(page.getByLabel('Title')).toHaveValue(/^Fictional sample:/)
})

test('fits the viewport without horizontal scrolling', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Load fictional sample' }).click()
  await attach(page, VIDEO_A)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `test-results/screens/${info.project.name}.png`, fullPage: true })
})

test('SHA-256 unavailable permits preview and notes but blocks approval', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true }))
  await attach(page, VIDEO_A)
  await watchToEnd(page)
  await expect(approveBtn(page)).toBeDisabled()
  await expect(page.getByTestId('blockers')).toContainText('HTTPS or localhost')
  await page.getByLabel('Revision note').fill('Keep this note')
  await page.getByRole('button', { name: 'Request changes' }).click()
  await expect(activity(page)).toContainText('Keep this note')
})

test('file read failures show a recoverable error', async ({ page }) => {
  await page.evaluate(() => {
    File.prototype.arrayBuffer = async () => { throw new Error('Read failed') }
  })
  await page.getByTestId('video-input').setInputFiles(VIDEO_A)
  await expect(page.getByRole('alert')).toContainText('Could not read or verify')
  await expect(page.getByRole('button', { name: 'Choose video', exact: true })).toBeEnabled()
  await expect(approveBtn(page)).toBeDisabled()
})

test('pending replacement blocks approval and cannot repopulate a cleared workspace', async ({ page }) => {
  await attach(page, VIDEO_A)
  await watchToEnd(page)
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = function () {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        Object.assign(window, { finishFileRead: () => original.call(this).then(resolve, reject) })
      })
    }
  })
  await page.getByTestId('video-input').setInputFiles(VIDEO_B)
  await expect(page.getByRole('button', { name: 'Checking file…' })).toBeVisible()
  await expect(approveBtn(page)).toBeDisabled()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Clear local data' }).click()
  await page.evaluate(async () => {
    await (window as unknown as { finishFileRead: () => Promise<void> }).finishFileRead()
  })
  await expect(page.getByTestId('player')).toHaveCount(0)
  await expect(activity(page)).not.toContainText('reel-b')
  await expect(status(page)).toHaveText('Draft')
})
