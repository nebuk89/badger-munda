import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express'
import sharp from 'sharp'
import { z } from 'zod'
import { commandSchema } from '../station.ts'
import { eventSvg } from '../frames.ts'
import { equalText, sha256 } from './crypto.ts'
import { hostedConfig } from './env.ts'
import { loadHostedCatalog, frameUrlTemplate, type HostedCatalog } from './catalog.ts'
import { verifyPassword } from './password.ts'
import { HostedStore } from './store.ts'
import { hostedPool } from './db/client.ts'

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

function badgeCredentials(value: string | undefined) {
  const match = /^Badge ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/.exec(value ?? '')
  return match ? { id: match[1], secret: match[2] } : undefined
}

async function previewPng(catalog: HostedCatalog, store: HostedStore, now: number) {
  const station = await store.station(now)
  if (station.broadcast.event && !station.broadcast.event.clipId) {
    return sharp(eventSvg(station.broadcast.event)).png().toBuffer()
  }
  const event = station.broadcast.event?.clipId ? station.broadcast.event : undefined
  const clipId = event?.clipId ?? station.broadcast.clipId
  const clip = catalog.clips.find((entry) => entry.id === clipId)
  if (!clip) throw new Error('The current clip is unavailable.')
  const position = event
    ? Math.max(0, (now - event.startedAt) / 1000)
    : station.broadcast.position
  const index = Math.min(clip.frameCount - 1, Math.floor(position * clip.fps))
  const url = `${hostedConfig().blobBaseUrl}/${clip.framePaths[index]}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Frame request failed (${response.status}).`)
  const wire = Buffer.from(await response.arrayBuffer())
  if (wire.length < 77 || wire.subarray(0, 4).toString() !== 'UBF1' || wire[8] !== 4) {
    throw new Error('The hosted frame is invalid.')
  }
  const length = wire.readUInt32LE(16)
  if (length !== wire.length - 20) throw new Error('The hosted frame length is invalid.')
  return wire.subarray(20)
}

