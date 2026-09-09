import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { Clip } from '../shared/types.ts'
import { FrameRenderer, packFrame } from './frames.ts'
import { Station } from './station.ts'

const red = Buffer.alloc(160 * 120 * 4)
for (let i = 0; i < red.length; i += 4) { red[i] = 255; red[i + 3] = 255 }

test('RGBA wire frames have the exact header and byte count', () => {
  const frame = packFrame(red, 'rgba', 42, false)
  assert.equal(frame.subarray(0, 4).toString(), 'UBF1')
  assert.equal(frame.readUInt16LE(4), 160)
  assert.equal(frame.readUInt16LE(6), 120)
  assert.equal(frame[8], 1)
  assert.equal(frame[9], 0)
  assert.equal(frame.readUInt16LE(10), 8)
  assert.equal(frame.readUInt32LE(12), 42)
  assert.equal(frame.readUInt32LE(16), 76800)
  assert.equal(frame.length, 76820)
  assert.deepEqual(frame.subarray(20), red)
})

test('RGB565 is little endian and RGB332 has the correct channel layout', () => {
  const rgb565 = packFrame(red, 'rgb565', 12, true)
  assert.equal(rgb565[8], 2)
  assert.equal(rgb565[9], 1)
  assert.equal(rgb565.length, 38420)
  assert.equal(rgb565.readUInt16LE(20), 0xf800)
  const rgb332 = packFrame(red, 'rgb332', 13, false)
  assert.equal(rgb332[8], 3)
  assert.equal(rgb332.length, 19220)
  assert.equal(rgb332[20], 0xe0)
})

test('a partial raw frame cannot enter the stream', () => {
  assert.throws(() => packFrame(Buffer.alloc(10), 'rgba', 1, false), /Invalid RGBA/)
})

test('wire PNG stays 8-bit indexed and round trips through a real decoder', async () => {
  const frame = packFrame(red, 'png', 99, false)
  assert.equal(frame[8], 4)
  assert.ok(frame.length - 20 <= 32768)
  const png = frame.subarray(20)
  assert.equal(png[24], 8)
  assert.equal(png[25], 3)
  assert.equal(png[28], 0)
  const output = await sharp(png).ensureAlpha().raw().toBuffer()
  assert.deepEqual(output, red)
})

test('game frames animate over a frozen advert, replay from frame zero, and return to the saved frame', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'underhive-game-frames-'))
  const advert: Clip = {
    id: 'advert', title: 'Advert', subtitle: '', category: 'advert', duration: 8, fps: 8,
    frameCount: 64, width: 160, height: 120, accent: '#ffffff', posterUrl: '', videoUrl: '',
  }
  const event: Clip = { ...advert, id: 'event-dice-fail', title: 'Dice Fail', category: 'event' }
  try {
    const programmeFrame = Buffer.alloc(red.length, 60)
    const nextEventFrame = Buffer.alloc(red.length, 90)
    for (const clip of [advert, event]) await mkdir(path.join(directory, 'library', clip.id, 'frames'), { recursive: true })
    await writeFile(path.join(directory, 'library', advert.id, 'frames', '0004.rgba'), programmeFrame)
    await writeFile(path.join(directory, 'library', event.id, 'frames', '0000.rgba'), red)
    await writeFile(path.join(directory, 'library', event.id, 'frames', '0001.rgba'), nextEventFrame)
    let now = 10000
    const station = new Station([advert, event], undefined, () => now)
    const renderer = new FrameRenderer(directory, station)
    now += 500
    station.command({ action: 'toggle-pause' }, 'pause-frames')
    const original = await renderer.render()
    assert.deepEqual(original.rgba, programmeFrame)
    station.command({ action: 'game-event', eventId: 'dice-fail' }, 'dispatch-frames')
    const first = await renderer.render()
    assert.deepEqual(first.rgba, red)
    assert.ok(first.sequence > original.sequence)
    assert.equal((await renderer.render()).sequence, first.sequence)
    const preview = await sharp(await renderer.png()).ensureAlpha().raw().toBuffer()
    assert.deepEqual(preview, red)
    now += 125
    const second = await renderer.render()
    assert.deepEqual(second.rgba, nextEventFrame)
    assert.ok(second.sequence > first.sequence)
    assert.equal(station.snapshot().position, .5)
    station.command({ action: 'game-event', eventId: 'dice-fail' }, 'dispatch-frames')
    assert.equal((await renderer.render()).sequence, second.sequence, 'a retry cannot restart the video')
    now += 25
    station.command({ action: 'game-event', eventId: 'dice-fail' }, 'dispatch-again')
    const restarted = await renderer.render()
    assert.deepEqual(restarted.rgba, red)
    assert.notEqual(restarted.key, first.key)
    assert.ok(restarted.sequence > second.sequence)
    now += 8000
    const resumed = await renderer.render()
    assert.deepEqual(resumed.rgba, programmeFrame)
    assert.equal(station.snapshot().paused, true)
    station.command({ action: 'game-event', eventId: 'dice-fail' }, 'missing-frames')
    now += 250
    await assert.rejects(renderer.render(), /ENOENT/, 'missing frames must not silently show the advert')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
