import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { StationState } from '../../shared/types.ts'
import { sha256 } from './crypto.ts'
import type { HostedCatalog } from './catalog.ts'
import { createHostedApp } from './app.ts'
import { hashPassword } from './password.ts'
import type { HostedStore } from './store.ts'

const origin = 'https://underhive.example'
const badgeId = '11111111-1111-4111-8111-111111111111'
const badgeSecret = 'badge-secret-1234567890123456'
const csrf = 'csrf-token-for-hosted-tests'
const sessionToken = 'session-token-for-hosted-tests'
const catalog: HostedCatalog = {
  version: 1,
  catalogHash: 'a'.repeat(64),
  clips: [{
    id: 'clip-1',
    title: 'Clip one',
    subtitle: 'Test signal',
    category: 'advert',
    duration: 10,
    fps: 8,
    frameCount: 80,
    width: 160,
    height: 120,
    accent: '#fff',
    frameIds: Array.from({ length: 80 }, (_, index) => index),
    framePaths: Array.from({ length: 80 }, (_, index) => `clips/clip-1/frames/${String(index).padStart(4, '0')}.ubf`),
    frameHashes: Array.from({ length: 80 }, () => 'b'.repeat(64)),
    posterPath: 'clips/clip-1/poster.png',
    posterHash: 'c'.repeat(64),
    videoPath: 'clips/clip-1/preview.mp4',
    videoHash: 'd'.repeat(64),
  }],
}

function stationState(revision = 1): StationState {
  return {
    library: [{
      id: 'clip-1',
      title: 'Clip one',
      subtitle: 'Test signal',
      category: 'advert',
      duration: 10,
      fps: 8,
      frameCount: 80,
      width: 160,
      height: 120,
      accent: '#fff',
      posterUrl: 'https://blob.example/clips/clip-1/poster.png',
      videoUrl: 'https://blob.example/clips/clip-1/preview.mp4',
    }],
    broadcast: {
      revision,
      clipId: 'clip-1',
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
      version: 'test',
      width: 160,
      height: 120,
      fps: 8,
      addresses: [origin],
      now: Date.now(),
    },
  }
}

class FakeStore {
  revision = 1
  claimed = false
  commandCalls: Array<{ requestId: string; revision: number }> = []

  async session(token?: string) {
    return token === sessionToken
      ? { id: 'session-1', csrfHash: sha256(csrf), expiresAt: Date.now() + 60_000 }
      : undefined
  }

  csrfForToken(token: string) {
    assert.equal(token, sessionToken)
    return csrf
  }

  async rateLimit() {
    return { allowed: true, subjectHash: 'subject' }
  }

  async recordRateLimitFailure() {}
  async clearRateLimit() {}
  async audit() {}

  async createSession() {
    return { token: sessionToken, csrf, expiresAt: Date.now() + 60_000 }
  }

  async revokeSession() {}
  async revokeAllSessions() {}

  async stationState() {
    return stationState(this.revision)
  }

  async command(_command: unknown, requestId: string, revision: number) {
    this.commandCalls.push({ requestId, revision })
    if (revision !== this.revision) {
      const error = new Error('The station changed before this command arrived.') as Error & { status: number }
      error.status = 409
      throw error
    }
    this.revision += 1
    return { revision: this.revision }
  }

  async badges() {
    return [{
      id: badgeId,
      label: 'Test badge',
      claimed: this.claimed,
      revoked: false,
      online: false,
      lastSeenAt: null,
      firmwareVersion: null,
      fps: 0,
      lastStationRevision: null,
      lastCommandSeq: null,
      lastPlaybackGeneration: null,
      lastAssetFrameId: null,
      lastErrorCode: null,
    }]
  }

  async createBadge(label: string) {
    return { badgeId, badgeSecret, label }
  }

  async claimBadge(code: string) {
    if (code !== '123456') return undefined
    this.claimed = true
    return badgeId
  }

  async revokeBadge() {}
  async rotateBadge() {
    return { badgeId, badgeSecret: `${badgeSecret}-rotated` }
  }

  async authenticateBadge(id: string, secret: string) {
    return id === badgeId && secret === badgeSecret ? { id: badgeId, claimed_at: this.claimed ? new Date() : null, revoked_at: null } : undefined
  }

  async recordBadgeStatus() {}

  async claimCode() {
    return { code: '123456', expiresAt: Date.now() + 60_000 }
  }

  async station() {
    return {
      revision: this.revision,
      commandSeq: this.revision,
      playbackGeneration: 1,
      broadcast: stationState(this.revision).broadcast,
    }
  }
}

const store = new FakeStore()
let baseUrl = ''
let closeServer: (() => Promise<void>) | undefined

