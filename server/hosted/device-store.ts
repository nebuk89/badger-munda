import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { keyedHash } from './crypto.ts'
import { hostedPool, transaction } from './db/client.ts'
import { hostedConfig } from './env.ts'

interface QueryResult<Row> {
  rows: Row[]
  rowCount: number | null
}

export interface DeviceQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>
}

export interface DeviceDatabase extends DeviceQueryable {
  transaction<T>(run: (client: DeviceQueryable) => Promise<T>): Promise<T>
}

function queryable(client: PoolClient): DeviceQueryable {
  return {
    query: async <Row extends QueryResultRow>(text: string, values?: unknown[]) => {
      const result = await client.query<Row>(text, values)
      return { rows: result.rows, rowCount: result.rowCount }
    },
  }
}

function postgresDatabase(): DeviceDatabase {
  return {
    query: async <Row extends QueryResultRow>(text: string, values?: unknown[]) => {
      const result = await hostedPool().query<Row>(text, values)
      return { rows: result.rows, rowCount: result.rowCount }
    },
    transaction: (run) => transaction((client) => run(queryable(client))),
  }
}

export interface DeviceReceipt {
  stationRevision: number
  commandSeq: number
  playbackGeneration: number
  frameId: number
}

export interface DeviceSyncReport {
  bootId: string
  firmwareVersion: string
  knownStationRevision?: number
  lastReceipt?: DeviceReceipt
  fps?: number
  errorCode?: string | null
}

export interface AuthenticatedBadge {
  id: string
  claimedAt: number | null
}

function claimCodeFor(id: string, claimKey: string) {
  const value = BigInt(`0x${keyedHash(claimKey, id).slice(0, 16)}`) % 1_000_000n
  return value.toString().padStart(6, '0')
}

export class DeviceSyncStore {
  constructor(
    private readonly database: DeviceDatabase = postgresDatabase(),
    private readonly deviceKey = hostedConfig().deviceKey,
    private readonly claimKey = hostedConfig().claimKey,
  ) {}

  async authenticate(badgeId: string, badgeSecret: string, now = Date.now()) {
    const result = await this.database.query<{
      id: string
      claimed_at: Date | null
      credential_id: string
      first_used_at: Date | null
    }>(
      `SELECT b.id, b.claimed_at, c.id AS credential_id, c.first_used_at
         FROM badges b
         JOIN badge_credentials c ON c.badge_id = b.id
        WHERE b.id = $1
          AND b.revoked_at IS NULL
          AND c.secret_hmac = $2
          AND c.revoked_at IS NULL
          AND c.valid_from <= to_timestamp($3 / 1000.0)
          AND (c.valid_until IS NULL OR c.valid_until > to_timestamp($3 / 1000.0))
        LIMIT 1`,
      [badgeId, keyedHash(this.deviceKey, badgeSecret), now],
    )
    const badge = result.rows[0]
    if (!badge) return undefined
    if (!badge.first_used_at) {
      await this.database.query(
        `UPDATE badge_credentials
            SET first_used_at = COALESCE(first_used_at, to_timestamp($2 / 1000.0))
          WHERE id = $1`,
        [badge.credential_id, now],
      )
    }
    return {
      id: badge.id,
      claimedAt: badge.claimed_at?.getTime() ?? null,
    } satisfies AuthenticatedBadge
  }

  async issueClaimCode(badgeId: string, now = Date.now()) {
    return this.database.transaction(async (client) => {
      const badge = await client.query<{ claimed_at: Date | null }>(
        `SELECT claimed_at
           FROM badges
          WHERE id = $1 AND revoked_at IS NULL
          FOR UPDATE`,
        [badgeId],
      )
      if (!badge.rows[0] || badge.rows[0].claimed_at) return undefined
      const existing = await client.query<{ id: string; expires_at: Date }>(
        `SELECT id, expires_at
           FROM badge_claims
          WHERE badge_id = $1
            AND consumed_at IS NULL
            AND expires_at > to_timestamp($2 / 1000.0)
          ORDER BY created_at DESC
          LIMIT 1`,
        [badgeId, now],
      )
      if (existing.rows[0]) {
        return {
          code: claimCodeFor(existing.rows[0].id, this.claimKey),
          expiresAt: existing.rows[0].expires_at.getTime(),
        }
      }
      await client.query('LOCK TABLE badge_claims IN SHARE ROW EXCLUSIVE MODE')
      for (let attempt = 0; attempt < 20; attempt++) {
        const id = randomUUID()
        const code = claimCodeFor(id, this.claimKey)
        const codeHmac = keyedHash(this.claimKey, code)
        const collision = await client.query(
          `SELECT 1
             FROM badge_claims
            WHERE code_hmac = $1
              AND consumed_at IS NULL
              AND expires_at > to_timestamp($2 / 1000.0)`,
          [codeHmac, now],
        )
        if (collision.rowCount) continue
        const expiresAt = now + 10 * 60_000
        await client.query(
          `INSERT INTO badge_claims (id, badge_id, code_hmac, expires_at, created_at)
           VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))`,
          [id, badgeId, codeHmac, expiresAt, now],
        )
        return { code, expiresAt }
      }
      throw new Error('A unique claim code is unavailable.')
    })
  }

