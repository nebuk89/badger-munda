import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import type { ErrorRequestHandler, Request, RequestHandler } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { BadgeDevice, StationState } from '../shared/types.ts'
import { allowedHosts, equalSecret, localAddresses, type StationConfig } from './config.ts'
import { FORMAT_IDS, FrameRenderer, packFrame, type WireFormat } from './frames.ts'
import { FPS, HEIGHT, importVideo, loadLibrary, MAX_UPLOAD_BYTES, WIDTH } from './library.ts'
import { pairingAddress } from './pairing.ts'
import { commandSchema, Station } from './station.ts'

interface AppOptions {
  dataDir: string
  config: StationConfig
  port: number
  distDir?: string
  clock?: () => number
}

export async function createApp(options: AppOptions) {
  const { dataDir, config, port } = options
  const clock = options.clock ?? Date.now
  const station = new Station(await loadLibrary(dataDir), dataDir, clock)
  const frames = new FrameRenderer(dataDir, station)
  const app = express()
  const hosts = allowedHosts(port)
  const sessions = new Map<string, number>()
  const attempts = new Map<string, { count: number; reset: number }>()
  const devices = new Map<string, BadgeDevice & { sentFrames: number[] }>()
  const uploadsDir = path.join(dataDir, 'uploads')
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 })
  const upload = multer({ dest: uploadsDir, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, fieldSize: 256 } })
  let importing = false

  const sessionFor = (req: Request) => {
    const token = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith('ub_session='))?.slice('ub_session='.length)
    if (!token) return undefined
    const until = sessions.get(token)
    if (until && until > clock()) return token
    sessions.delete(token)
    return undefined
  }
  const hasPairedController = () => {
    const now = clock()
    for (const [token, until] of sessions) if (until <= now) sessions.delete(token)
    return sessions.size > 0
  }
  const controller: RequestHandler = (req, res, next) => {
    if (!sessionFor(req)) { res.status(401).json({ error: 'Pair this controller with the code on the badge or your Mac.' }); return }
    next()
  }
  const deviceAuth: RequestHandler = (req, res, next) => {
    if (!equalSecret(req.headers.authorization ?? '', `Bearer ${config.deviceToken}`)) {
      res.status(401).json({ error: 'The badge pairing token is invalid.' }); return
    }
    next()
  }
  const snapshot = (): StationState => ({
    library: station.library,
    broadcast: station.snapshot(),
    devices: [...devices.values()].map(({ sentFrames: _sentFrames, ...device }) => ({
      ...device, online: clock() - device.lastSeen < 8000,
    })),
    server: {
      name: 'Underhive Broadcast', version: '0.1.0', width: WIDTH, height: HEIGHT, fps: FPS,
      addresses: localAddresses(port), now: clock(),
    },
  })

  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    let hostname: string
    try { hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase() }
    catch { res.status(400).json({ error: 'Invalid host.' }); return }
    if (!hosts.has(hostname)) { res.status(403).json({ error: 'Use the station address shown on your Mac.' }); return }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let origin: URL
      try { origin = new URL(req.headers.origin) }
      catch { res.status(403).json({ error: 'Invalid request origin.' }); return }
      if (!hosts.has(origin.hostname.toLowerCase()) || ![String(port), '5173'].includes(origin.port)) {
        res.status(403).json({ error: 'This origin cannot control the station.' }); return
      }
    }
    next()
  })
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  app.use(express.json({ limit: '8kb' }))

  app.get('/api/setup', (req, res) => res.json({ paired: Boolean(sessionFor(req)), name: 'Underhive Broadcast' }))
  app.post('/api/pair', (req, res) => {
    const now = clock()
    for (const [ip, entry] of attempts) if (entry.reset <= now) attempts.delete(ip)
    const ip = req.socket.remoteAddress ?? 'unknown'
    const limit = attempts.get(ip) ?? { count: 0, reset: now + 60_000 }
    if (limit.count >= 5) {
      res.setHeader('Retry-After', Math.ceil((limit.reset - now) / 1000))
      res.status(429).json({ error: 'Too many pairing attempts. Wait one minute.' }); return
    }
    limit.count++
    attempts.set(ip, limit)
    if (attempts.size > 1000) attempts.delete(attempts.keys().next().value!)
    const body = z.object({ pin: z.string().regex(/^\d{6}$/) }).safeParse(req.body)
    if (!body.success || !equalSecret(body.data.pin, config.controllerPin)) {
      res.status(401).json({ error: 'That pairing code does not match. Check the badge or Mac terminal.' }); return
    }
    attempts.delete(ip)
    const token = randomBytes(32).toString('hex')
    sessions.set(token, now + 7 * 24 * 60 * 60_000)
    if (sessions.size > 64) sessions.delete(sessions.keys().next().value!)
    for (const device of devices.values()) device.awaitingPairing = false
    res.cookie('ub_session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 7 * 24 * 60 * 60_000 })
    res.json({ ok: true })
  })
  app.post('/api/logout', controller, (req, res) => {
    sessions.delete(sessionFor(req)!)
    res.clearCookie('ub_session', { httpOnly: true, sameSite: 'strict', path: '/' })
    res.json({ ok: true })
  })
  app.get('/api/state', controller, (_req, res) => res.json(snapshot()))
  app.post('/api/command', controller, (req, res) => {
    const requestId = z.string().min(8).max(100).parse(req.body?.requestId)
    station.command(commandSchema.parse(req.body), requestId)
    res.json(snapshot())
  })
  app.get('/api/frame.png', controller, async (_req, res) => res.type('png').send(await frames.png()))

  app.post('/api/library', controller, (req, res, next) => {
    if (importing) { res.status(409).json({ error: 'Another video is processing. Wait for it to finish.' }); return }
    importing = true
    upload.single('file')(req, res, (error) => {
      if (error) { importing = false; next(error); return }
      void (async () => {
        try {
          if (!req.file) { res.status(400).json({ error: 'Select a video file first.' }); return }
          const extension = path.extname(req.file.originalname).toLowerCase()
          if (!['.mp4', '.mov', '.webm', '.mkv'].includes(extension)) {
            res.status(400).json({ error: 'Use an MP4, MOV, WebM, or MKV video.' }); return
          }
          const title = z.string().trim().min(1).max(80).parse(req.body?.title || path.parse(req.file.originalname).name)
          const format = extension === '.mp4' || extension === '.mov' ? 'mov' : 'matroska'
          const clip = await importVideo(dataDir, req.file.path, title, format)
          station.library.push(clip)
          res.status(201).json({ clip })
        } finally {
          importing = false
          if (req.file) await unlink(req.file.path)
        }
      })().catch(next)
    })
  })

  app.get('/api/badge/frame', deviceAuth, async (req, res) => {
    const formatResult = z.enum(['rgba', 'rgb565', 'rgb332', 'png']).safeParse(req.query.format ?? 'rgba')
    const idResult = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).safeParse(req.query.device ?? 'desk-badge')
    if (!formatResult.success || !idResult.success) { res.status(400).json({ error: 'Invalid badge or frame format.' }); return }
    const format: WireFormat = formatResult.data
    const id = idResult.data
    if (!devices.has(id) && devices.size >= 8) { res.status(429).json({ error: 'This station supports eight badges.' }); return }
    const now = clock()
    const device = devices.get(id) ?? {
      id, lastSeen: now, lastFrameAt: null, frameId: null, fps: 0, online: true, format, sentFrames: [],
      awaitingPairing: !hasPairedController(),
    }
    if (now - device.lastSeen >= 8000) device.awaitingPairing = !hasPairedController()
    const appliedHeader = req.get('X-Badge-Frame')
    const applied = appliedHeader !== undefined ? Number(appliedHeader) : NaN
    if (Number.isSafeInteger(applied) && device.sentFrames.includes(applied)) {
      device.frameId = applied
      device.lastFrameAt = now
    }
    const measured = Number(req.get('X-Badge-Fps'))
    if (Number.isFinite(measured) && measured >= 0 && measured <= 120) device.fps = measured
    device.lastSeen = now
    device.format = format
    devices.set(id, device)
    let awaitingPairing = device.awaitingPairing
    let frame = awaitingPairing
      ? await frames.pairing(config.controllerPin, pairingAddress(req.socket.localAddress, port))
      : await frames.render()
    // A phone may pair while Sharp is preparing the first card.
    if (awaitingPairing && !device.awaitingPairing) {
      awaitingPairing = false
      frame = await frames.render()
    }
    const broadcast = station.snapshot()
    const payload = packFrame(frame.rgba, format, frame.sequence, !awaitingPairing && broadcast.paused && !broadcast.event?.clipId)
    device.sentFrames.push(frame.sequence)
    if (device.sentFrames.length > 16) device.sentFrames.shift()
    res.setHeader('X-Frame-Id', frame.sequence)
    res.setHeader('X-Frame-Format', FORMAT_IDS[format])
    res.type('application/octet-stream').send(payload)
  })
  app.post('/api/badge/control', deviceAuth, (req, res) => {
    const command = z.object({
      action: z.enum(['next', 'previous', 'replay', 'toggle-pause']),
      requestId: z.string().min(8).max(100),
    }).parse(req.body)
    station.command({ action: command.action }, command.requestId)
    res.json({ ok: true })
  })
  // Only expose browser assets, never raw frames, private config, or manifests.
  app.get('/media/:id/:filename', controller, (req, res) => {
    const { id, filename } = req.params
    if (typeof id !== 'string' || typeof filename !== 'string'
      || !station.library.some((clip) => clip.id === id)
      || !['poster.png', 'video.mp4'].includes(filename)) {
      res.status(404).json({ error: 'Media not found.' }); return
    }
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.sendFile(path.resolve(dataDir, 'library', id, filename), { cacheControl: false })
  })
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }))
  const dist = options.distDir ?? path.resolve('dist')
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist))
    app.get('/', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
  } else {
    app.get('/', (_req, res) => res.type('text').send('Run npm run build, then restart the station. Use npm run dev during development.'))
  }
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.end(); return }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((issue) => issue.message).join('; ') }); return
    }
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Videos must be 40 MB or smaller.' : error.message }); return
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Invalid JSON body.' }); return
    }
    const message = error instanceof Error ? error.message : 'Unexpected station error.'
    console.error(`[station] ${message}`)
    res.status(500).json({ error: message })
  }
  app.use(errorHandler)
  return { app, station, frames, snapshot }
}
