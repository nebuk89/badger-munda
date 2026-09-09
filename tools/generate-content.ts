import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ffmpeg from 'ffmpeg-static'
import sharp from 'sharp'
import { artworks, FPS, FRAME_COUNT, HEIGHT, POSTER_FRAME, WIDTH } from './content-art.ts'
import type { Clip } from '../shared/types.ts'

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertComplete(directory: string, id: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Clip
  if (
    manifest.id !== id || manifest.width !== WIDTH || manifest.height !== HEIGHT ||
    manifest.frameCount !== FRAME_COUNT || manifest.fps !== FPS ||
    manifest.duration !== FRAME_COUNT / FPS ||
    typeof manifest.title !== 'string' || typeof manifest.subtitle !== 'string' ||
    !['advert', 'notice', 'event', 'custom'].includes(manifest.category) ||
    !/^#[0-9a-f]{6}$/i.test(manifest.accent) ||
    manifest.posterUrl !== `/media/${id}/poster.png` ||
    manifest.videoUrl !== `/media/${id}/video.mp4`
  ) {
    throw new Error(`Existing clip ${id} has an incompatible manifest; it was not overwritten.`)
  }
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const name = frame.toString().padStart(4, '0')
    const raw = await stat(join(directory, 'frames', `${name}.rgba`))
    const png = await sharp(join(directory, 'frames', `${name}.png`)).metadata()
    if (!raw.isFile() || raw.size !== WIDTH * HEIGHT * 4 || png.width !== WIDTH || png.height !== HEIGHT) {
      throw new Error(`Clip ${id} has an incomplete frame ${name}; it was not overwritten.`)
    }
  }
  const poster = await sharp(join(directory, 'poster.png')).metadata()
  const video = await stat(join(directory, 'video.mp4'))
  if (poster.width !== WIDTH * 4 || poster.height !== HEIGHT * 4 || !video.isFile() || video.size === 0) {
    throw new Error(`Clip ${id} has incomplete previews; it was not overwritten.`)
  }
}

async function encodeVideo(directory: string) {
  const executable: unknown = ffmpeg
  if (typeof executable !== 'string') throw new Error('ffmpeg-static does not support this platform.')
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
    '-framerate', String(FPS), '-start_number', '0',
    '-i', join(directory, 'frames', '%04d.png'),
    '-frames:v', String(FRAME_COUNT),
    '-vf', 'scale=640:480:flags=neighbor',
    '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    join(directory, 'video.mp4'),
  ]
  await new Promise<void>((done, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-32_768)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) done()
      else reject(new Error(`FFmpeg failed (${signal ?? code}): ${diagnostic.trim()}`))
    })
  })
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Generate original Underhive Broadcast starter clips.

Usage: npx tsx tools/generate-content.ts
       DATA_DIR=./data npx tsx tools/generate-content.ts

Creates ${artworks.length} 8-second, 8-fps clips in DATA_DIR/library (default: ./data/library).
Each clip contains a manifest, 64 PNG/RGBA badge frames, a poster and an MP4.
Complete existing clips are kept. Incomplete or incompatible clips cause an
error without modifying them; move them aside before retrying.`)
    return
  }
  if (process.argv.length > 2) throw new Error('Unknown argument. Use --help for usage.')

  const library = resolve(process.env.DATA_DIR || 'data', 'library')
  await mkdir(library, { recursive: true })
  let generated = 0
  for (const artwork of artworks) {
    const { clip } = artwork
    const destination = join(library, clip.id)
    if (await exists(destination)) {
      await assertComplete(destination, clip.id)
      console.log(`Kept complete clip: ${destination}`)
      continue
    }

    // Publish only finished clips; staging stays beside the destination on the same filesystem.
    const staging = join(library, `.${clip.id}.staging-${randomUUID()}`)
    await mkdir(join(staging, 'frames'), { recursive: true })
    try {
      for (let frame = 0; frame < FRAME_COUNT; frame++) {
        const name = frame.toString().padStart(4, '0')
        const raw = await sharp(Buffer.from(artwork.frame(frame)))
          .flatten({ background: '#000000' })
          .ensureAlpha()
          .raw()
          .toBuffer()
        if (raw.byteLength !== WIDTH * HEIGHT * 4) {
          throw new Error(`Unexpected pixel buffer size for ${clip.id} frame ${name}.`)
        }
        const image = sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
        await writeFile(join(staging, 'frames', `${name}.rgba`), raw)
        await image.clone().png().toFile(join(staging, 'frames', `${name}.png`))
        if (frame === POSTER_FRAME) {
          await image.clone().resize(WIDTH * 4, HEIGHT * 4, { kernel: 'nearest' })
            .png().toFile(join(staging, 'poster.png'))
        }
      }
      await encodeVideo(staging)
      await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(clip, null, 2)}\n`)
      await assertComplete(staging, clip.id)
      if (await exists(destination)) {
        throw new Error(`Clip ${clip.id} appeared during generation; it was not overwritten.`)
      }
      await rename(staging, destination)
      generated++
      console.log(`Generated ${clip.id}: ${FRAME_COUNT} frames, ${clip.duration}s — ${destination}`)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  console.log(`Ready: ${artworks.length} clips (${generated} generated, ${artworks.length - generated} kept).`)
}

await main()
