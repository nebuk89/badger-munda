import { expect, test } from '@playwright/test'
import type { StationState } from '../shared/types'

test('phone preview stays separate while playback, queue, and round controls work', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByLabel('Station pairing code').fill('314159')
  await page.getByRole('button', { name: 'Unlock station' }).click()
  await expect(page.getByRole('heading', { name: /CONTROL THE SIGNAL/ })).toBeVisible()
  const send = async (command: Record<string, unknown>) => {
    const response = await page.request.post('/api/command', { data: { ...command, requestId: crypto.randomUUID() } })
    expect(response.ok()).toBeTruthy()
  }
  const state = async (): Promise<StationState> => (await page.request.get('/api/state')).json()
  const library = (await state()).library
  await send({ action: 'play', clipId: 'ration-works' })
  await send({ action: 'toggle-pause' })
  await expect(page.getByRole('button', { name: 'Resume broadcast' })).toBeVisible()
  await expect(page.locator('.broadcast-screen img')).toHaveJSProperty('naturalWidth', 160)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({ path: info.outputPath('station.png'), fullPage: true })

  const before = await state()
  const other = library.find((clip) => clip.id === 'sump-tavern')!
  await page.getByRole('button', { name: `Preview ${other.title} on this phone` }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const video = dialog.locator('video')
  await expect(video).toHaveJSProperty('videoWidth', 640)
  await video.evaluate(async (element) => { element.muted = true; await element.play() })
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.1)
  expect((await state()).broadcast.revision).toBe(before.broadcast.revision)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause broadcast' })).toBeVisible()
  await page.getByRole('button', { name: 'Pause broadcast' }).click()
  await expect(page.getByRole('button', { name: 'Resume broadcast' })).toBeVisible()
  await page.getByRole('button', { name: `Add ${other.title} to queue` }).click()
  await expect.poll(async () => (await state()).broadcast.queue).toContain(other.id)
  await page.getByRole('button', { name: 'Clear queue' }).click()
  await expect.poll(async () => (await state()).broadcast.queue.length).toBe(0)
  await page.getByRole('button', { name: 'Next round', exact: true }).click()
  await expect.poll(async () => (await state()).broadcast.event?.title).toMatch(/^CYCLE /)
  await page.getByRole('button', { name: 'Clear event' }).click()
  await expect.poll(async () => (await state()).broadcast.event).toBeNull()
  expect(errors).toEqual([])
})
