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

export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  sessionId: text('session_id'),
  detailJson: jsonb('detail_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})
