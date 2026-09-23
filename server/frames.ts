import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'
import type { Broadcast } from '../shared/types.ts'
import { FPS, HEIGHT, WIDTH } from './library.ts'
import { pairingSvg } from './pairing.ts'
import type { Station } from './station.ts'

export type WireFormat = 'rgba' | 'rgb565' | 'rgb332' | 'png'
export const FORMAT_IDS: Record<WireFormat, number> = { rgba: 1, rgb565: 2, rgb332: 3, png: 4 }

function pngChunk(name: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(name, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}

export function indexedPng(rgba: Buffer) {
  const palette = Buffer.alloc(768)
  for (let value = 0; value < 256; value++) {
    palette[value * 3] = Math.floor((value >> 5) * 255 / 7)
    palette[value * 3 + 1] = Math.floor(((value >> 2) & 7) * 255 / 7)
    palette[value * 3 + 2] = (value & 3) * 85
  }
  const rows = Buffer.alloc((WIDTH + 1) * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4
      rows[y * (WIDTH + 1) + x + 1] = (rgba[offset] & 0xe0) | ((rgba[offset + 1] >> 3) & 0x1c) | (rgba[offset + 2] >> 6)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH)
  ihdr.writeUInt32BE(HEIGHT, 4)
  ihdr[8] = 8
  ihdr[9] = 3
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('PLTE', palette),
    pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0)),
  ])
  if (png.length > 32768) throw new Error('Encoded PNG exceeds the badge payload limit.')
  return png
}

export function packFrame(rgba: Buffer, format: WireFormat, sequence: number, paused: boolean) {
  if (rgba.length !== WIDTH * HEIGHT * 4) throw new Error('Invalid RGBA frame length.')
  let payload: Buffer
  if (format === 'rgba') payload = rgba
  else if (format === 'png') payload = indexedPng(rgba)
  else {
    payload = Buffer.allocUnsafe(WIDTH * HEIGHT * (format === 'rgb565' ? 2 : 1))
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
      const offset = pixel * 4
      const r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2]
      if (format === 'rgb565') payload.writeUInt16LE(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), pixel * 2)
      else payload[pixel] = (r & 0xe0) | ((g >> 3) & 0x1c) | (b >> 6)
    }
  }
  const header = Buffer.alloc(20)
  header.write('UBF1')
  header.writeUInt16LE(WIDTH, 4)
  header.writeUInt16LE(HEIGHT, 6)
  header[8] = FORMAT_IDS[format]
  header[9] = Number(paused)
  header.writeUInt16LE(FPS, 10)
  header.writeUInt32LE(sequence >>> 0, 12)
  header.writeUInt32LE(payload.length, 16)
  return Buffer.concat([header, payload])
}

function escapeXml(text: string) {
  return text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!)
}

function lines(text: string, limit: number) {
  const result: string[] = []
  for (const word of text.split(/\s+/)) {
    const last = result.length - 1
    if (last >= 0 && result[last].length + word.length + 1 <= limit) result[last] += ` ${word}`
    else {
      for (let offset = 0; offset < word.length; offset += limit) result.push(word.slice(offset, offset + limit))
    }
  }
  return result
}

export function eventSvg(event: NonNullable<Broadcast['event']>) {
  const title = lines(event.title.toUpperCase(), 16).slice(0, 2)
  const detail = lines(event.detail.toUpperCase(), 24).slice(0, 3)
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120">
    <rect width="160" height="120" fill="#171912"/><rect x="3" y="3" width="154" height="114" fill="none" stroke="#e8ba43" stroke-width="2"/>
    <rect x="7" y="7" width="146" height="17" fill="#e8ba43"/>
    <text x="80" y="19" text-anchor="middle" font-family="monospace" font-size="8" font-weight="bold">PRIORITY TRANSMISSION</text>
    ${title.map((line, i) => `<text x="80" y="${47 + i * 17}" text-anchor="middle" fill="#f9efce" font-family="sans-serif" font-weight="bold" font-size="14">${escapeXml(line)}</text>`).join('')}
    ${detail.map((line, i) => `<text x="80" y="${83 + i * 10}" text-anchor="middle" fill="#e8ba43" font-family="monospace" font-size="8">${escapeXml(line)}</text>`).join('')}
  </svg>`)
}

interface RenderedFrame {
  key: string
  sequence: number
  rgba: Buffer
  png?: Buffer
}

export class FrameRenderer {
  private cached?: RenderedFrame
  private pending = new Map<string, Promise<RenderedFrame>>()
  private pairingImages = new Map<string, Promise<Buffer>>()
  private sequence = 0
  constructor(private dataDir: string, private station: Station) {}

  async render() {
    const state = this.station.snapshot()
    const video = state.event?.clipId ? state.event : null
    const clip = video ? this.station.library.find((clip) => clip.id === video.clipId) : this.station.clip
    if (!clip) throw new Error('Game event video unavailable.')
    const position = video ? Math.max(0, (this.station.now - video.startedAt) / 1000) : state.position
    const index = Math.min(clip.frameCount - 1, Math.floor(position * clip.fps))
    const key = video ? `game-event:${clip.id}:${video.startedAt}:${index}`
      : state.event ? `event:${state.event.title}:${state.event.detail}:${state.event.expiresAt}`
      : `${clip.id}:${index}`
    return this.renderFrame(key, () => state.event && !state.event.clipId
      ? sharp(eventSvg(state.event)).ensureAlpha().raw().toBuffer()
      : readFile(path.join(this.dataDir, 'library', clip.id, 'frames', `${String(index).padStart(4, '0')}.rgba`)))
  }

  async pairing(pin: string, address: string) {
    const key = `pairing:${address}:${pin}`
    return this.renderFrame(key, async () => {
      let image = this.pairingImages.get(key)
      if (!image) {
        image = sharp(pairingSvg(pin, address)).ensureAlpha().raw().toBuffer()
        this.pairingImages.set(key, image)
        if (this.pairingImages.size > 8) this.pairingImages.delete(this.pairingImages.keys().next().value!)
      }
      try { return await image }
      catch (error) { this.pairingImages.delete(key); throw error }
    })
  }

  private async renderFrame(key: string, load: () => Promise<Buffer>) {
    if (this.cached?.key === key) return this.cached
    const pending = this.pending.get(key)
    if (pending) return pending
    // Pairing and programme frames share both the cache and sequence allocator.
    const promise = load().then((rgba) => {
      if (rgba.length !== WIDTH * HEIGHT * 4) throw new Error('Invalid RGBA frame length.')
      const frame: RenderedFrame = { key, sequence: ++this.sequence >>> 0, rgba }
      this.cached = frame
      return frame
    })
    this.pending.set(key, promise)
    try { return await promise }
    finally { this.pending.delete(key) }
  }

  async png() {
    const frame = await this.render()
    frame.png ??= await sharp(frame.rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer()
    return frame.png
  }
}
