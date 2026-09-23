import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BadgeDevice, Broadcast, Clip, Command, StationState } from '../../shared/types.ts'
import {
  applyEngineCommand,
  broadcastFromEngine,
  createEngineState,
  materializeEngineState,
  type EngineState,
} from '../station-engine.ts'
import { controllerLibrary, type HostedCatalog } from './catalog.ts'
import { keyedHash, randomToken, sha256 } from './crypto.ts'
import {
  DeviceSyncStore,
  type DeviceSyncReport,
} from './device-store.ts'
import { hostedConfig } from './env.ts'
import { hostedPool, transaction } from './db/client.ts'

const STATION_ID = 'default'

interface StationRow {
  revision: string
  next_command_seq: string
  clip_id: string
  paused: boolean
  loop: boolean
  started_at: string
  anchor_time: string
  position: number
  round: number
  event_json: Broadcast['event']
  queue_json: string[]
  playback_generation: string
}

interface SessionRow {
  id: string
  csrf_hash: string
  idle_expires_at: Date
  absolute_expires_at: Date
}

interface BadgeRow {
  id: string
  label: string
  claimed_at: Date | null
  revoked_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface HostedSnapshot {
  broadcast: Broadcast
  revision: number
  commandSeq: number
  playbackGeneration: number
}

export interface HostedBadge {
  id: string
  label: string
  claimed: boolean
  revoked: boolean
  claimedAt: number | null
  revokedAt: number | null
  createdAt: number
  updatedAt: number
  online: boolean
  lastSeenAt: number | null
  firmwareVersion: string | null
  fps: number
  lastStationRevision: number | null
  lastCommandSeq: number | null
  lastPlaybackGeneration: number | null
  lastAssetFrameId: number | null
  lastErrorCode: string | null
}

function engineFromRow(row: StationRow): EngineState {
  return {
    revision: Number(row.revision),
    clipId: row.clip_id,
    paused: row.paused,
    loop: row.loop,
    startedAt: Number(row.started_at),
    anchor: Number(row.anchor_time),
    position: row.position,
    round: row.round,
    event: row.event_json,
    queue: row.queue_json,
  }
}

async function saveEngine(
  client: PoolClient,
  state: EngineState,
  playbackGeneration: number,
  nextCommandSeq: number,
  now: number,
) {
  await client.query(
    `UPDATE stations
       SET revision = $2, next_command_seq = $3, updated_at = to_timestamp($4 / 1000.0)
     WHERE id = $1`,
    [STATION_ID, state.revision, nextCommandSeq, now],
  )
  await client.query(
    `UPDATE broadcast_state
       SET clip_id = $2, paused = $3, loop = $4, started_at = $5, anchor_time = $6,
           position = $7, round = $8, event_json = $9, queue_json = $10,
           playback_generation = $11, updated_at = to_timestamp($12 / 1000.0)
     WHERE station_id = $1`,
    [
      STATION_ID, state.clipId, state.paused, state.loop, state.startedAt, state.anchor,
      state.position, state.round, state.event, JSON.stringify(state.queue),
      playbackGeneration, now,
    ],
  )
}

async function initializeStation(client: PoolClient, library: Clip[], now: number) {
  const initial = createEngineState(library, now)
  await client.query(
    `INSERT INTO stations (id, name, revision, next_command_seq, created_at, updated_at)
     VALUES ($1, 'Underhive Broadcast', $2, 1, to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))
     ON CONFLICT (id) DO NOTHING`,
    [STATION_ID, initial.revision, now],
  )
  await client.query(
    `INSERT INTO broadcast_state (
       station_id, clip_id, paused, loop, started_at, anchor_time, position, round,
       event_json, queue_json, playback_generation, updated_at
     )
     VALUES ($1, $2, false, false, $3, $3, 0, 1, NULL, '[]'::jsonb, 1, to_timestamp($3 / 1000.0))
     ON CONFLICT (station_id) DO NOTHING`,
    [STATION_ID, initial.clipId, now],
  )
}

async function lockedStation(client: PoolClient, library: Clip[], now: number) {
  await initializeStation(client, library, now)
  const result = await client.query<StationRow>(
    `SELECT s.revision, s.next_command_seq, b.clip_id, b.paused, b.loop, b.started_at,
            b.anchor_time, b.position, b.round, b.event_json, b.queue_json,
            b.playback_generation
       FROM stations s
       JOIN broadcast_state b ON b.station_id = s.id
      WHERE s.id = $1
      FOR UPDATE OF s, b`,
    [STATION_ID],
  )
  if (!result.rows[0]) throw new Error('The shared station is unavailable.')
  const row = result.rows[0]
  const input = engineFromRow(row)
  const state = materializeEngineState(input, library, now)
  let generation = Number(row.playback_generation)
  if (state.revision !== input.revision) {
    generation++
    await saveEngine(client, state, generation, Number(row.next_command_seq), now)
  }
  return {
    state,
    generation,
    nextCommandSeq: Number(row.next_command_seq),
  }
}

export class HostedStore {
  private readonly deviceSync: DeviceSyncStore

