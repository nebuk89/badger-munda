import assert from 'node:assert/strict'
import type { QueryResultRow } from 'pg'
import test from 'node:test'
import { keyedHash } from './crypto.ts'
import {
  DeviceSyncStore,
  type DeviceDatabase,
  type DeviceQueryable,
} from './device-store.ts'

interface ScriptedResult {
  rows?: QueryResultRow[]
  rowCount?: number
}

class ScriptedDatabase implements DeviceDatabase {
  calls: Array<{ text: string; values: unknown[] }> = []

  constructor(private readonly results: ScriptedResult[]) {}

  async query<Row extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ) {
    this.calls.push({ text, values })
    const result = this.results.shift() ?? {}
    return {
      rows: (result.rows ?? []) as Row[],
      rowCount: result.rowCount ?? (result.rows?.length ?? 0),
    }
  }

  transaction<T>(run: (client: DeviceQueryable) => Promise<T>) {
    return run(this)
  }
}

test('device store authenticates active overlap credentials with keyed HMAC values', async () => {
  const database = new ScriptedDatabase([
    {
      rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        claimed_at: new Date(1000),
        credential_id: 'credential-1',
        first_used_at: null,
      }],
    },
    { rowCount: 1 },
  ])
  const store = new DeviceSyncStore(database, 'device-key', 'claim-key')
  const badge = await store.authenticate(
    '11111111-1111-4111-8111-111111111111',
    'badge-secret-value',
    2000,
  )
  assert.deepEqual(badge, {
    id: '11111111-1111-4111-8111-111111111111',
    claimedAt: 1000,
  })
  assert.equal(database.calls[0].values[1], keyedHash('device-key', 'badge-secret-value'))
  assert.match(database.calls[0].text, /b\.revoked_at IS NULL/)
  assert.match(database.calls[0].text, /c\.valid_until IS NULL OR c\.valid_until/)
  assert.equal(JSON.stringify(database.calls).includes('badge-secret-value'), false)
})

test('device store rejects credentials that do not resolve to an active badge', async () => {
  const store = new DeviceSyncStore(new ScriptedDatabase([{ rows: [] }]), 'device-key', 'claim-key')
  assert.equal(await store.authenticate(
    '11111111-1111-4111-8111-111111111111',
    'revoked-secret-value',
    2000,
  ), undefined)
})

test('device store issues a single-use six-digit claim for ten minutes', async () => {
  const database = new ScriptedDatabase([
    { rows: [{ claimed_at: null }] },
    { rows: [] },
    { rowCount: 0 },
    { rows: [] },
    { rowCount: 1 },
  ])
  const store = new DeviceSyncStore(database, 'device-key', 'claim-key')
  const claim = await store.issueClaimCode('badge-1', 5000)
  assert.match(claim?.code ?? '', /^\d{6}$/)
  assert.equal(claim?.expiresAt, 605_000)
  const insert = database.calls.find((call) => call.text.includes('INSERT INTO badge_claims'))
  assert.ok(insert)
  assert.equal(insert.values[1], 'badge-1')
  assert.equal(insert.values[2], keyedHash('claim-key', claim!.code))
  assert.equal(insert.values[3], 605_000)
})

test('device store records bounded presence and the latest receipt', async () => {
  const database = new ScriptedDatabase([{ rowCount: 1 }, { rowCount: 1 }])
  const store = new DeviceSyncStore(database, 'device-key', 'claim-key')
  await store.recordSync('badge-1', {
    bootId: 'boot-id-1234',
    firmwareVersion: '2.0.0',
    knownStationRevision: 8,
    fps: 7.5,
    errorCode: 'frame_late',
    lastReceipt: {
      stationRevision: 7,
      commandSeq: 6,
      playbackGeneration: 5,
      frameId: 44,
    },
  }, 5000)
  assert.match(database.calls[0].text, /ON CONFLICT \(badge_id\) DO UPDATE/)
  assert.deepEqual(database.calls[0].values, [
    'badge-1', 'boot-id-1234', '2.0.0', 5000, 8, 7.5, 'frame_late',
  ])
  assert.match(database.calls[1].text, /badge_receipts/)
  assert.deepEqual(database.calls[1].values, ['badge-1', 7, 6, 5, 44, 5000])
})

test('device store applies a durable per-badge sync limit', async () => {
  const allowedDatabase = new ScriptedDatabase([{ rows: [] }, { rowCount: 1 }])
  const allowed = await new DeviceSyncStore(
    allowedDatabase,
    'device-key',
    'claim-key',
  ).consumeLimit('badge-1', 2, 60_000, 10_000)
  assert.deepEqual(allowed, { allowed: true })
  assert.match(allowedDatabase.calls[1].text, /device_sync_limits/)

  const blockedDatabase = new ScriptedDatabase([
    {
      rows: [{
        window_started_at: new Date(0),
        request_count: 2,
        blocked_until: null,
      }],
    },
    { rowCount: 1 },
  ])
  const blocked = await new DeviceSyncStore(
    blockedDatabase,
    'device-key',
    'claim-key',
  ).consumeLimit('badge-1', 2, 60_000, 10_000)
  assert.deepEqual(blocked, { allowed: false, retryAfter: 50 })
})
