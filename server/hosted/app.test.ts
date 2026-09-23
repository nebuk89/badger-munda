import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import type { StationState } from '../../shared/types.ts'
import { createHostedApp } from './app.ts'
import type { HostedCatalog } from './catalog.ts'
import { sha256 } from './crypto.ts'
import { hashPassword } from './password.ts'
import type { HostedStore } from './store.ts'

const origin = 'https://underhive.example'
const badgeId = '11111111-1111-4111-8111-111111111111'
const badgeSecret = 'badge-secret-123456789012345678901234'
const csrf = 'csrf-token-for-hosted-tests'
const sessionToken = 'session-token-for-hosted-tests'
const catalogHash = 'a'.repeat(64)
const catalog: HostedCatalog = {
  version: 1,
  catalogHash,
  clips: [{
    id: 'ration-works',
    title: 'Ration Works',
    subtitle: 'Test signal',
    category: 'advert',
    duration: 8,
    fps: 8,
    frameCount: 64,
    width: 160,
    height: 120,
    accent: '#d9b440',
    posterUrl: 'clips/ration-works/poster.png',
    videoUrl: 'clips/ration-works/video.mp4',
    frameIds: Array.from({ length: 64 }, (_, index) => index + 1),
    framePaths: Array.from(
      { length: 64 },
      (_, index) => `clips/ration-works/frames/${String(index).padStart(4, '0')}.ubf`,
    ),
    frameHashes: Array.from({ length: 64 }, () => 'b'.repeat(64)),
    posterPath: 'clips/ration-works/poster.png',
    posterHash: 'c'.repeat(64),
    videoPath: 'clips/ration-works/video.mp4',
    videoHash: 'd'.repeat(64),
  }],
}

function stationState(revision = 1): StationState {
  return {
    library: [{
      id: 'ration-works',
      title: 'Ration Works',
      subtitle: 'Test signal',
      category: 'advert',
      duration: 8,
      fps: 8,
      frameCount: 64,
      width: 160,
      height: 120,
      accent: '#d9b440',
      posterUrl: '',
      videoUrl: '',
    }],
    broadcast: {
      revision,
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
  failState = false
  claimed = false
  claimConsumed = false
  badgeRevoked = false
  commandCalls: Array<{ requestId: string; revision: number }> = []
  revoked: string[] = []
  revokeAllCount = 0
  auditEvents: string[] = []
  auditDetails: Array<{ eventType: string; detail: Record<string, unknown>; badgeId?: string }> = []
  deviceLimitAllowed = true
  syncReports: unknown[] = []

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

  async audit(eventType: string, detail: Record<string, unknown>, _sessionId?: string, auditedBadgeId?: string) {
    this.auditEvents.push(eventType)
    this.auditDetails.push({ eventType, detail, badgeId: auditedBadgeId })
  }

  async createSession() {
    return { id: 'session-1', token: sessionToken, csrf, expiresAt: Date.now() + 60_000 }
  }

  async revokeSession(id: string) {
    this.revoked.push(id)
  }

  async revokeAllSessions() {
    this.revokeAllCount++
  }

  async stationState() {
    if (this.failState) throw new Error('database-password-must-not-leak')
    return stationState(this.revision)
  }

  async command(_command: unknown, requestId: string, revision: number) {
    this.commandCalls.push({ requestId, revision })
    if (revision !== this.revision) {
      const error = new Error('The station changed before this command arrived.') as Error & { status: number }
      error.status = 409
      throw error
    }
    this.revision++
    return { revision: this.revision }
  }

  async badges() {
    return [{
      id: badgeId,
      label: 'Test badge',
      claimed: this.claimed,
      revoked: this.badgeRevoked,
      claimedAt: this.claimed ? Date.now() : null,
      revokedAt: this.badgeRevoked ? Date.now() : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]
  }

  async createBadge(_label: string) {
    return { badgeId, badgeSecret }
  }

  async claimBadge(code: string) {
    if (code !== '123456' || this.claimConsumed || this.badgeRevoked) return undefined
    this.claimed = true
    this.claimConsumed = true
    return badgeId
  }

  async revokeBadge(id: string) {
    if (id !== badgeId) return false
    this.badgeRevoked = true
    return true
  }

  async rotateBadge(id: string) {
    if (id !== badgeId || this.badgeRevoked) return undefined
    return { badgeId, badgeSecret: `${badgeSecret}-rotated` }
  }

  async authenticateBadge(id: string, secret: string) {
    if (id !== badgeId || secret !== badgeSecret || this.badgeRevoked) return undefined
    return { id: badgeId, claimedAt: this.claimed ? Date.now() : null }
  }

  async consumeDeviceSyncLimit() {
    return this.deviceLimitAllowed
      ? { allowed: true }
      : { allowed: false, retryAfter: 30 }
  }

  async recordDeviceSync(_id: string, report: unknown) {
    this.syncReports.push(report)
  }

  async issueBadgeClaimCode() {
    return { code: '123456', expiresAt: Date.now() + 10 * 60_000 }
  }

  async station() {
    return {
      revision: this.revision,
      commandSeq: 4,
      playbackGeneration: 3,
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
  process.env.IP_RATE_LIMIT_HMAC_KEY = 'rate-limit-key-for-tests'
  process.env.CLAIM_CODE_HMAC_KEY = 'claim-key-for-tests'
  process.env.DEVICE_SECRET_HMAC_KEY = 'device-key-for-tests'
  process.env.CONTENT_CATALOG_URL = `https://blob.example/content/v1/${catalogHash}/catalog.json`
  process.env.CONTENT_BLOB_BASE_URL = 'https://blob.example/'

  const app = await createHostedApp({
    catalog,
    store: store as unknown as HostedStore,
    ready: async () => {},
  })
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
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /ub_session=/)
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /Secure/i)
  assert.match(setCookie, /SameSite=Lax/i)
  assert.equal(body.csrfToken, csrf)
  return { cookie: setCookie.split(';')[0], csrfToken: body.csrfToken }
}

test('hosted login uses exact origins and secure sessions', async () => {
  const anonymous = await (await fetch(`${baseUrl}/api/setup`)).json()
  assert.deepEqual(anonymous, { paired: false, name: 'Underhive Broadcast', authMode: 'password' })

  const rejected = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  })
  assert.equal(rejected.status, 403)

  const session = await login()
  const setupResponse = await fetch(`${baseUrl}/api/setup`, { headers: { Cookie: session.cookie } })
  const setup = await setupResponse.json() as { paired: boolean; csrfToken: string }
  assert.equal(setup.paired, true)
  assert.equal(setup.csrfToken, csrf)
  assert.ok(store.auditEvents.includes('controller.login'))
})

test('hosted health endpoints and errors expose only safe responses', async () => {
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health/live`)).json(), { ok: true })
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health/ready`)).json(), { ok: true })

  const invalid = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: '' }),
  })
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: 'The request is invalid.' })

  const session = await login()
  store.failState = true
  const failed = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: session.cookie } })
  store.failState = false
  assert.equal(failed.status, 500)
  assert.deepEqual(await failed.json(), { error: 'The hosted station could not complete this request.' })
})