export async function createHostedApp(options: {
  catalog?: HostedCatalog
  store?: HostedStore
} = {}) {
  const config = hostedConfig()
  const catalog = options.catalog ?? await loadHostedCatalog()
  const store = options.store ?? new HostedStore(catalog)
  const app = express()

  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/api/device/sync') {
      if (req.headers.origin !== config.appOrigin) {
        res.status(403).json({ error: 'This origin cannot control the station.' })
        return
      }
    }
    next()
  })
  app.use(express.json({ limit: '8kb' }))

  const loadSession: RequestHandler = asyncRoute(async (req, _res, next) => {
    const token = cookie(req, 'ub_session')
    const session = await store.session(token)
    if (token && session) {
      sessionTokens.set(req, token)
      sessions.set(req, session)
    }
    next()
  })
  app.use(loadSession)

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
  const audit = async (
    eventType: string,
    detail: Record<string, unknown>,
    subject: { badgeId?: string; sessionId?: string } = {},
  ) => {
    try {
      await store.audit(eventType, detail, subject)
    } catch (error) {
      console.error(JSON.stringify({
        type: 'hosted_audit_error',
        eventType,
        message: error instanceof Error ? error.message : String(error),
      }))
    }
  }

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
    await audit('controller.login', {}, { sessionId: session.id })
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
  app.post('/api/pair', login)

  app.get('/api/session', controller, (req, res) => {
    const token = sessionTokens.get(req)!
    const session = sessions.get(req)!
    res.json({ authenticated: true, csrfToken: store.csrfForToken(token), expiresAt: session.expiresAt })
  })
  app.delete('/api/session', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const sessionId = sessions.get(req)!.id
    await store.revokeSession(sessions.get(req)!.id)
    await audit('controller.logout', {}, { sessionId })
    res.clearCookie('ub_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    res.status(204).end()
  }))
  app.post('/api/logout', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const sessionId = sessions.get(req)!.id
    await store.revokeSession(sessions.get(req)!.id)
    await audit('controller.logout', {}, { sessionId })
    res.clearCookie('ub_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    res.json({ ok: true })
  }))
  app.post('/api/session/revoke-all', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    await store.revokeAllSessions()
    await audit('controller.revoke_all_sessions', {}, { sessionId: sessions.get(req)!.id })
    res.clearCookie('ub_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
    res.status(204).end()
  }))

  app.get('/api/state', controller, asyncRoute(async (_req, res) => {
    const state = await store.stationState()
    res.setHeader('ETag', `"station-revision-${state.broadcast.revision}"`)
    res.json(state)
  }))
  app.post('/api/command', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const requestId = z.string().min(8).max(100).parse(req.get('Idempotency-Key') ?? req.body?.requestId)
    const match = /^"station-revision-(\d+)"$/.exec(req.get('If-Match') ?? '')
    if (!match) {
      res.status(428).json({ error: 'Refresh the station state before sending a command.' })
      return
    }
    const command = commandSchema.parse(req.body)
    const result = await store.command(command, requestId, Number(match[1]))
    await audit('station.command', { action: command.action, requestId, revision: result.revision }, { sessionId: sessions.get(req)!.id })
    const state = await store.stationState()
    res.setHeader('ETag', `"station-revision-${state.broadcast.revision}"`)
    res.json(state)
  }))
  app.get('/api/frame.png', controller, asyncRoute(async (_req, res) => {
    res.type('png').send(await previewPng(catalog, store, Date.now()))
  }))
  app.post('/api/library', controller, csrf, (_req, res) => {
    res.status(501).json({ error: 'Custom video upload is not available on the hosted station.' })
  })

  app.get('/api/badges', controller, asyncRoute(async (_req, res) => {
    res.json({ badges: await store.badges() })
  }))
  app.post('/api/badges', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const body = z.object({ label: z.string().trim().min(1).max(80) }).parse(req.body)
    const badge = await store.createBadge(body.label)
    await audit('badge.created', { label: body.label }, { badgeId: badge.badgeId, sessionId: sessions.get(req)!.id })
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
    await audit('badge.claimed', {}, { badgeId, sessionId: sessions.get(req)!.id })
    res.status(201).json({ badgeId })
  }))
  app.post('/api/badges/:badgeId/revoke', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const badgeId = z.string().uuid().parse(req.params.badgeId)
    await store.revokeBadge(badgeId)
    await audit('badge.revoked', {}, { badgeId, sessionId: sessions.get(req)!.id })
    res.status(204).end()
  }))
  app.post('/api/badges/:badgeId/rotate-secret', controller, csrf, controllerWriteLimit, asyncRoute(async (req, res) => {
    const badgeId = z.string().uuid().parse(req.params.badgeId)
    const result = await store.rotateBadge(badgeId)
    await audit('badge.secret_rotated', {}, { badgeId, sessionId: sessions.get(req)!.id })
    res.json(result)
  }))

  const syncSchema = z.object({
    protocol: z.literal(2),
    bootId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    firmwareVersion: z.string().min(1).max(80),
    lastStationRevision: z.number().int().nonnegative().optional(),
    lastCommandSeq: z.number().int().nonnegative().optional(),
    lastPlaybackGeneration: z.number().int().nonnegative().optional(),
    lastAssetFrameId: z.number().int().nonnegative().optional(),
    fps: z.number().min(0).max(120).optional(),
    errorCode: z.string().max(80).nullable().optional(),
  })
  app.post('/api/device/sync', asyncRoute(async (req, res) => {
    const auth = badgeCredentials(req.headers.authorization)
    if (!auth) {
      res.status(401).json({ error: 'Badge credentials are invalid.' })
      return
    }
    const badge = await store.authenticateBadge(auth.id, auth.secret)
    if (!badge) {
      res.status(401).json({ error: 'Badge credentials are invalid.' })
      return
    }
    if (badge.revoked_at) {
      res.status(403).json({ error: 'Badge access is revoked.', code: 'badge_revoked' })
      return
    }
    if (!await consumeLimit(res, 'device-sync', badge.id, 180, 2 * 60_000)) return
    const receipt = syncSchema.parse(req.body)
    const now = Date.now()
    await store.recordBadgeStatus(badge.id, receipt, now)
    if (!badge.claimed_at) {
      const claim = await store.claimCode(badge.id, now)
      res.json({
        protocol: 2,
        serverTimeMs: now,
        syncAfterMs: 3000,
        mode: 'claim',
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
    res.json({
      protocol: 2,
      serverTimeMs: now,
      syncAfterMs: station.broadcast.paused && !event ? 5000 : 1000,
      mode: 'play',
      stationRevision: station.revision,
      commandSeq: station.commandSeq,
      playbackGeneration: station.playbackGeneration,
      paused: station.broadcast.paused && !event,
      clip: {
        id: clip.id,
        startedAtMs: now - positionMs,
        positionMs,
        fps: clip.fps,
        frameCount: clip.frameCount,
        frameNumberWidth: 4,
        frameUrlTemplate: frameUrlTemplate(catalog, clip.id),
      },
    })
  }))

  app.get('/api/health/live', (_req, res) => res.json({ ok: true }))
  app.get('/api/health/ready', asyncRoute(async (_req, res) => {
    await hostedPool().query('SELECT 1')
    res.json({ ok: true })
  }))

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }))
  const errors: ErrorRequestHandler = (error: HostedError, _req, res, _next) => {
    if (res.headersSent) {
      res.end()
      return
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((issue) => issue.message).join('; ') })
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
