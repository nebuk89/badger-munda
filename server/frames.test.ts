import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { packFrame } from './frames.ts'

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
