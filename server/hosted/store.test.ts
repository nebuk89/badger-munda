import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient, QueryResultRow } from 'pg'
import type { Clip } from '../../shared/types.ts'
import {
  initializeStation,
  lockedStation,
  saveEngine,
} from './store.ts'

const epochMilliseconds = 1_790_267_989_803

const library: Clip[] = [{
  id: 'clip-1',
  title: 'Clip 1',
  subtitle: '',
  category: 'advert',
  duration: 8,
  fps: 8,
  frameCount: 64,
  width: 160,
  height: 120,
  accent: '#ffffff',
  posterUrl: '/media/clip-1/poster.png',
  videoUrl: '/media/clip-1/video.mp4',
}]

interface ScriptedResult {
  rows?: QueryResultRow[]
  rowCount?: number
}

class ScriptedClient {
  calls: Array<{ text: string; values: unknown[] }> = []

  constructor(private readonly results: ScriptedResult[] = []) {}

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values })
    const result = this.results.shift() ?? {}
    return {
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? (result.rows?.length ?? 0),
    }
  }
}

function poolClient(client: ScriptedClient) {
  return client as unknown as PoolClient
}

test('station initialization separates bigint epochs from timestamptz values', async () => {
  const client = new ScriptedClient()

  await initializeStation(poolClient(client), library, epochMilliseconds)

  assert.equal(client.calls.length, 2)
  assert.match(client.calls[0].text, /\$3::timestamptz/)
  assert.equal((client.calls[0].values[2] as Date).getTime(), epochMilliseconds)

  assert.match(client.calls[1].text, /\$3::bigint/)
  assert.match(client.calls[1].text, /\$4::timestamptz/)
  assert.equal(client.calls[1].values[2], epochMilliseconds)
  assert.equal((client.calls[1].values[3] as Date).getTime(), epochMilliseconds)
  assert.doesNotMatch(client.calls[1].text, /to_timestamp/)
})

test('station materialization retains exact epoch-millisecond timestamps', async () => {
  const client = new ScriptedClient([
    {},
    {},
    {
      rows: [{
        revision: '1',
        next_command_seq: '1',
        clip_id: 'clip-1',
        paused: false,
        loop: false,
        started_at: String(epochMilliseconds),
        anchor_time: String(epochMilliseconds),
        position: 0,
        round: 1,
        event_json: null,
        queue_json: [],
        playback_generation: '1',
      }],
    },
  ])

  const station = await lockedStation(poolClient(client), library, epochMilliseconds)

  assert.equal(station.state.startedAt, epochMilliseconds)
  assert.equal(station.state.anchor, epochMilliseconds)
  assert.equal(station.state.position, 0)
  assert.equal(client.calls.length, 3)
})

test('engine saves keep bigint epochs separate from timestamptz values', async () => {
  const client = new ScriptedClient()

  await saveEngine(poolClient(client), {
    revision: 2,
    clipId: 'clip-1',
    paused: false,
    loop: false,
    startedAt: epochMilliseconds,
    anchor: epochMilliseconds,
    position: 0,
    round: 1,
    event: null,
    queue: [],
  }, 2, 2, epochMilliseconds)

  assert.match(client.calls[0].text, /\$4::timestamptz/)
  assert.equal((client.calls[0].values[3] as Date).getTime(), epochMilliseconds)
  assert.match(client.calls[1].text, /\$5::bigint/)
  assert.match(client.calls[1].text, /\$6::bigint/)
  assert.match(client.calls[1].text, /\$12::timestamptz/)
  assert.equal(client.calls[1].values[4], epochMilliseconds)
  assert.equal(client.calls[1].values[5], epochMilliseconds)
  assert.equal((client.calls[1].values[11] as Date).getTime(), epochMilliseconds)
})
