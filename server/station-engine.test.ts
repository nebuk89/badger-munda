import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Clip, Command } from '../shared/types.ts'
import { gameEvents } from '../shared/game-events.ts'
import {
  applyEngineCommand,
  broadcastFromEngine,
  createEngineState,
  materializeEngineState,
} from './station-engine.ts'
import { Station } from './station.ts'

const clips: Clip[] = ['a', 'b', 'c'].map((id) => ({
  id, title: id, subtitle: '', category: 'advert', duration: 8, fps: 8,
  frameCount: 64, width: 160, height: 120, accent: '#ffffff',
  posterUrl: `/media/${id}/poster.png`, videoUrl: `/media/${id}/video.mp4`,
}))

const eventClips: Clip[] = gameEvents.map((event) => ({
  ...clips[0], id: event.clipId, title: event.title, subtitle: event.detail, category: 'event',
}))

test('pure engine commands preserve the local station command results', () => {
  const library = [...clips, ...eventClips]
  let now = 10_000
  let engine = createEngineState(library, now)
  const station = new Station(library, undefined, () => now)

  const advance = (milliseconds: number) => {
    now += milliseconds
    engine = materializeEngineState(engine, library, now)
    assert.deepEqual(broadcastFromEngine(engine), station.snapshot())
  }
  const command = (value: Command, requestId: string) => {
    engine = applyEngineCommand(engine, library, value, now)
    assert.deepEqual(broadcastFromEngine(engine), station.command(value, requestId))
  }

  advance(2500)
  command({ action: 'queue', clipId: 'b' }, 'queue-001')
  command({ action: 'loop', enabled: true }, 'loop-001')
  command({ action: 'game-event', eventId: 'failed-jump' }, 'game-001')
  advance(8000)
  advance(5500)
  command({ action: 'next' }, 'next-001')
  command({ action: 'toggle-pause' }, 'pause-001')
  advance(20_000)
  command({ action: 'toggle-pause' }, 'resume-001')
  command({ action: 'round', round: 3 }, 'round-003')
  advance(6001)
})

test('pure engine functions do not change their input state', () => {
  const initial = createEngineState(clips, 10_000)
  const before = structuredClone(initial)
  const materialized = materializeEngineState(initial, clips, 12_000)
  assert.deepEqual(initial, before)
  const commanded = applyEngineCommand(materialized, clips, { action: 'queue', clipId: 'b' }, 12_000)
  assert.deepEqual(materialized.queue, [])
  assert.deepEqual(commanded.queue, ['b'])
})

test('a rejected command keeps elapsed playback durable for a local restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'underhive-engine-parity-'))
  try {
    let now = 10_000
    const station = new Station(clips, directory, () => now)
    now += 8500
    assert.throws(() => station.command({ action: 'play', clipId: 'absent' }, 'invalid-001'), /Unknown clip/)
    const restored = new Station(clips, directory, () => now)
    assert.equal(restored.snapshot().clipId, 'b')
    assert.equal(restored.snapshot().position, 0.5)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