  constructor(
    private readonly catalog: HostedCatalog,
    deviceSync = new DeviceSyncStore(),
  ) {
    this.deviceSync = deviceSync
  }

  get library() {
    return controllerLibrary(this.catalog)
  }

  async createSession(now = Date.now()) {
    const id = randomUUID()
    const token = randomToken()
    const csrf = keyedHash(hostedConfig().sessionPepper, `csrf:${token}`)
    await hostedPool().query(
      `INSERT INTO admin_sessions (
         id, token_hash, csrf_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at
       )
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0),
               to_timestamp(($4 + $5) / 1000.0), to_timestamp(($4 + $6) / 1000.0))`,
      [id, sha256(token), sha256(csrf), now, 12 * 60 * 60_000, 7 * 24 * 60 * 60_000],
    )
    return { id, token, csrf, expiresAt: now + 7 * 24 * 60 * 60_000 }
  }

  csrfForToken(token: string) {
    return keyedHash(hostedConfig().sessionPepper, `csrf:${token}`)
  }

  async session(token: string | undefined, now = Date.now()) {
    if (!token) return undefined
    const result = await hostedPool().query<SessionRow>(
      `SELECT id, csrf_hash, idle_expires_at, absolute_expires_at
         FROM admin_sessions
        WHERE token_hash = $1 AND revoked_at IS NULL
          AND idle_expires_at > to_timestamp($2 / 1000.0)
          AND absolute_expires_at > to_timestamp($2 / 1000.0)`,
      [sha256(token), now],
    )
    const session = result.rows[0]
    if (!session) return undefined
    await hostedPool().query(
      `UPDATE admin_sessions
          SET last_seen_at = to_timestamp($2 / 1000.0),
              idle_expires_at = LEAST(absolute_expires_at, to_timestamp(($2 + $3) / 1000.0))
        WHERE id = $1 AND last_seen_at < to_timestamp(($2 - 60000) / 1000.0)`,
      [session.id, now, 12 * 60 * 60_000],
    )
    return {
      id: session.id,
      csrfHash: session.csrf_hash,
      expiresAt: Math.min(session.idle_expires_at.getTime(), session.absolute_expires_at.getTime()),
    }
  }

  async revokeSession(id: string) {
    await hostedPool().query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [id])
  }

  async revokeAllSessions() {
    await hostedPool().query('UPDATE admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL')
  }

