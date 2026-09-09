import { expect, test } from '@playwright/test'
import { gameEvents } from '../shared/game-events'
import type { Command, StationState } from '../shared/types'

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
  expect(library.map((clip) => clip.id)).toEqual(expect.arrayContaining([
    'ration-works', 'curfew-signal', 'sump-tavern',
    'clean-air', 'second-hands', 'shaft-nine', 'guild-credit', 'salvage-union',
    'ash-waste-tours', 'missing-servitor', 'power-coop', 'sump-shuffle', 'hab-block-thirteen',
  ]))
  await send({ action: 'play', clipId: 'ration-works' })
  await send({ action: 'toggle-pause' })
  await expect(page.getByRole('button', { name: 'Resume broadcast' })).toBeVisible()
  await expect(page.locator('.broadcast-screen img')).toHaveJSProperty('naturalWidth', 160)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({ path: info.outputPath('station.png'), fullPage: true })

  const before = await state()
  const other = library.find((clip) => clip.id === 'clean-air')!
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

test('game videos preview independently, dispatch once, and restore the held advert', async ({ page }, info) => {
  test.setTimeout(45_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByLabel('Station pairing code').fill('314159')
  await page.getByRole('button', { name: 'Unlock station' }).click()
  await expect(page.getByRole('heading', { name: /CONTROL THE SIGNAL/ })).toBeVisible()
  const state = async (): Promise<StationState> => (await page.request.get('/api/state')).json()
  const send = async (command: Command) => {
    const response = await page.request.post('/api/command', { data: { ...command, requestId: crypto.randomUUID() } })
    expect(response.ok()).toBeTruthy()
  }
  await send({ action: 'clear-event' })
  await send({ action: 'clear-queue' })
  await send({ action: 'play', clipId: 'ration-works' })
  await expect.poll(async () => (await state()).broadcast.position).toBeGreaterThan(0.5)
  await send({ action: 'toggle-pause' })
  await expect(page.getByRole('button', { name: 'Resume broadcast' })).toBeEnabled()

  const before = await state()
  const events = page.getByRole('region', { name: 'GAME EVENTS', exact: true })
  const shortcut = page.getByRole('link', { name: 'Game events', exact: true })
  await expect(shortcut).toBeVisible()
  await shortcut.click()
  await expect(events.getByRole('heading', { name: 'GAME EVENTS', exact: true })).toBeInViewport()
  for (const event of gameEvents) {
    const clip = before.library.find((entry) => entry.id === event.clipId)!
    expect(clip.category).toBe('event')
    expect(clip.duration).toBe(8)
    await expect(events.getByRole('heading', { name: event.title, exact: true })).toBeVisible()
    await expect(events.getByRole('button', { name: `Dispatch ${event.title}`, exact: true })).toBeEnabled()
    await expect(events.getByRole('img', { name: `${event.title} animated event poster` })).toBeVisible()
  }
  const gridColumns = await events.locator('.game-events-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(gridColumns).toBe(page.viewportSize()!.width < 950 ? 2 : 3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await events.screenshot({ path: info.outputPath('game-events.png') })

  await events.getByRole('button', { name: 'Preview Failed Jump video on this phone' }).click()
  const dialog = page.getByRole('dialog')
  const video = dialog.locator('video')
  await expect(video).toHaveJSProperty('videoWidth', 640)
  await expect(video).toHaveJSProperty('videoHeight', 480)
  await video.evaluate(async (element) => { element.muted = true; await element.play() })
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.1)
  expect((await state()).broadcast).toEqual(before.broadcast)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  const library = page.getByRole('region', { name: /CONTENT LIBRARY/ })
  await library.getByRole('button', { name: 'Events', exact: true }).click()
  await expect(library.locator('.clip-card')).toHaveCount(6)
  await expect(library.getByRole('button', { name: 'Dispatch once', exact: true })).toHaveCount(6)
  await expect(library.getByRole('button', { name: /Add .* to queue/ })).toHaveCount(0)
  await expect(library.getByRole('button', { name: 'Play on badge', exact: true })).toHaveCount(0)
  const rejectedQueue = await page.request.post('/api/command', {
    data: { action: 'queue', clipId: 'event-failed-jump', requestId: crypto.randomUUID() },
  })
  expect(rejectedQueue.ok()).toBeFalsy()
  expect((await state()).broadcast.queue).toEqual([])

  await events.getByRole('button', { name: 'Dispatch Failed Jump', exact: true }).click()
  await expect(events.getByRole('status')).toContainText('Failed Jump')
  await expect(events.getByRole('status')).toContainText(/[1-8]s left/)
  await expect(page.locator('.monitor-label')).toHaveText('ON AIR')
  await expect(page.locator('.current-clip-title')).toHaveText('Failed Jump')
  await expect(page.locator('.advert-resume-context')).toContainText('Returns paused')
  await expect(page.getByRole('button', { name: 'Event playing', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Previous clip', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Next clip', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeDisabled()
  await expect(page.locator('.event-panel .active-event')).toHaveCount(0)
  await events.screenshot({ path: info.outputPath('game-events-active.png') })
  const firstEvent = (await state()).broadcast.event!
  const heldContext = await page.locator('.advert-resume-context').textContent()
  await expect(events.getByRole('status')).toContainText(/[1-6]s left/)
  expect(await page.locator('.advert-resume-context').textContent()).toBe(heldContext)
  expect((await state()).broadcast.position).toBeCloseTo(before.broadcast.position, 2)

  await events.getByRole('button', { name: 'Dispatch Fatality', exact: true }).click()
  await expect(events.getByRole('status')).toContainText('Fatality')
  const replacement = (await state()).broadcast
  expect(replacement.event?.clipId).toBe('event-fatality')
  expect(replacement.event?.startedAt).toBeGreaterThan(firstEvent.startedAt!)
  expect(replacement.event!.expiresAt - replacement.event!.startedAt!).toBe(8000)
  expect(replacement.position).toBeCloseTo(before.broadcast.position, 2)
  await events.getByRole('button', { name: 'Cancel game event' }).click()
  await expect(events.locator('.game-event-active')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume broadcast' })).toBeEnabled()
  const cancelled = (await state()).broadcast
  expect(cancelled.clipId).toBe(before.broadcast.clipId)
  expect(cancelled.paused).toBe(true)
  expect(cancelled.position).toBeCloseTo(before.broadcast.position, 2)

  const diceClip = library.locator('.clip-card').filter({ has: page.getByRole('heading', { name: 'Dice Fail', exact: true }) })
  await diceClip.getByRole('button', { name: 'Dispatch once', exact: true }).click()
  await expect(events.getByRole('status')).toContainText('Dice Fail')
  await expect.poll(async () => (await state()).broadcast.event, { timeout: 12_000 }).toBeNull()
  await expect(page.getByRole('button', { name: 'Resume broadcast' })).toBeEnabled()
  const expired = (await state()).broadcast
  expect(expired.clipId).toBe(before.broadcast.clipId)
  expect(expired.paused).toBe(true)
  expect(expired.position).toBeCloseTo(before.broadcast.position, 2)
  await expect(page.locator('.monitor-label')).toHaveText('PAUSED')

  await page.getByRole('button', { name: 'Resume broadcast' }).click()
  await expect(page.getByRole('button', { name: 'Pause broadcast' })).toBeEnabled()
  await events.getByRole('button', { name: 'Dispatch Critical Hit', exact: true }).click()
  await expect(events.getByRole('status')).toContainText('Critical Hit')
  await expect(page.locator('.advert-resume-context')).toContainText('Resumes here')
  const playingHeld = (await state()).broadcast
  expect(playingHeld.paused).toBe(false)
  await expect(events.getByRole('status')).toContainText(/[1-6]s left/)
  expect((await state()).broadcast.position).toBeCloseTo(playingHeld.position, 2)
  await events.getByRole('button', { name: 'Cancel game event' }).click()
  await expect(page.getByRole('button', { name: 'Pause broadcast' })).toBeEnabled()
  await expect.poll(async () => (await state()).broadcast.position).toBeGreaterThan(playingHeld.position)
  expect((await state()).broadcast.clipId).toBe(before.broadcast.clipId)
  expect(errors).toEqual([])
})

test('missing game videos explain recovery and offline dispatch is disabled', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Station pairing code').fill('314159')
  await page.getByRole('button', { name: 'Unlock station' }).click()
  await expect(page.getByRole('heading', { name: /CONTROL THE SIGNAL/ })).toBeVisible()
  const state: StationState = await (await page.request.get('/api/state')).json()
  await page.route('**/api/state', (route) => route.fulfill({
    json: { ...state, library: state.library.filter((clip) => clip.id !== 'event-fatality') },
  }))
  await page.reload()
  const events = page.getByRole('region', { name: 'GAME EVENTS', exact: true })
  await expect(events.getByText(/Some event videos are unavailable/)).toContainText('npm run content')
  await expect(events.getByText(/Some event videos are unavailable/)).toContainText('restart the station')
  await expect(events.getByRole('button', { name: 'Dispatch Fatality', exact: true })).toBeDisabled()
  await expect(events.getByRole('button', { name: 'Preview Fatality video on this phone' })).toBeDisabled()
  await expect(events.getByRole('button', { name: 'Dispatch Failed Jump', exact: true })).toBeEnabled()
  await page.unroute('**/api/state')
  await page.route('**/api/state', (route) => route.fulfill({ status: 503, json: { error: 'Station unavailable' } }))
  await expect(page.getByText('Connection to the Mac lost.')).toBeVisible()
  for (const event of gameEvents) {
    await expect(events.getByRole('button', { name: `Dispatch ${event.title}`, exact: true })).toBeDisabled()
    await expect(events.getByRole('button', { name: `Preview ${event.title} video on this phone` })).toBeDisabled()
  }
})
