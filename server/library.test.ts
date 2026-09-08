import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { importVideo, loadLibrary, runFfmpeg } from './library.ts'

test('video conversion creates matching phone and raw badge assets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'underhive-video-'))
  try {
    const input = path.join(dir, 'input.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=8', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input])
    const clip = await importVideo(dir, input, 'A test broadcast', 'mov')
    assert.equal(clip.frameCount, 8)
    assert.equal(clip.duration, 1)
    assert.equal(clip.category, 'custom')
    const library = await loadLibrary(dir)
    assert.equal(library[0].id, clip.id)
    const raw = await readFile(path.join(dir, 'library', clip.id, 'frames', '0000.rgba'))
    assert.equal(raw.length, 160 * 120 * 4)
    assert.equal(raw[0], 0) // The wide source receives black letterboxing.
    assert.equal(raw[(60 * 160 + 80) * 4 + 3], 255)
    const poster = await sharp(path.join(dir, 'library', clip.id, 'poster.png')).metadata()
    assert.equal(poster.width, 640)
    assert.ok((await readFile(path.join(dir, 'library', clip.id, 'video.mp4'))).length > 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failed video conversion leaves no partial library entry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'underhive-bad-video-'))
  try {
    await assert.rejects(importVideo(dir, path.join(dir, 'missing.mp4'), 'Missing', 'mov'), /Video conversion failed/)
    assert.deepEqual(await readdir(path.join(dir, 'library')), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
