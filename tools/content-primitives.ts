import type { Clip } from '../shared/types.ts'

export const WIDTH = 160
export const HEIGHT = 120
export const FPS = 8
export const FRAME_COUNT = 64
export const POSTER_FRAME = 16
export const tau = Math.PI * 2

export type Artwork = {
  clip: Clip
  frame: (frame: number) => string
}

const font = "'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif"
const mono = "'DejaVu Sans Mono', Menlo, monospace"

function escapeText(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function text(value: string, x: number, y: number, size: number, color: string, extra = '') {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="900" fill="${color}" ${extra}>${escapeText(value)}</text>`
}

export function label(value: string, x: number, y: number, color: string, size = 5) {
  return `<text x="${x}" y="${y}" font-family="${mono}" font-size="${size}" font-weight="700" fill="${color}">${escapeText(value)}</text>`
}

export function rect(x: number, y: number, width: number, height: number, fill: string, extra = '') {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" ${extra}/>`
}

export function bars(frame: number, x: number, y: number, color: string) {
  return Array.from({ length: 5 }, (_, i) => {
    const height = 2 + i * 2
    const active = i < 3 || Math.sin((frame / FRAME_COUNT) * tau + i) > -0.45
    return rect(x + i * 3, y + 10 - height, 2, height, color, `opacity="${active ? 1 : 0.3}"`)
  }).join('')
}

function surface(frame: number, tint: string) {
  const lines = Array.from({ length: 30 }, (_, i) =>
    rect(0, i * 4, WIDTH, 1, '#000', 'opacity=".075"'),
  ).join('')
  const grain = Array.from({ length: 50 }, (_, i) =>
    rect((i * 47 + 13) % WIDTH, (i * 31 + 7) % HEIGHT, 1, 1, tint, 'opacity=".12"'),
  ).join('')
  return `${lines}${grain}${rect(0, (frame * 2) % HEIGHT, WIDTH, 2, tint, 'opacity=".025"')}`
}

export function svg(frame: number, background: string, drawing: string, tint: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    ${rect(0, 0, WIDTH, HEIGHT, background)}
    ${drawing}
    ${surface(frame, tint)}
  </svg>`
}

export function clip(id: string, title: string, subtitle: string, category: Clip['category'], accent: string): Clip {
  return {
    id, title, subtitle, category,
    duration: FRAME_COUNT / FPS,
    fps: FPS,
    frameCount: FRAME_COUNT,
    width: WIDTH,
    height: HEIGHT,
    accent,
    posterUrl: `/media/${id}/poster.png`,
    videoUrl: `/media/${id}/video.mp4`,
  }
}
