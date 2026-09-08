import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Clip } from '../shared/types.ts'
import { Station, commandSchema } from './station.ts'

const clips: Clip[] = ['a', 'b', 'c'].map((id) => ({
  id, title: id, subtitle: '', category: 'advert', duration: 8, fps: 8,
  frameCount: 64, width: 160, height: 120, accent: '#ffffff',
  posterUrl: `/media/${id}/poster.png`, videoUrl: `/media/${id}/video.mp4`,
}))

function setup() {
  let now = 10000
  const station = new Station(clips, undefined, () => now)
  return { station, advance: (ms: number) => { now += ms } }
}

test('playlist advances with time and loops through the library', () => {
  const { station, advance } = setup()
  advance(8500)
  assert.equal(station.snapshot().clipId, 'b')
  assert.equal(station.snapshot().position, 0.5)
  advance(16000)
  assert.equal(station.snapshot().clipId, 'a')
  assert.equal(station.snapshot().position, 0.5)
})

test('pause freezes the frame and resume preserves its position', () => {
  const { station, advance } = setup()
  advance(2000)
  station.command({ action: 'toggle-pause' }, 'pause-001')
  advance(50000)
  assert.equal(station.snapshot().position, 2)
  station.command({ action: 'toggle-pause' }, 'resume-001')
  advance(500)
  assert.equal(station.snapshot().position, 2.5)
})

test('replay is idempotent but a new replay request restarts the clip', () => {
  const { station, advance } = setup()
  station.command({ action: 'replay' }, 'replay-001')
  advance(1200)
  station.command({ action: 'replay' }, 'replay-001')
  assert.equal(station.snapshot().position, 1.2)
  station.command({ action: 'replay' }, 'replay-002')
  assert.equal(station.snapshot().position, 0)
  assert.throws(() => station.command({ action: 'next' }, 'replay-002'), /different command/)
})

test('the queue takes priority over loop and consumes a clip once', () => {
  const { station, advance } = setup()
  station.command({ action: 'loop', enabled: true }, 'loop-001')
  station.command({ action: 'queue', clipId: 'c' }, 'queue-001')
  advance(9000)
  assert.equal(station.snapshot().clipId, 'c')
  assert.deepEqual(station.snapshot().queue, [])
  advance(24000)
  assert.equal(station.snapshot().clipId, 'c')
  assert.equal(station.snapshot().position, 1)
})

test('round broadcasts expire while the underlying playlist continues', () => {
  const { station, advance } = setup()
  station.command({ action: 'round', round: 3 }, 'round-003')
  assert.equal(station.snapshot().event?.title, 'CYCLE 03')
  advance(6001)
  assert.equal(station.snapshot().event, null)
  assert.equal(station.snapshot().round, 3)
  assert.equal(station.snapshot().position, 6.001)
})

test('a sleeping server skips old playback without an unbounded loop', () => {
  const { station, advance } = setup()
  advance(24 * 60 * 60 * 1000 + 2500)
  assert.equal(station.snapshot().clipId, 'a')
  assert.equal(station.snapshot().position, 2.5)
})

test('invalid clips and commands do not change the selected clip', () => {
  const { station } = setup()
  assert.throws(() => station.command({ action: 'play', clipId: 'absent' }, 'missing-1'), /Unknown clip/)
  assert.equal(station.snapshot().clipId, 'a')
  assert.equal(commandSchema.safeParse({ action: 'round', round: 100 }).success, false)
  assert.equal(commandSchema.safeParse({ action: 'event', title: '', detail: '', duration: 10 }).success, false)
})

test('a failed state write rolls back a command and does not acknowledge its retry ID', () => {
  const { station } = setup()
  Object.defineProperty(station, 'save', { configurable: true, value: () => { throw new Error('Disk is full') } })
  assert.throws(() => station.command({ action: 'next' }, 'persist-001'), /Disk is full/)
  assert.equal(station.snapshot().clipId, 'a')
  Object.defineProperty(station, 'save', { value: () => {} })
  station.command({ action: 'next' }, 'persist-001')
  assert.equal(station.snapshot().clipId, 'b')
})