  async recordSync(badgeId: string, report: DeviceSyncReport, now = Date.now()) {
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO badge_presence (
           badge_id, boot_id, firmware_version, last_seen_at,
           known_station_revision, fps, last_error_code, updated_at
         )
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7, to_timestamp($4 / 1000.0))
         ON CONFLICT (badge_id) DO UPDATE SET
           boot_id = EXCLUDED.boot_id,
           firmware_version = EXCLUDED.firmware_version,
           last_seen_at = EXCLUDED.last_seen_at,
           known_station_revision = EXCLUDED.known_station_revision,
           fps = EXCLUDED.fps,
           last_error_code = EXCLUDED.last_error_code,
           updated_at = EXCLUDED.updated_at`,
        [
          badgeId,
          report.bootId,
          report.firmwareVersion,
          now,
          report.knownStationRevision ?? null,
          report.fps ?? null,
          report.errorCode ?? null,
        ],
      )
      if (!report.lastReceipt) return
      await client.query(
        `INSERT INTO badge_receipts (
           badge_id, station_revision, command_seq, playback_generation,
           frame_id, received_at
         )
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
         ON CONFLICT (badge_id) DO UPDATE SET
           station_revision = EXCLUDED.station_revision,
           command_seq = EXCLUDED.command_seq,
           playback_generation = EXCLUDED.playback_generation,
           frame_id = EXCLUDED.frame_id,
           received_at = EXCLUDED.received_at`,
        [
          badgeId,
          report.lastReceipt.stationRevision,
          report.lastReceipt.commandSeq,
          report.lastReceipt.playbackGeneration,
          report.lastReceipt.frameId,
          now,
        ],
      )
    })
  }

  async consumeLimit(
    badgeId: string,
    maximum: number,
    windowMs: number,
    now = Date.now(),
  ) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        window_started_at: Date
        request_count: number
        blocked_until: Date | null
      }>(
        `SELECT window_started_at, request_count, blocked_until
           FROM device_sync_limits
          WHERE badge_id = $1
          FOR UPDATE`,
        [badgeId],
      )
      const row = result.rows[0]
      if (!row) {
        await client.query(
          `INSERT INTO device_sync_limits (
             badge_id, window_started_at, request_count, blocked_until
           )
           VALUES ($1, to_timestamp($2 / 1000.0), 1, NULL)`,
          [badgeId, now],
        )
        return { allowed: true }
      }
      const windowEndsAt = row.window_started_at.getTime() + windowMs
      if (windowEndsAt <= now) {
        await client.query(
          `UPDATE device_sync_limits
              SET window_started_at = to_timestamp($2 / 1000.0),
                  request_count = 1,
                  blocked_until = NULL
            WHERE badge_id = $1`,
          [badgeId, now],
        )
        return { allowed: true }
      }
      const blockedUntil = row.blocked_until?.getTime() ?? 0
      if (row.request_count >= maximum || blockedUntil > now) {
        const retryAt = Math.max(windowEndsAt, blockedUntil)
        await client.query(
          `UPDATE device_sync_limits
              SET request_count = LEAST(request_count + 1, $2),
                  blocked_until = to_timestamp($3 / 1000.0)
            WHERE badge_id = $1`,
          [badgeId, maximum + 1, retryAt],
        )
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)),
        }
      }
      await client.query(
        `UPDATE device_sync_limits
            SET request_count = request_count + 1
          WHERE badge_id = $1`,
        [badgeId],
      )
      return { allowed: true }
    })
  }
}
