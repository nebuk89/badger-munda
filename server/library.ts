import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ffmpeg from 'ffmpeg-static'
import sharp from 'sharp'
import { z } from 'zod'
import type { Clip } from '../shared/types.ts'

export const WIDTH = 160
export const HEIGHT = 120
export const FPS = 8
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024

export const clipSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(80),
  subtitle: z.string().max(160),
  category: z.enum(['advert', 'notice', 'event', 'custom']),
  duration: z.number().positive().max(60),
  fps: z.number().int().min(1).max(30),
  frameCount: z.number().int().positive().max(1800),
  width: z.literal(WIDTH),
  height: z.literal(HEIGHT),
  accent: z.string().regex(/^#[\da-fA-F]{6}$/),
  posterUrl: z.string(),
  videoUrl: z.string(),
})

export async function loadLibrary(dataDir: string): Promise<Clip[]> {
  const dir = path.join(dataDir, 'library')
  await mkdir(dir, { recursive: true })
  const result: Clip[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const clip = clipSchema.parse(JSON.parse(await readFile(path.join(dir, entry.name, 'manifest.json'), 'utf8')))
    if (clip.id !== entry.name) throw new Error(`Clip folder does not match its ID: ${entry.name}`)
    const raw = await stat(path.join(dir, entry.name, 'frames', '0000.rgba'))
    if (raw.size !== WIDTH * HEIGHT * 4) throw new Error(`Invalid first frame in ${clip.id}`)
    result.push({
      ...clip,
      posterUrl: `/media/${clip.id}/poster.png`,
      videoUrl: `/media/${clip.id}/video.mp4`,
    })
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

export async function runFfmpeg(args: string[]) {
  const executable: unknown = ffmpeg
  if (typeof executable !== 'string') throw new Error('FFmpeg is unavailable on this platform.')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    })
    let error = ''
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000) })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(signal ? `Video conversion stopped: ${signal}` : `Video conversion failed: ${error.trim()}`))
    })
  })
}

export async function importVideo(dataDir: string, input: string, title: string, format: 'mov' | 'matroska'): Promise<Clip> {
  const id = `clip-${randomUUID().slice(0, 12)}`
  const libraryDir = path.join(dataDir, 'library')
  const working = path.join(libraryDir, `.${id}`)
  const framesDir = path.join(working, 'frames')
  await mkdir(framesDir, { recursive: true })
  try {
    // Protocol restrictions prevent an uploaded playlist from fetching local or remote files.
    await runFfmpeg([
      '-protocol_whitelist', 'file', '-f', format, '-i', input, '-t', '30', '-map', '0:v:0', '-an',
      '-vf', `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      '-start_number', '0', path.join(framesDir, '%04d.png'),
    ])
    const frames = (await readdir(framesDir)).filter((file) => /^\d{4}\.png$/.test(file)).sort()
    if (!frames.length) throw new Error('The file contains no decodable video frames.')
    for (const file of frames) {
      const pixels = await sharp(path.join(framesDir, file)).ensureAlpha().raw().toBuffer()
      await writeFile(path.join(framesDir, file.replace('.png', '.rgba')), pixels)
    }
    await sharp(path.join(framesDir, frames[0])).resize(640, 480, { kernel: 'nearest' })
      .png().toFile(path.join(working, 'poster.png'))
    await runFfmpeg([
      '-framerate', String(FPS), '-start_number', '0', '-i', path.join(framesDir, '%04d.png'),
      '-vf', 'scale=640:480:flags=neighbor', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', path.join(working, 'video.mp4'),
    ])
    const clip: Clip = {
      id, title, subtitle: 'Custom transmission', category: 'custom',
      duration: frames.length / FPS, fps: FPS, frameCount: frames.length,
      width: WIDTH, height: HEIGHT, accent: '#d6d97b',
      posterUrl: `/media/${id}/poster.png`, videoUrl: `/media/${id}/video.mp4`,
    }
    await writeFile(path.join(working, 'manifest.json'), JSON.stringify(clip, null, 2))
    await rename(working, path.join(libraryDir, id))
    return clip
  } catch (error) {
    await rm(working, { recursive: true, force: true })
    throw error
  }
}