before(async () => {
  process.env.APP_ORIGIN = origin
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('correct horse battery staple')
  process.env.SESSION_TOKEN_PEPPER = 'session-pepper-for-tests'
  process.env.CLAIM_CODE_HMAC_KEY = 'claim-key-for-tests'
  process.env.DEVICE_SECRET_HMAC_KEY = 'device-key-for-tests'
  process.env.IP_RATE_LIMIT_HMAC_KEY = 'rate-limit-key-for-tests'
  process.env.CONTENT_CATALOG_URL = 'https://blob.example/catalog.json'
  process.env.CONTENT_BLOB_BASE_URL = 'https://blob.example'

  const app = await createHostedApp({ catalog, store: store as unknown as HostedStore })
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
  closeServer = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
})

after(async () => {
  await closeServer?.()
})

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { csrfToken: string }
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  assert.equal(body.csrfToken, csrf)
  return { cookie, csrfToken: body.csrfToken }
}

test('hosted sessions expose CSRF and protect controller writes', async () => {
  const anonymous = await (await fetch(`${baseUrl}/api/setup`)).json() as { paired: boolean; authMode: string }
  assert.deepEqual(anonymous, { paired: false, name: 'Underhive Broadcast', authMode: 'password' })

  const session = await login()
  const setupResponse = await fetch(`${baseUrl}/api/setup`, { headers: { Cookie: session.cookie } })
  const setup = await setupResponse.json() as { paired: boolean; csrfToken: string }
  assert.equal(setup.paired, true)
  assert.equal(setup.csrfToken, csrf)

  const rejected = await fetch(`${baseUrl}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      Origin: origin,
      'If-Match': '"station-revision-1"',
      'Idempotency-Key': 'request-without-csrf',
    },
    body: JSON.stringify({ action: 'toggle-pause' }),
  })
  assert.equal(rejected.status, 403)

  const accepted = await fetch(`${baseUrl}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      Origin: origin,
      'X-CSRF-Token': session.csrfToken,
      'If-Match': '"station-revision-1"',
      'Idempotency-Key': 'request-with-csrf',
    },
    body: JSON.stringify({ action: 'toggle-pause' }),
  })
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json() as StationState).broadcast.revision, 2)
  assert.deepEqual(store.commandCalls.at(-1), { requestId: 'request-with-csrf', revision: 1 })

  const stale = await fetch(`${baseUrl}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      Origin: origin,
      'X-CSRF-Token': session.csrfToken,
      'If-Match': '"station-revision-1"',
      'Idempotency-Key': 'stale-command',
    },
    body: JSON.stringify({ action: 'toggle-pause' }),
  })
  assert.equal(stale.status, 409)
})

test('badge registration, claims, and device sync use the hosted contract', async () => {
  const session = await login()
  const controllerHeaders = {
    'Content-Type': 'application/json',
    Cookie: session.cookie,
    Origin: origin,
    'X-CSRF-Token': session.csrfToken,
  }
  const created = await fetch(`${baseUrl}/api/badges`, {
    method: 'POST',
    headers: controllerHeaders,
    body: JSON.stringify({ label: 'Test badge' }),
  })
  assert.equal(created.status, 201)
  assert.equal((await created.json() as { badgeSecret: string }).badgeSecret, badgeSecret)

  const unclaimedSync = await fetch(`${baseUrl}/api/device/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Badge ${badgeId}.${badgeSecret}`,
      Origin: origin,
    },
    body: JSON.stringify({ protocol: 2, bootId: 'boot-id-1234', firmwareVersion: 'test' }),
  })
  assert.equal(unclaimedSync.status, 200)
  assert.equal((await unclaimedSync.json() as { mode: string }).mode, 'claim')

  const invalidClaim = await fetch(`${baseUrl}/api/badges/claim`, {
    method: 'POST',
    headers: controllerHeaders,
    body: JSON.stringify({ code: '654321' }),
  })
  assert.equal(invalidClaim.status, 409)

  const claim = await fetch(`${baseUrl}/api/badges/claim`, {
    method: 'POST',
    headers: controllerHeaders,
    body: JSON.stringify({ code: '123456' }),
  })
  assert.equal(claim.status, 201)

  const claimedSync = await fetch(`${baseUrl}/api/device/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Badge ${badgeId}.${badgeSecret}`,
      Origin: origin,
    },
    body: JSON.stringify({ protocol: 2, bootId: 'boot-id-1234', firmwareVersion: 'test' }),
  })
  assert.equal(claimedSync.status, 200)
  const sync = await claimedSync.json() as { mode: string; clip: { frameUrlTemplate: string } }
  assert.equal(sync.mode, 'play')
  assert.equal(sync.clip.frameUrlTemplate, 'https://blob.example/clips/clip-1/frames/{frame}.ubf')
})