  async rateLimit(scope: string, subject: string, maxFailures: number, windowMs: number, now = Date.now()) {
    const subjectHash = keyedHash(hostedConfig().rateLimitKey, subject)
    const result = await hostedPool().query<{ failures: number; window_started_at: Date; blocked_until: Date | null }>(
      `SELECT failures, window_started_at, blocked_until
         FROM auth_rate_limits WHERE scope = $1 AND subject_hash = $2`,
      [scope, subjectHash],
    )
    const row = result.rows[0]
    if (!row || row.window_started_at.getTime() + windowMs <= now) return { allowed: true, subjectHash }
    const windowEndsAt = row.window_started_at.getTime() + windowMs
    const retryAt = Math.max(windowEndsAt, row.blocked_until?.getTime() ?? 0)
    return {
      allowed: row.failures < maxFailures && (!row.blocked_until || row.blocked_until.getTime() <= now),
      retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      subjectHash,
    }
  }

  async recordRateLimitFailure(
    scope: string,
    subjectHash: string,
    maxFailures: number,
    windowMs: number,
    now = Date.now(),
  ) {
    await hostedPool().query(
      `INSERT INTO auth_rate_limits (scope, subject_hash, window_started_at, failures, blocked_until)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 1, NULL)
       ON CONFLICT (scope, subject_hash) DO UPDATE SET
         failures = CASE
           WHEN auth_rate_limits.window_started_at <= to_timestamp(($3 - $5) / 1000.0) THEN 1
           ELSE auth_rate_limits.failures + 1
         END,
         window_started_at = CASE
           WHEN auth_rate_limits.window_started_at <= to_timestamp(($3 - $5) / 1000.0)
             THEN to_timestamp($3 / 1000.0)
           ELSE auth_rate_limits.window_started_at
         END,
         blocked_until = CASE
           WHEN auth_rate_limits.failures + 1 >= $4
             THEN to_timestamp(($3 + LEAST($5, 1000 * power(2, LEAST(auth_rate_limits.failures, 10)))) / 1000.0)
           ELSE auth_rate_limits.blocked_until
         END`,
      [scope, subjectHash, now, maxFailures, windowMs],
    )
  }

  async clearRateLimit(scope: string, subjectHash: string) {
    await hostedPool().query('DELETE FROM auth_rate_limits WHERE scope = $1 AND subject_hash = $2', [scope, subjectHash])
  }

  async audit(
    eventType: string,
    detail: Record<string, unknown>,
    sessionId?: string,
    badgeId?: string,
    now = Date.now(),
  ) {
    await hostedPool().query(
      `INSERT INTO audit_events (id, event_type, badge_id, session_id, detail_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0))`,
      [randomUUID(), eventType, badgeId ?? null, sessionId ?? null, JSON.stringify(detail), now],
    )
  }

  async station(now = Date.now()): Promise<HostedSnapshot> {
    return transaction(async (client) => {
      const { state, generation, nextCommandSeq } = await lockedStation(client, this.library, now)
      return {
        broadcast: broadcastFromEngine(state),
        revision: state.revision,
        commandSeq: nextCommandSeq - 1,
        playbackGeneration: generation,
      }
    })
  }

