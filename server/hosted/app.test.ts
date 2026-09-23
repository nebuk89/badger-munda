import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import type { StationState } from '../../shared/types.ts'
import { createHostedApp } from './app.ts'
import { sha256 } from './crypto.ts'
import { hashPassword } from './password.ts'
import type { HostedStore } from './store.ts'

const origin = 'https://underhive.example'
const csrf = 'csrf-token-for-hosted-tests'
const sessionToken = 'session-token-for-hosted-tests'

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
  commandCalls: Array<{ requestId: string; revision: number }> = []
  revoked: string[] = []
  revokeAllCount = 0
  auditEvents: string[] = []

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

  async audit(eventType: string) {
    this.auditEvents.push(eventType)
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
}

const store = new FakeStore()
let baseUrl = ''
let closeServer: (() => Promise<void>) | undefined

before(async () => {
  process.env.APP_ORIGIN = origin
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('correct horse battery staple')
  process.env.SESSION_TOKEN_PEPPER = 'session-pepper-for-tests'
  process.env.IP_RATE_LIMIT_HMAC_KEY = 'rate-limit-key-for-tests'

  const app = createHostedApp({
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
