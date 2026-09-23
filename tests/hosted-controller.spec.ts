import { expect, test } from '@playwright/test'
import type { StationState } from '../shared/types'

const poster = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const initialState: StationState = {
  library: [{
    id: 'ration-works',
    title: 'Ration Works',
    subtitle: 'A square meal, more or less.',
    category: 'advert',
    duration: 8,
    fps: 8,
    frameCount: 64,
    width: 160,
    height: 120,
    accent: '#e3ad30',
    posterUrl: poster,
    videoUrl: '',
  }],
  broadcast: {
    revision: 1,
    clipId: 'ration-works',
    paused: false,
    loop: true,
    startedAt: Date.now(),
    position: 0,
    round: 1,
    event: null,
    queue: [],
  },
  devices: [],
  server: {
    name: 'Underhive Broadcast',
    version: 'hosted-test',
    width: 160,
    height: 120,
    fps: 8,
    addresses: ['https://underhive.example'],
    now: Date.now(),
  },
}

test('hosted controller supports administrator login, station control, and session revocation', async ({ page }, info) => {
  let paired = false
  let revision = initialState.broadcast.revision
  let revokedAll = false
  const hostedState = () => ({
    ...initialState,
    broadcast: { ...initialState.broadcast, revision },
    server: { ...initialState.server, now: Date.now() },
  })

  await page.route('**/api/setup', (route) => route.fulfill({
    json: {
      paired,
      name: 'Underhive Broadcast',
      authMode: 'password',
      ...(paired ? { csrfToken: 'hosted-csrf-token', expiresAt: Date.now() + 60_000 } : {}),
    },
  }))
  await page.route('**/api/auth/login', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ password: 'private-password' })
    paired = true
    await route.fulfill({ json: { ok: true, csrfToken: 'hosted-csrf-token', expiresAt: Date.now() + 60_000 } })
  })
  await page.route('**/api/state', (route) => route.fulfill({ json: hostedState() }))
  await page.route('**/api/command', async (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe('hosted-csrf-token')
    expect(route.request().headers()['if-match']).toBe(`"station-revision-${revision}"`)
    expect(route.request().headers()['idempotency-key']).toBeTruthy()
    revision++
    await route.fulfill({ json: hostedState() })
  })
  await page.route('**/api/session/revoke-all', async (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe('hosted-csrf-token')
    revokedAll = true
    paired = false
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await expect(page.getByLabel('Controller password')).toBeVisible()
  await page.getByLabel('Controller password').fill('private-password')
  await page.getByRole('button', { name: 'Unlock station' }).click()
  await expect(page.getByRole('heading', { name: /CONTROL THE SIGNAL/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Import clip/ })).toHaveCount(0)
  await expect(page.getByText('Media delivery comes in a later layer.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Pause broadcast' }).click()
  await expect.poll(() => revision).toBe(2)

  await page.getByRole('button', { name: 'Session' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'CONTROL ACCESS.' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Revoke all sessions' }).click()
  await expect.poll(() => revokedAll).toBe(true)
  await expect(page.getByLabel('Controller password')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({ path: info.outputPath('hosted-controller.png'), fullPage: true })
})
