import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Clip } from '../shared/types.ts'
import { gameEvents } from '../shared/game-events.ts'
import { Station, commandSchema } from './station.ts'

const clips: Clip[] = ['a', 'b', 'c'].map((id) => ({
  id, title: id, subtitle: '', category: 'advert', duration: 8, fps: 8,
  frameCount: 64, width: 160, height: 120, accent: '#ffffff',
  posterUrl: `/media/${id}/poster.png`, videoUrl: `/media/${id}/video.mp4`,
}))

const eventClips: Clip[] = gameEvents.map((event) => ({
  ...clips[0], id: event.clipId, title: event.title, subtitle: event.detail, category: 'event',
}))

function setup(library = clips) {
  let now = 10000
  const station = new Station(library, undefined, () => now)
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

test('event clips never enter automatic rotation, skip controls, or the queue', () => {
  const { station, advance } = setup([...eventClips, ...clips])
  assert.equal(station.snapshot().clipId, 'a')
  advance(24_000 + 1000)
  assert.equal(station.snapshot().clipId, 'a')
  assert.equal(station.snapshot().position, 1)
  station.command({ action: 'previous' }, 'previous-001')
  assert.equal(station.snapshot().clipId, 'c')
  station.command({ action: 'next' }, 'next-001')
  assert.equal(station.snapshot().clipId, 'a')
  assert.throws(() => station.command({ action: 'queue', clipId: eventClips[0].id }, 'event-queue-001'), /cannot enter the advert queue/)
  assert.deepEqual(station.snapshot().queue, [])
  assert.throws(() => new Station(eventClips), /No programme clips/)
})

test('game video freezes the advert, expires once, and preserves the queue and repeat setting', () => {
  const { station, advance } = setup([...clips, ...eventClips])
  advance(2500)
  station.command({ action: 'queue', clipId: 'b' }, 'queue-001')
  station.command({ action: 'loop', enabled: true }, 'loop-001')
  const started = station.command({ action: 'game-event', eventId: 'failed-jump' }, 'game-001')
  assert.equal(started.event?.clipId, 'event-failed-jump')
  assert.equal(started.event?.startedAt, 12500)
  advance(7000)
  assert.equal(station.snapshot().position, 2.5)
  assert.equal(station.snapshot().paused, false)
  advance(1000)
  const ended = station.snapshot()
  assert.equal(ended.event, null)
  assert.equal(ended.clipId, 'a')
  assert.equal(ended.position, 2.5)
  assert.equal(ended.loop, true)
  assert.deepEqual(ended.queue, ['b'])
  advance(5500)
  assert.equal(station.snapshot().clipId, 'b')
  assert.deepEqual(station.snapshot().queue, [])
})

test('game video expiry handles a long gap with no polling', () => {
  const { station, advance } = setup([...clips, ...eventClips])
  advance(2000)
  station.command({ action: 'game-event', eventId: 'fatality' }, 'fatality-001')
  advance(9000)
  assert.equal(station.snapshot().event, null)
  assert.equal(station.snapshot().position, 3)
})

test('dispatch while paused plays an event without changing the saved pause state', () => {
  const { station, advance } = setup([...clips, ...eventClips])
  advance(1500)
  station.command({ action: 'toggle-pause' }, 'pause-game-001')
  station.command({ action: 'game-event', eventId: 'dice-fail' }, 'dice-001')
  advance(12000)
  assert.equal(station.snapshot().event, null)
  assert.equal(station.snapshot().position, 1.5)
  assert.equal(station.snapshot().paused, true)
  station.command({ action: 'toggle-pause' }, 'unpause-game-001')
  advance(500)
  assert.equal(station.snapshot().position, 2)
})

test('replacement, duplicate requests, and cancellation retain the original advert position', () => {
  const { station, advance } = setup([...clips, ...eventClips])
  advance(3000)
  station.command({ action: 'game-event', eventId: 'dice-fail' }, 'dice-001')
  advance(1000)
  const retry = station.command({ action: 'game-event', eventId: 'dice-fail' }, 'dice-001')
  assert.equal(retry.event?.startedAt, 13000)
  const replaced = station.command({ action: 'game-event', eventId: 'ammo-jam' }, 'jam-001')
  assert.equal(replaced.event?.startedAt, 14000)
  advance(3000)
  const cleared = station.command({ action: 'clear-event' }, 'clear-001')
  assert.equal(cleared.position, 3)
  assert.equal(cleared.event, null)
  advance(500)
  assert.equal(station.snapshot().position, 3.5)
})

test('explicit event play is one-shot and an explicit programme selection cancels it', () => {
  const { station, advance } = setup([...clips, ...eventClips])
  advance(2000)
  const started = station.command({ action: 'play', clipId: 'event-bottled-it' }, 'direct-event')
  assert.equal(started.clipId, 'a')
  assert.equal(started.position, 2)
  assert.equal(started.event?.clipId, 'event-bottled-it')
  station.command({ action: 'play', clipId: 'c' }, 'select-c')
  advance(500)
  assert.equal(station.snapshot().event, null)
  assert.equal(station.snapshot().clipId, 'c')
  assert.equal(station.snapshot().position, .5)
})

test('text and round notices replace a game video and keep their original timeline behaviour', () => {
  for (const command of [
    { action: 'event' as const, title: 'NOTICE', detail: '', duration: 6 },
    { action: 'round' as const, round: 2 },
  ]) {
    const { station, advance } = setup([...clips, ...eventClips])
    advance(1000)
    station.command({ action: 'game-event', eventId: 'failed-jump' }, 'game-first')
    advance(3000)
    const notice = station.command(command, 'notice-second')
    assert.equal(notice.position, 1)
    assert.equal(notice.event?.clipId, undefined)
    advance(2000)
    assert.equal(station.snapshot().position, 3)
  }
})

test('physical skip and replay commands stop a game video and control only programme clips', () => {
  for (const [action, expected] of [['next', 'b'], ['previous', 'c'], ['replay', 'a']] as const) {
    const { station, advance } = setup([...eventClips, ...clips])
    advance(2000)
    station.command({ action: 'game-event', eventId: 'critical-hit' }, 'physical-game')
    advance(1000)
    const result = station.command({ action }, 'physical-control')
    assert.equal(result.event, null)
    assert.equal(result.clipId, expected)
    assert.equal(result.position, 0)
  }
})

test('a pause command during a game video changes only the programme pause state', () => {
  const { station, advance } = setup([...clips, ...eventClips])
  advance(1000)
  station.command({ action: 'game-event', eventId: 'failed-jump' }, 'pause-during-game')
  advance(1000)
  const paused = station.command({ action: 'toggle-pause' }, 'pause-under-game')
  assert.equal(paused.paused, true)
  assert.equal(paused.event?.startedAt, 11000)
  advance(2000)
  station.command({ action: 'toggle-pause' }, 'resume-under-game')
  advance(5000)
  assert.equal(station.snapshot().event, null)
  assert.equal(station.snapshot().position, 1)
  advance(500)
  assert.equal(station.snapshot().position, 1.5)
})

test('missing videos and invalid preset IDs fail without replacing the active event', () => {
  const { station } = setup([...clips, eventClips[0]])
  assert.equal(commandSchema.safeParse({ action: 'game-event', eventId: '../secrets' }).success, false)
  station.command({ action: 'game-event', eventId: 'failed-jump' }, 'available')
  const before = station.snapshot()
  assert.throws(() => station.command({ action: 'game-event', eventId: 'fatality' }, 'unavailable'), /video unavailable/)
  assert.deepEqual(station.snapshot(), before)
})

test('restart restores the advert and never replays a stale game event', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'underhive-event-state-'))
  try {
    let now = 10000
    const station = new Station([...clips, ...eventClips], dir, () => now)
    now += 2000
    station.command({ action: 'game-event', eventId: 'critical-hit' }, 'persistent-game')
    const restored = new Station([...clips, ...eventClips], dir, () => now)
    assert.equal(restored.snapshot().event, null)
    assert.equal(restored.snapshot().position, 2)
    await writeFile(path.join(dir, 'station.json'), JSON.stringify({
      clipId: 'a', position: 2, paused: true, loop: false, round: 1,
      queue: ['event-fatality', 'b'],
    }))
    assert.deepEqual(new Station([...clips, ...eventClips], dir).snapshot().queue, ['b'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failed event persistence rolls back and permits retry', () => {
  const { station } = setup([...clips, ...eventClips])
  Object.defineProperty(station, 'save', { configurable: true, value: () => { throw new Error('Disk is full') } })
  assert.throws(() => station.command({ action: 'game-event', eventId: 'dice-fail' }, 'persist-game'), /Disk is full/)
  assert.equal(station.snapshot().event, null)
  Object.defineProperty(station, 'save', { value: () => {} })
  assert.equal(station.command({ action: 'game-event', eventId: 'dice-fail' }, 'persist-game').event?.clipId, 'event-dice-fail')
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
