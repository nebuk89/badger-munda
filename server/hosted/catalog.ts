import { z } from 'zod'
import type { Clip } from '../../shared/types.ts'
import { hostedConfig } from './env.ts'

const hostedClipSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  category: z.enum(['advert', 'notice', 'event', 'custom']),
  duration: z.number(),
  fps: z.number().int(),
  frameCount: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  accent: z.string(),
  frameIds: z.array(z.number().int()),
  framePaths: z.array(z.string()),
  frameHashes: z.array(z.string()),
  posterPath: z.string(),
  posterHash: z.string(),
  videoPath: z.string(),
  videoHash: z.string(),
})

const catalogSchema = z.object({
  version: z.literal(1),
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/),
  clips: z.array(hostedClipSchema).min(1),
})

export type HostedCatalog = z.infer<typeof catalogSchema>
let pending: Promise<HostedCatalog> | undefined

export function loadHostedCatalog() {
  pending ??= (async () => {
    const response = await fetch(hostedConfig().catalogUrl)
    if (!response.ok) throw new Error(`Content catalog request failed (${response.status}).`)
    return catalogSchema.parse(await response.json())
  })()
  return pending
}

export function controllerLibrary(catalog: HostedCatalog): Clip[] {
  const base = hostedConfig().blobBaseUrl
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
    posterUrl: `${base}/${clip.posterPath}`,
    videoUrl: `${base}/${clip.videoPath}`,
  }))
}

export function frameUrlTemplate(catalog: HostedCatalog, clipId: string) {
  const clip = catalog.clips.find((entry) => entry.id === clipId)
  if (!clip) throw new Error('Unknown content clip.')
  const first = clip.framePaths[0]
  const template = first.replace(/0000\.ubf$/, '{frame}.ubf')
  if (template === first) throw new Error('Invalid frame catalog path.')
  return `${hostedConfig().blobBaseUrl}/${template}`
}