test('hosted commands need CSRF, If-Match, and Idempotency-Key headers', async () => {
  const session = await login()
  const baseHeaders = {
    'Content-Type': 'application/json',
    Cookie: session.cookie,
    Origin: origin,
  }
  const noCsrf = await fetch(`${baseUrl}/api/command`, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'If-Match': '"station-revision-1"',
      'Idempotency-Key': 'request-without-csrf',
    },
    body: JSON.stringify({ action: 'toggle-pause' }),
  })
  assert.equal(noCsrf.status, 403)

  const noRevision = await fetch(`${baseUrl}/api/command`, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'X-CSRF-Token': session.csrfToken,
      'Idempotency-Key': 'request-without-revision',
    },
    body: JSON.stringify({ action: 'toggle-pause' }),
  })
  assert.equal(noRevision.status, 428)

  const accepted = await fetch(`${baseUrl}/api/command`, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'X-CSRF-Token': session.csrfToken,
      'If-Match': '"station-revision-1"',
      'Idempotency-Key': 'request-with-all-headers',
    },
    body: JSON.stringify({ action: 'toggle-pause' }),
  })
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json() as StationState).broadcast.revision, 2)
  assert.deepEqual(store.commandCalls.at(-1), { requestId: 'request-with-all-headers', revision: 1 })
})

test('hosted logout and revoke-all clear administrator sessions', async () => {
  const session = await login()
  const headers = { Cookie: session.cookie, Origin: origin, 'X-CSRF-Token': session.csrfToken }
  const logout = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers })
  assert.equal(logout.status, 200)
  assert.deepEqual(store.revoked, ['session-1'])

  const revoke = await fetch(`${baseUrl}/api/session/revoke-all`, { method: 'POST', headers })
  assert.equal(revoke.status, 204)
  assert.equal(store.revokeAllCount, 1)
})

