import assert from 'node:assert/strict'
import test from 'node:test'
import {
  badgeInstallMode,
  hostedBadgeState,
  hostedServiceOrigin,
  redactBadgeSecret,
  trustedTimeState,
} from './badge-install.ts'

const badgeId = '11111111-1111-4111-8111-111111111111'
const badgeSecret = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

test('local installation remains the default', () => {
  assert.equal(badgeInstallMode(undefined), 'local')
  assert.equal(badgeInstallMode(''), 'local')
  assert.equal(badgeInstallMode('local'), 'local')
  assert.equal(badgeInstallMode('hosted'), 'hosted')
  assert.throws(() => badgeInstallMode('remote'), /local or hosted/)
})

test('hosted provisioning accepts only the approved origin and credential shapes', () => {
  assert.deepEqual(hostedBadgeState(hostedServiceOrigin, badgeId, badgeSecret), {
    schema: 1,
    mode: 'hosted',
    serviceOrigin: hostedServiceOrigin,
    badgeId,
    badgeSecret,
  })
  for (const origin of [
    'http://badger-munda.vercel.app',
    'https://badger-munda.vercel.app/path',
    'https://example.vercel.app',
  ]) {
    assert.throws(() => hostedBadgeState(origin, badgeId, badgeSecret), /approved HTTPS origin/)
  }
  assert.throws(
    () => hostedBadgeState(hostedServiceOrigin, badgeId, `${badgeSecret}x`),
    /32-byte base64url secret/,
  )
})

test('installer diagnostics can redact the badge secret', () => {
  const message = `failed Authorization: Badge ${badgeId}.${badgeSecret}`
  const redacted = redactBadgeSecret(message, badgeSecret)
  assert.equal(redacted.includes(badgeSecret), false)
  assert.match(redacted, /\[REDACTED\]/)
})

test('trusted time uses a bounded Unix timestamp', () => {
  assert.deepEqual(trustedTimeState(new Date('2026-09-24T16:00:00Z')), {
    schema: 1,
    unixSeconds: 1_790_265_600,
  })
  assert.throws(
    () => trustedTimeState(new Date('2020-01-01T00:00:00Z')),
    /cannot seed trusted badge time/,
  )
})
