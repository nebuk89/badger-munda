import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { commandSchema } from '../station.js'
import {
  frameUrlTemplate,
  loadHostedCatalog,
  type HostedCatalog,
} from './catalog.js'
import { equalText, sha256 } from './crypto.js'
import { hostedConfig } from './env.js'
import { verifyPassword } from './password.js'
import { HostedStore } from './store.js'
import { hostedPool } from './db/client.js'

interface HostedError extends Error {
  status?: number
  current?: unknown
}

const sessionTokens = new WeakMap<Request, string>()
const sessions = new WeakMap<Request, { id: string; csrfHash: string; expiresAt: number }>()

function cookie(req: Request, name: string) {
  return (req.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

function clientIp(req: Request) {
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim()
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) }
}

export function badgeAuthorization(value: string | undefined) {
  const match = /^Badge ([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{20,128})$/i.exec(value ?? '')
  return match ? { badgeId: match[1].toLowerCase(), badgeSecret: match[2] } : undefined
}

const receiptSchema = z.object({
  stationRevision: z.number().int().nonnegative(),
  commandSeq: z.number().int().nonnegative(),
  playbackGeneration: z.number().int().nonnegative(),
  frameId: z.number().int().positive(),
})

export const deviceSyncSchema = z.object({
  protocol: z.literal(2),
  bootId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  firmwareVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,79}$/),
  knownStationRevision: z.number().int().nonnegative().optional(),
  lastReceipt: receiptSchema.optional(),
  fps: z.number().min(0).max(120).optional(),
  errorCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/).nullable().optional(),
})

