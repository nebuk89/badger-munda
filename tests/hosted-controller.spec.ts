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

test('hosted controller login, command headers, and badge management work without upload controls', async ({ page }, info) => {
  let paired = false
  let revision = initialState.broadcast.revision
  let badges = [{
    id: '11111111-1111-4111-8111-111111111111',
    label: 'South tunnel',
    claimed: false,
    revoked: false,
    online: false,
    lastSeenAt: null,
    firmwareVersion: null,
    fps: 0,
    lastErrorCode: null,
  }]
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
  await page.route('**/api/frame.png*', (route) => route.fulfill({
    contentType: 'image/gif',
    body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'),
  }))
  await page.route('**/api/command', async (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe('hosted-csrf-token')
    expect(route.request().headers()['if-match']).toBe(`"station-revision-${revision}"`)
    expect(route.request().headers()['idempotency-key']).toBeTruthy()
    revision += 1
    await route.fulfill({ json: hostedState() })
  })
  await page.route('**/api/badges', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { badges } })
      return
    }
    expect(route.request().headers()['x-csrf-token']).toBe('hosted-csrf-token')
    const body = route.request().postDataJSON() as { label: string }
    badges = [...badges, {
      id: '22222222-2222-4222-8222-222222222222',
      label: body.label,
      claimed: false,
      revoked: false,
      online: false,
      lastSeenAt: null,
      firmwareVersion: null,
      fps: 0,
      lastErrorCode: null,
    }]
    await route.fulfill({
      status: 201,
      json: {
        badgeId: '22222222-2222-4222-8222-222222222222',
        badgeSecret: 'one-time-device-secret',
        serviceUrl: 'https://underhive.example',
      },
    })
  })
  await page.route('**/api/badges/claim', async (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe('hosted-csrf-token')
    expect(route.request().postDataJSON()).toEqual({ code: '123456' })
    badges = badges.map((badge) => badge.id === badges[0].id ? { ...badge, claimed: true } : badge)
    await route.fulfill({ status: 201, json: { badgeId: badges[0].id } })
  })

  await page.goto('/')
  await expect(page.getByLabel('Controller password')).toBeVisible()
  await page.getByLabel('Controller password').fill('private-password')
  await page.getByRole('button', { name: 'Unlock station' }).click()
  await expect(page.getByRole('heading', { name: /CONTROL THE SIGNAL/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Import clip/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Pause broadcast' }).click()
  await expect.poll(() => revision).toBe(2)

  await page.getByRole('button', { name: 'Badges' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'BADGES ON THE SIGNAL.' })).toBeVisible()
  await dialog.getByLabel('New badge label').fill('North gate')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByText('Save this secret now.')).toBeVisible()
  await expect(dialog.getByLabel('Badge secret')).toHaveValue('one-time-device-secret')
  await dialog.getByRole('button', { name: 'I saved it' }).click()
  await dialog.getByLabel('Claim code from badge').fill('123456')
  await dialog.getByRole('button', { name: 'Claim' }).click()
  await expect(dialog.getByText('Claimed, offline')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({ path: info.outputPath('hosted-controller.png'), fullPage: true })
})
