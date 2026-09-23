import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Clip } from '../../shared/types.ts'
import type { HostedContentConfig } from './env.ts'
import { hostedConfig } from './env.ts'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const assetPathSchema = z.string().min(1).max(240)

const hostedClipSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  title: z.string().min(1).max(120),
  subtitle: z.string().max(240),
  category: z.enum(['advert', 'notice', 'event', 'custom']),
  duration: z.number().positive().max(300),
  fps: z.number().int().positive().max(60),
  frameCount: z.number().int().positive().max(10_000),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  accent: z.string().min(1).max(40),
  posterUrl: assetPathSchema,
  videoUrl: assetPathSchema,
  frameIds: z.array(z.number().int().positive()),
  framePaths: z.array(assetPathSchema),
  frameHashes: z.array(hashSchema),
  posterPath: assetPathSchema,
  posterHash: hashSchema,
  videoPath: assetPathSchema,
  videoHash: hashSchema,
})

const catalogSchema = z.object({
  version: z.literal(1),
  catalogHash: hashSchema,
  clips: z.array(hostedClipSchema).min(1).max(1_000),
})

export type HostedCatalog = z.infer<typeof catalogSchema>
export type HostedClip = HostedCatalog['clips'][number]

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function checkAssetPath(value: string) {
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    throw new Error('The content catalog contains an unsafe asset path.')
  }
}

function checkClip(clip: HostedClip, frameIds: Set<number>) {
  const lengths = [clip.frameIds.length, clip.framePaths.length, clip.frameHashes.length]
  if (lengths.some((length) => length !== clip.frameCount)) {
    throw new Error(`The content catalog has an incomplete frame index for ${clip.id}.`)
  }
  checkAssetPath(clip.posterPath)
  checkAssetPath(clip.videoPath)
  if (clip.posterUrl !== clip.posterPath || clip.videoUrl !== clip.videoPath) {
    throw new Error(`The content catalog has a mutable preview URL for ${clip.id}.`)
  }
  for (let frame = 0; frame < clip.frameCount; frame++) {
    const expected = `clips/${clip.id}/frames/${String(frame).padStart(4, '0')}.ubf`
    if (clip.framePaths[frame] !== expected) {
      throw new Error(`The content catalog has an invalid frame path for ${clip.id}.`)
    }
    checkAssetPath(clip.framePaths[frame])
    if (frameIds.has(clip.frameIds[frame])) throw new Error('The content catalog has duplicate frame IDs.')
    frameIds.add(clip.frameIds[frame])
  }
}

export function parseHostedCatalog(value: unknown) {
  const catalog = catalogSchema.parse(value)
  const stable = { version: catalog.version, clips: catalog.clips }
  if (sha256(JSON.stringify(stable)) !== catalog.catalogHash) {
    throw new Error('The content catalog hash does not match its contents.')
  }
  const frameIds = new Set<number>()
  for (const clip of catalog.clips) checkClip(clip, frameIds)
  return catalog
}

function catalogHashFromUrl(url: URL) {
  const match = /\/content\/v1\/([a-f0-9]{64})\/catalog\.json$/.exec(url.pathname)
  if (!match || url.search || url.hash || url.username || url.password) {
    throw new Error('CONTENT_CATALOG_URL must be an immutable content-addressed catalog URL.')
  }
  return match[1]
}

function contentRoot(config: HostedContentConfig) {
  const expectedHash = catalogHashFromUrl(config.catalogUrl)
  if (config.catalogUrl.origin !== config.blobBaseUrl.origin) {
    throw new Error('The content catalog origin is not allowlisted.')
  }
  const root = new URL('./', config.catalogUrl)
  if (!root.pathname.startsWith(config.blobBaseUrl.pathname)) {
    throw new Error('The content catalog path is not allowlisted.')
  }
  return { expectedHash, root }
}

export function validateCatalogLocation(catalog: HostedCatalog, config: HostedContentConfig) {
  const { expectedHash } = contentRoot(config)
  if (catalog.catalogHash !== expectedHash) {
    throw new Error('The content catalog URL does not match the catalog hash.')
  }
}

export function contentAssetUrl(relativePath: string, config: HostedContentConfig) {
  checkAssetPath(relativePath)
  const { root } = contentRoot(config)
  const result = new URL(relativePath, root)
  if (
    result.origin !== root.origin
    || !result.pathname.startsWith(root.pathname)
    || result.search
    || result.hash
  ) {
    throw new Error('The content asset URL is not allowlisted.')
  }
  return result.toString()
}

export function controllerLibrary(
  catalog: HostedCatalog,
  config: HostedContentConfig = hostedConfig(),
): Clip[] {
  validateCatalogLocation(catalog, config)
  return catalog.clips.map((clip) => ({
    id: clip.id,
    title: clip.title,
    subtitle: clip.subtitle,
    category: clip.category,
    duration: clip.duration,
    fps: clip.fps,
    frameCount: clip.frameCount,
    width: clip.width,
    height: clip.height,
    accent: clip.accent,
    posterUrl: contentAssetUrl(clip.posterPath, config),
    videoUrl: contentAssetUrl(clip.videoPath, config),
  }))
}

export function frameUrlTemplate(
  catalog: HostedCatalog,
  clipId: string,
  config: HostedContentConfig = hostedConfig(),
) {
  validateCatalogLocation(catalog, config)
  const clip = catalog.clips.find((entry) => entry.id === clipId)
  if (!clip) throw new Error('The current hosted clip is unavailable.')
  return contentAssetUrl(clip.framePaths[0], config).replace(/0000\.ubf$/, '{frame}.ubf')
}

let pending: Promise<HostedCatalog> | undefined

export function loadHostedCatalog(config: HostedContentConfig = hostedConfig()) {
  pending ??= (async () => {
    const response = await fetch(config.catalogUrl, { redirect: 'error' })
    if (!response.ok) throw new Error(`Content catalog request failed (${response.status}).`)
    if (response.url && response.url !== config.catalogUrl.toString()) {
      throw new Error('The content catalog response came from an untrusted URL.')
    }
    const catalog = parseHostedCatalog(await response.json())
    validateCatalogLocation(catalog, config)
    return catalog
  })()
  return pending
}