export async function createHostedApp(options: {
  catalog?: HostedCatalog
  store?: HostedStore
  ready?: () => Promise<void>
} = {}) {
  const config = hostedConfig()
  const catalog = options.catalog ?? await loadHostedCatalog(config)
  const store = options.store ?? new HostedStore(catalog)
  const app = express()

  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && req.path !== '/api/device/sync'
      && req.headers.origin !== config.appOrigin
    ) {
      res.status(403).json({ error: 'This origin cannot control the station.' })
      return
    }
    next()
  })
  app.use(express.json({ limit: '8kb' }))

  app.use(asyncRoute(async (req, _res, next) => {
    const token = cookie(req, 'ub_session')
    const session = await store.session(token)
    if (token && session) {
      sessionTokens.set(req, token)
      sessions.set(req, session)
    }
    next()
  }))

  const controller: RequestHandler = (req, res, next) => {
    if (!sessions.get(req)) {
      res.status(401).json({ error: 'Enter the private controller password.' })
      return
    }
    next()
  }
  const csrf: RequestHandler = (req, res, next) => {
    const session = sessions.get(req)
    const provided = req.get('X-CSRF-Token') ?? ''
    if (!session || !provided || !equalText(sha256(provided), session.csrfHash)) {
      res.status(403).json({ error: 'The controller security token is invalid. Refresh and try again.' })
      return
    }
    next()
  }
  const consumeLimit = async (
    res: express.Response,
    scope: string,
    subject: string,
    maximum: number,
    windowMs: number,
  ) => {
    const limit = await store.rateLimit(scope, subject, maximum, windowMs)
    if (!limit.allowed) {
      res.setHeader('Retry-After', limit.retryAfter ?? 1)
      res.status(429).json({ error: 'Too many requests. Try again later.' })
      return false
    }
    await store.recordRateLimitFailure(scope, limit.subjectHash, maximum, windowMs)
    return true
  }
  const controllerWriteLimit: RequestHandler = asyncRoute(async (req, res, next) => {
    const session = sessions.get(req)
    if (!session || !await consumeLimit(res, 'controller-write', session.id, 120, 60_000)) return
    next()
  })

  app.get('/api/setup', (req, res) => {
    const token = sessionTokens.get(req)
    const session = sessions.get(req)
    res.json({
      paired: Boolean(session),
      name: 'Underhive Broadcast',
      authMode: 'password',
      csrfToken: token && session ? store.csrfForToken(token) : undefined,
      expiresAt: session?.expiresAt,
    })
  })

  const login = asyncRoute(async (req, res) => {
    const body = z.object({ password: z.string().min(1).max(256) }).parse(req.body)
    const limit = await store.rateLimit('admin-login', clientIp(req), 5, 15 * 60_000)
    if (!limit.allowed) {
      res.setHeader('Retry-After', limit.retryAfter ?? 60)
      res.status(429).json({ error: 'Too many login attempts. Try again later.' })
      return
    }
    if (!await verifyPassword(body.password, config.adminPasswordHash)) {
      await store.recordRateLimitFailure('admin-login', limit.subjectHash, 5, 15 * 60_000)
      res.status(401).json({ error: 'The controller password is incorrect.' })
      return
    }
    await store.clearRateLimit('admin-login', limit.subjectHash)
    const session = await store.createSession()
    await store.audit('controller.login', {}, session.id)
    res.cookie('ub_session', session.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60_000,
    })
    res.json({ ok: true, csrfToken: session.csrf, expiresAt: session.expiresAt })
  })
  app.post('/api/auth/login', login)

  app.get('/api/session', controller, (req, res) => {
    const token = sessionTokens.get(req)!
    const session = sessions.get(req)!
    res.json({ authenticated: true, csrfToken: store.csrfForToken(token), expiresAt: session.expiresAt })
  })
  app.delete('/api/session', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const sessionId = sessions.get(req)!.id
    await store.revokeSession(sessionId)
    await store.audit('controller.logout', {}, sessionId)
    res.clearCookie('ub_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    res.status(204).end()
  }))
  app.post('/api/logout', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const sessionId = sessions.get(req)!.id
    await store.revokeSession(sessionId)
    await store.audit('controller.logout', {}, sessionId)
    res.clearCookie('ub_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    res.json({ ok: true })
  }))
  app.post('/api/session/revoke-all', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const sessionId = sessions.get(req)!.id
    await store.revokeAllSessions()
    await store.audit('controller.revoke_all_sessions', {}, sessionId)
    res.clearCookie('ub_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    res.status(204).end()
  }))

  app.get('/api/state', controller, asyncRoute(async (_req, res) => {
    const state = await store.stationState()
    res.setHeader('ETag', `"station-revision-${state.broadcast.revision}"`)
    res.json(state)
  }))
  app.post('/api/command', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const requestId = z.string().min(8).max(100).parse(req.get('Idempotency-Key'))
    const match = /^"station-revision-(\d+)"$/.exec(req.get('If-Match') ?? '')
    if (!match) {
      res.status(428).json({ error: 'Refresh the station state before you send a command.' })
      return
    }
    const command = commandSchema.parse(req.body)
    const result = await store.command(command, requestId, Number(match[1]))
    await store.audit(
      'station.command',
      { action: command.action, requestId, revision: result.revision },
      sessions.get(req)!.id,
    )
    const state = await store.stationState()
    res.setHeader('ETag', `"station-revision-${state.broadcast.revision}"`)
    res.json(state)
  }))

  app.get('/api/badges', controller, asyncRoute(async (_req, res) => {
    res.json({ badges: await store.badges() })
  }))
  app.post('/api/badges', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const body = z.object({ label: z.string().trim().min(1).max(80) }).parse(req.body)
    const badge = await store.createBadge(body.label)
    const sessionId = sessions.get(req)!.id
    await store.audit('badge.created', { label: body.label }, sessionId, badge.badgeId)
    res.status(201).json({ ...badge, serviceUrl: config.appOrigin })
  }))
  app.post('/api/badges/claim', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    if (!await consumeLimit(res, 'badge-claim', `${sessions.get(req)!.id}:${clientIp(req)}`, 10, 10 * 60_000)) return
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body)
    const badgeId = await store.claimBadge(body.code)
    if (!badgeId) {
      res.status(409).json({ error: 'The claim code is invalid, expired, or already used.' })
      return
    }
    await store.audit('badge.claimed', {}, sessions.get(req)!.id, badgeId)
    res.status(201).json({ badgeId })
  }))
  app.post('/api/badges/:badgeId/revoke', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const badgeId = z.string().uuid().parse(req.params.badgeId)
    if (!await store.revokeBadge(badgeId)) {
      res.status(404).json({ error: 'Badge not found.' })
      return
    }
    await store.audit('badge.revoked', {}, sessions.get(req)!.id, badgeId)
    res.status(204).end()
  }))
  app.post('/api/badges/:badgeId/rotate-secret', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const badgeId = z.string().uuid().parse(req.params.badgeId)
    const badge = await store.rotateBadge(badgeId)
    if (!badge) {
      res.status(404).json({ error: 'Active badge not found.' })
      return
    }
    await store.audit('badge.secret_rotated', {}, sessions.get(req)!.id, badgeId)
    res.json({ ...badge, serviceUrl: config.appOrigin })
  }))

  app.post('/api/device/sync', asyncRoute(async (req, res) => {
    const authorization = badgeAuthorization(req.get('Authorization'))
    if (!authorization) {
      res.status(401).json({ error: 'Badge credentials are invalid.' })
      return
    }
    const badge = await store.authenticateBadge(
      authorization.badgeId,
      authorization.badgeSecret,
    )
    if (!badge) {
      res.status(401).json({ error: 'Badge credentials are invalid.' })
      return
    }
    const limit = await store.consumeDeviceSyncLimit(badge.id, 180, 2 * 60_000)
    if (!limit.allowed) {
      res.setHeader('Retry-After', limit.retryAfter ?? 1)
      res.status(429).json({ error: 'Too many device sync requests. Try again later.' })
      return
    }
    const report = deviceSyncSchema.parse(req.body)
    const now = Date.now()
    await store.recordDeviceSync(badge.id, report, now)
    if (!badge.claimedAt) {
      const claim = await store.issueBadgeClaimCode(badge.id, now)
      if (!claim) {
        res.status(409).json({ error: 'This badge cannot start a claim.' })
        return
      }
      res.json({
        protocol: 2,
        mode: 'claim',
        serverTimeMs: now,
        syncAfterMs: 3000,
        claimCode: claim.code,
        claimExpiresAtMs: claim.expiresAt,
      })
      return
    }
    const station = await store.station(now)
    const event = station.broadcast.event?.clipId ? station.broadcast.event : undefined
    const clipId = event?.clipId ?? station.broadcast.clipId
    const clip = catalog.clips.find((entry) => entry.id === clipId)
    if (!clip) throw new Error('The current hosted clip is unavailable.')
    const positionMs = event
      ? Math.max(0, now - event.startedAt)
      : Math.max(0, Math.floor(station.broadcast.position * 1000))
    const paused = station.broadcast.paused && !event
    res.json({
      protocol: 2,
      mode: 'play',
      serverTimeMs: now,
      syncAfterMs: paused ? 5000 : 1000,
      stationRevision: station.revision,
      commandSeq: station.commandSeq,
      playbackGeneration: station.playbackGeneration,
      contentVersion: catalog.catalogHash,
      paused,
      clip: {
        id: clip.id,
        startedAtMs: now - positionMs,
        positionMs,
        durationMs: Math.round(clip.duration * 1000),
        fps: clip.fps,
        frameCount: clip.frameCount,
        frameNumberWidth: 4,
        frameUrlTemplate: frameUrlTemplate(catalog, clip.id, config),
      },
    })
  }))

  app.get('/api/health/live', (_req, res) => res.json({ ok: true }))
  app.get('/api/health/ready', asyncRoute(async (_req, res) => {
    if (options.ready) await options.ready()
    else await hostedPool().query('SELECT 1')
    res.json({ ok: true })
  }))

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }))
  const errors: ErrorRequestHandler = (error: HostedError, _req, res, _next) => {
    if (res.headersSent) {
      res.end()
      return
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'The request is invalid.' })
      return
    }
    const status = error.status ?? 500
    if (status >= 500) console.error(JSON.stringify({ type: 'hosted_error', message: error.message }))
    res.status(status).json({
      error: status >= 500 ? 'The hosted station could not complete this request.' : error.message,
      ...(error.current ? { current: error.current } : {}),
    })
  }
  app.use(errors)
  return app
}
