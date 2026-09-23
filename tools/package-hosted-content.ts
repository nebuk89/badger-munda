import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { packFrame } from '../server/frames.ts'
import type { Clip } from '../shared/types.ts'
import { artworks } from './content-art.ts'
import type { Artwork } from './content-primitives.ts'

export interface HostedClip extends Clip {
  frameIds: number[]
  framePaths: string[]
  frameHashes: string[]
  posterPath: string
  posterHash: string
  videoPath: string
  videoHash: string
}

export interface HostedCatalog {
  version: 1
  catalogHash: string
  generatedAt: string
  clips: HostedClip[]
}

function digest(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex')
}

async function packageArtwork(staging: string, artwork: Artwork, firstFrameId: number): Promise<HostedClip> {
  const framesDir = path.join(staging, 'clips', artwork.clip.id, 'frames')
  await mkdir(framesDir, { recursive: true })
  const frameIds: number[] = []
  const framePaths: string[] = []
  const frameHashes: string[] = []
  for (let frame = 0; frame < artwork.clip.frameCount; frame++) {
    const frameId = firstFrameId + frame
    const rgba = await sharp(Buffer.from(artwork.frame(frame))).ensureAlpha().raw().toBuffer()
    const wire = packFrame(rgba, 'png', frameId, false)
    const filename = `${String(frame).padStart(4, '0')}.ubf`
    const relative = path.posix.join('clips', artwork.clip.id, 'frames', filename)
    await writeFile(path.join(staging, relative), wire)
    frameIds.push(frameId)
    framePaths.push(relative)
    frameHashes.push(digest(wire))
  }
  const sampleDir = path.resolve('samples', artwork.clip.id)
  const posterBytes = await readFile(path.join(sampleDir, 'poster.png'))
  const videoBytes = await readFile(path.join(sampleDir, 'video.mp4'))
  const posterHash = digest(posterBytes)
  const videoHash = digest(videoBytes)
  const posterPath = path.posix.join('clips', artwork.clip.id, 'poster.png')
  const videoPath = path.posix.join('clips', artwork.clip.id, 'video.mp4')
  await writeFile(path.join(staging, posterPath), posterBytes)
  await writeFile(path.join(staging, videoPath), videoBytes)
  return {
    ...artwork.clip,
    posterUrl: posterPath,
    videoUrl: videoPath,
    frameIds,
    framePaths,
    frameHashes,
    posterPath,
    posterHash,
    videoPath,
    videoHash,
  }
}

export async function packageHostedContent(
  outputRoot = path.resolve('generated', 'hosted'),
  selectedArtworks: Artwork[] = artworks,
) {
  const staging = path.join(outputRoot, `.staging-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    const clips: HostedClip[] = []
    let frameId = 1
    for (const artwork of selectedArtworks) {
      clips.push(await packageArtwork(staging, artwork, frameId))
      frameId += artwork.clip.frameCount
    }
    const stableCatalog = { version: 1 as const, clips }
    const catalogHash = digest(JSON.stringify(stableCatalog))
    const catalog: HostedCatalog = {
      ...stableCatalog,
      catalogHash,
      generatedAt: new Date().toISOString(),
    }
    await writeFile(path.join(staging, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
    const destination = path.join(outputRoot, 'content', 'v1', catalogHash)
    await mkdir(path.dirname(destination), { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    await writeFile(path.join(outputRoot, 'active-catalog.json'), `${JSON.stringify({
      version: 1,
      catalogHash,
      catalogPath: path.posix.join('content', 'v1', catalogHash, 'catalog.json'),
    }, null, 2)}\n`)
    return { catalog, directory: destination }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { catalog, directory } = await packageHostedContent()
  await cp(path.join(directory, 'catalog.json'), path.join(path.resolve('generated', 'hosted'), 'catalog.json'))
  console.log(`Packaged ${catalog.clips.length} clips and ${catalog.clips.reduce((sum, clip) => sum + clip.frameCount, 0)} frames.`)
  console.log(`Catalog: ${catalog.catalogHash}`)
}