test('badge administration creates, lists, claims, rotates, and revokes credentials', async () => {
  store.claimed = false
  store.claimConsumed = false
  store.badgeRevoked = false
  const session = await login()
  const headers = {
    'Content-Type': 'application/json',
    Cookie: session.cookie,
    Origin: origin,
    'X-CSRF-Token': session.csrfToken,
  }

  const created = await fetch(`${baseUrl}/api/badges`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ label: 'Test badge' }),
  })
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { badgeId, badgeSecret, serviceUrl: origin })

  const listed = await fetch(`${baseUrl}/api/badges`, { headers: { Cookie: session.cookie } })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json() as { badges: unknown[] }).badges.length, 1)

  const invalidClaim = await fetch(`${baseUrl}/api/badges/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: '654321' }),
  })
  assert.equal(invalidClaim.status, 409)

  const claimed = await fetch(`${baseUrl}/api/badges/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: '123456' }),
  })
  assert.equal(claimed.status, 201)
  assert.deepEqual(await claimed.json(), { badgeId })

  const reusedClaim = await fetch(`${baseUrl}/api/badges/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: '123456' }),
  })
  assert.equal(reusedClaim.status, 409)

  const rotated = await fetch(`${baseUrl}/api/badges/${badgeId}/rotate-secret`, {
    method: 'POST',
    headers,
  })
  assert.equal(rotated.status, 200)
  assert.deepEqual(await rotated.json(), {
    badgeId,
    badgeSecret: `${badgeSecret}-rotated`,
    serviceUrl: origin,
  })

  const revoked = await fetch(`${baseUrl}/api/badges/${badgeId}/revoke`, {
    method: 'POST',
    headers,
  })
  assert.equal(revoked.status, 204)

  const rotateRevoked = await fetch(`${baseUrl}/api/badges/${badgeId}/rotate-secret`, {
    method: 'POST',
    headers,
  })
  assert.equal(rotateRevoked.status, 404)
  assert.deepEqual(store.auditEvents.slice(-4), [
    'badge.created',
    'badge.claimed',
    'badge.secret_rotated',
    'badge.revoked',
  ])
  assert.equal(JSON.stringify(store.auditDetails).includes(badgeSecret), false)
  assert.equal(JSON.stringify(store.auditDetails).includes('123456'), false)
})

test('device sync authenticates, issues claims, records receipts, and returns direct Blob playback', async () => {
  store.claimed = false
  store.badgeRevoked = false
  store.deviceLimitAllowed = true
  store.syncReports = []
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Badge ${badgeId}.${badgeSecret}`,
  }
  const report = {
    protocol: 2,
    bootId: 'boot-id-1234',
    firmwareVersion: '2.0.0',
    knownStationRevision: 1,
    fps: 7.5,
    errorCode: 'frame_late',
    lastReceipt: {
      stationRevision: 1,
      commandSeq: 2,
      playbackGeneration: 3,
      frameId: 4,
    },
  }
  const unclaimed = await fetch(`${baseUrl}/api/device/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify(report),
  })
  assert.equal(unclaimed.status, 200)
  const claim = await unclaimed.json() as {
    mode: string
    claimCode: string
    claimExpiresAtMs: number
  }
  assert.equal(claim.mode, 'claim')
  assert.equal(claim.claimCode, '123456')
  assert.ok(claim.claimExpiresAtMs > Date.now())
  assert.deepEqual(store.syncReports.at(-1), report)
  assert.equal(JSON.stringify(claim).includes(badgeSecret), false)

  store.claimed = true
  const claimed = await fetch(`${baseUrl}/api/device/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify(report),
  })
  assert.equal(claimed.status, 200)
  const playback = await claimed.json() as {
    mode: string
    stationRevision: number
    commandSeq: number
    playbackGeneration: number
    contentVersion: string
    clip: { frameUrlTemplate: string; fps: number; frameCount: number }
  }
  assert.equal(playback.mode, 'play')
  assert.equal(playback.stationRevision, store.revision)
  assert.equal(playback.commandSeq, 4)
  assert.equal(playback.playbackGeneration, 3)
  assert.equal(playback.contentVersion, catalogHash)
  assert.equal(playback.clip.fps, 8)
  assert.equal(playback.clip.frameCount, 64)
  assert.equal(
    playback.clip.frameUrlTemplate,
    `https://blob.example/content/v1/${catalogHash}/clips/ration-works/frames/{frame}.ubf`,
  )
})

test('device sync rejects invalid, revoked, and rate-limited credentials', async () => {
  const report = JSON.stringify({
    protocol: 2,
    bootId: 'boot-id-1234',
    firmwareVersion: '2.0.0',
  })
  const invalid = await fetch(`${baseUrl}/api/device/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Badge invalid' },
    body: report,
  })
  assert.equal(invalid.status, 401)

  store.badgeRevoked = true
  const revoked = await fetch(`${baseUrl}/api/device/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Badge ${badgeId}.${badgeSecret}`,
    },
    body: report,
  })
  assert.equal(revoked.status, 401)

  store.badgeRevoked = false
  store.deviceLimitAllowed = false
  const limited = await fetch(`${baseUrl}/api/device/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Badge ${badgeId}.${badgeSecret}`,
    },
    body: report,
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '30')
  store.deviceLimitAllowed = true
})