  async command(command: Command, requestId: string, expectedRevision: number, now = Date.now()) {
    const fingerprint = JSON.stringify(command)
    return transaction(async (client) => {
      const current = await lockedStation(client, this.library, now)
      const existing = await client.query<{ fingerprint: string; response_json: HostedSnapshot }>(
        'SELECT fingerprint, response_json FROM commands WHERE station_id = $1 AND request_id = $2',
        [STATION_ID, requestId],
      )
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint) {
          const conflict = new Error('Request ID already belongs to a different command.')
          Object.assign(conflict, { status: 409 })
          throw conflict
        }
        return existing.rows[0].response_json
      }
      if (current.state.revision !== expectedRevision) {
        const conflict = new Error('The station changed. Refresh and try again.')
        Object.assign(conflict, {
          status: 409,
          current: {
            broadcast: broadcastFromEngine(current.state),
            revision: current.state.revision,
            commandSeq: current.nextCommandSeq - 1,
            playbackGeneration: current.generation,
          },
        })
        throw conflict
      }
      const next = applyEngineCommand(current.state, this.library, command, now)
      const commandSeq = current.nextCommandSeq
      const generation = current.generation + 1
      const response: HostedSnapshot = {
        broadcast: broadcastFromEngine(next),
        revision: next.revision,
        commandSeq,
        playbackGeneration: generation,
      }
      await saveEngine(client, next, generation, commandSeq + 1, now)
      await client.query(
        `INSERT INTO commands (
           station_id, command_seq, request_id, fingerprint, action_json,
           resulting_revision, response_json, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))`,
        [STATION_ID, commandSeq, requestId, fingerprint, command, next.revision, response, now],
      )
      return response
    })
  }

  async badges(now = Date.now()): Promise<HostedBadge[]> {
    const result = await hostedPool().query<BadgeRow & {
      last_seen_at: Date | null
      firmware_version: string | null
      known_station_revision: string | null
      fps: number | null
      station_revision: string | null
      command_seq: string | null
      playback_generation: string | null
      frame_id: string | null
      last_error_code: string | null
    }>(
      `SELECT b.id, b.label, b.claimed_at, b.revoked_at, b.created_at, b.updated_at,
              p.last_seen_at, p.firmware_version, p.known_station_revision, p.fps, p.last_error_code,
              r.station_revision, r.command_seq, r.playback_generation, r.frame_id
         FROM badges b
         LEFT JOIN badge_presence p ON p.badge_id = b.id
         LEFT JOIN badge_receipts r ON r.badge_id = b.id
        ORDER BY b.created_at, b.id`,
    )
    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      claimed: Boolean(row.claimed_at),
      revoked: Boolean(row.revoked_at),
      claimedAt: row.claimed_at?.getTime() ?? null,
      revokedAt: row.revoked_at?.getTime() ?? null,
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
      online: Boolean(row.last_seen_at && now - row.last_seen_at.getTime() < 15_000),
      lastSeenAt: row.last_seen_at?.getTime() ?? null,
      firmwareVersion: row.firmware_version,
      fps: row.fps ?? 0,
      lastStationRevision: row.station_revision === null
        ? (row.known_station_revision === null ? null : Number(row.known_station_revision))
        : Number(row.station_revision),
      lastCommandSeq: row.command_seq === null ? null : Number(row.command_seq),
      lastPlaybackGeneration: row.playback_generation === null ? null : Number(row.playback_generation),
      lastAssetFrameId: row.frame_id === null ? null : Number(row.frame_id),
      lastErrorCode: row.last_error_code,
    }))
  }

  async createBadge(label: string, now = Date.now()) {
    const badgeId = randomUUID()
    const badgeSecret = randomToken(32)
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO badges (id, label, created_at, updated_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))`,
        [badgeId, label, now],
      )
      await client.query(
        `INSERT INTO badge_credentials (id, badge_id, secret_hmac, valid_from)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
        [randomUUID(), badgeId, keyedHash(hostedConfig().deviceKey, badgeSecret), now],
      )
    })
    return { badgeId, badgeSecret }
  }

  async claimBadge(code: string, now = Date.now()) {
    const codeHmac = keyedHash(hostedConfig().claimKey, code)
    return transaction(async (client) => {
      const result = await client.query<{ id: string; badge_id: string }>(
        `SELECT c.id, c.badge_id
           FROM badge_claims c
           JOIN badges b ON b.id = c.badge_id
          WHERE c.code_hmac = $1 AND c.consumed_at IS NULL
            AND c.expires_at > to_timestamp($2 / 1000.0)
            AND b.revoked_at IS NULL
          FOR UPDATE OF c, b`,
        [codeHmac, now],
      )
      const claim = result.rows[0]
      if (!claim) return undefined
      await client.query(
        `UPDATE badge_claims
            SET consumed_at = to_timestamp($2 / 1000.0)
          WHERE badge_id = $1 AND consumed_at IS NULL`,
        [claim.badge_id, now],
      )
      await client.query(
        `UPDATE badges
            SET claimed_at = COALESCE(claimed_at, to_timestamp($2 / 1000.0)),
                updated_at = to_timestamp($2 / 1000.0)
          WHERE id = $1`,
        [claim.badge_id, now],
      )
      return claim.badge_id
    })
  }

  async revokeBadge(badgeId: string, now = Date.now()) {
    return transaction(async (client) => {
      const badge = await client.query(
        `UPDATE badges
            SET revoked_at = COALESCE(revoked_at, to_timestamp($2 / 1000.0)),
                updated_at = to_timestamp($2 / 1000.0)
          WHERE id = $1
          RETURNING id`,
        [badgeId, now],
      )
      if (!badge.rowCount) return false
      await client.query(
        `UPDATE badge_credentials
            SET revoked_at = COALESCE(revoked_at, to_timestamp($2 / 1000.0))
          WHERE badge_id = $1`,
        [badgeId, now],
      )
      await client.query(
        `UPDATE badge_claims
            SET consumed_at = COALESCE(consumed_at, to_timestamp($2 / 1000.0))
          WHERE badge_id = $1`,
        [badgeId, now],
      )
      return true
    })
  }

  async rotateBadge(badgeId: string, now = Date.now()) {
    const badgeSecret = randomToken(32)
    return transaction(async (client) => {
      const badge = await client.query(
        'SELECT 1 FROM badges WHERE id = $1 AND revoked_at IS NULL FOR UPDATE',
        [badgeId],
      )
      if (!badge.rowCount) return undefined
      await client.query(
        `UPDATE badge_credentials
            SET valid_until = LEAST(
              COALESCE(valid_until, to_timestamp(($2 + $3) / 1000.0)),
              to_timestamp(($2 + $3) / 1000.0)
            )
          WHERE badge_id = $1 AND revoked_at IS NULL
            AND (valid_until IS NULL OR valid_until > to_timestamp($2 / 1000.0))`,
        [badgeId, now, 24 * 60 * 60_000],
      )
      await client.query(
        `INSERT INTO badge_credentials (id, badge_id, secret_hmac, valid_from)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
        [randomUUID(), badgeId, keyedHash(hostedConfig().deviceKey, badgeSecret), now],
      )
      await client.query(
        'UPDATE badges SET updated_at = to_timestamp($2 / 1000.0) WHERE id = $1',
        [badgeId, now],
      )
      return { badgeId, badgeSecret }
    })
  }

  authenticateBadge(badgeId: string, badgeSecret: string, now = Date.now()) {
    return this.deviceSync.authenticate(badgeId, badgeSecret, now)
  }

  issueBadgeClaimCode(badgeId: string, now = Date.now()) {
    return this.deviceSync.issueClaimCode(badgeId, now)
  }

  recordDeviceSync(badgeId: string, report: DeviceSyncReport, now = Date.now()) {
    return this.deviceSync.recordSync(badgeId, report, now)
  }

  consumeDeviceSyncLimit(
    badgeId: string,
    maximum: number,
    windowMs: number,
    now = Date.now(),
  ) {
    return this.deviceSync.consumeLimit(badgeId, maximum, windowMs, now)
  }

  async stationState(now = Date.now()): Promise<StationState> {
    const [station, badges] = await Promise.all([this.station(now), this.badges(now)])
    const devices: BadgeDevice[] = badges
      .filter((badge) => badge.claimed && !badge.revoked)
      .map((badge) => ({
        id: badge.id,
        lastSeen: badge.lastSeenAt ?? 0,
        lastFrameAt: badge.lastSeenAt,
        frameId: badge.lastAssetFrameId,
        fps: badge.fps,
        online: badge.online,
        awaitingPairing: false,
        format: 'png',
      }))
    return {
      library: this.library,
      broadcast: station.broadcast,
      devices,
      server: {
        name: 'Underhive Broadcast',
        version: '0.2.0',
        width: 160,
        height: 120,
        fps: 8,
        addresses: [hostedConfig().appOrigin],
        now,
      },
    }
  }
}
