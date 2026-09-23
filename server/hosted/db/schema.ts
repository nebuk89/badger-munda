import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const adminSessions = pgTable('admin_sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  csrfHash: text('csrf_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const authRateLimits = pgTable('auth_rate_limits', {
  scope: text('scope').notNull(),
  subjectHash: text('subject_hash').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  failures: integer('failures').notNull().default(0),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }),
}, (table) => [
  uniqueIndex('auth_rate_limits_scope_subject').on(table.scope, table.subjectHash),
])

export const stations = pgTable('stations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  nextCommandSeq: bigint('next_command_seq', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const broadcastState = pgTable('broadcast_state', {
  stationId: text('station_id').primaryKey().references(() => stations.id, { onDelete: 'cascade' }),
  clipId: text('clip_id').notNull(),
  paused: boolean('paused').notNull(),
  loop: boolean('loop').notNull(),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  anchorTime: bigint('anchor_time', { mode: 'number' }).notNull(),
  position: doublePrecision('position').notNull(),
  round: integer('round').notNull(),
  eventJson: jsonb('event_json'),
  queueJson: jsonb('queue_json').notNull(),
  playbackGeneration: bigint('playback_generation', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const commands = pgTable('commands', {
  stationId: text('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
  commandSeq: bigint('command_seq', { mode: 'number' }).notNull(),
  requestId: text('request_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  actionJson: jsonb('action_json').notNull(),
  resultingRevision: bigint('resulting_revision', { mode: 'number' }).notNull(),
  responseJson: jsonb('response_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex('commands_station_request').on(table.stationId, table.requestId),
  uniqueIndex('commands_station_sequence').on(table.stationId, table.commandSeq),
])

export const badges = pgTable('badges', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const badgeCredentials = pgTable('badge_credentials', {
  id: text('id').primaryKey(),
  badgeId: text('badge_id').notNull().references(() => badges.id, { onDelete: 'cascade' }),
  secretHmac: text('secret_hmac').notNull().unique(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  firstUsedAt: timestamp('first_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const badgeClaims = pgTable('badge_claims', {
  id: text('id').primaryKey(),
  badgeId: text('badge_id').notNull().references(() => badges.id, { onDelete: 'cascade' }),
  codeHmac: text('code_hmac').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const badgeStatus = pgTable('badge_status', {
  badgeId: text('badge_id').primaryKey().references(() => badges.id, { onDelete: 'cascade' }),
  bootId: text('boot_id'),
  firmwareVersion: text('firmware_version'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  lastStationRevision: bigint('last_station_revision', { mode: 'number' }),
  lastCommandSeq: bigint('last_command_seq', { mode: 'number' }),
  lastPlaybackGeneration: bigint('last_playback_generation', { mode: 'number' }),
  lastAssetFrameId: bigint('last_asset_frame_id', { mode: 'number' }),
  fps: doublePrecision('fps'),
  lastErrorCode: text('last_error_code'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const contentVersions = pgTable('content_versions', {
  id: text('id').primaryKey(),
  catalogHash: text('catalog_hash').notNull().unique(),
  blobPrefix: text('blob_prefix').notNull(),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  badgeId: text('badge_id'),
  sessionId: text('session_id'),
  detailJson: jsonb('detail_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})
