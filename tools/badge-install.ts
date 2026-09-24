export const hostedServiceOrigin = 'https://badger-munda.vercel.app'

const badgeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const badgeSecretPattern = /^[A-Za-z0-9_-]{43}$/

export type BadgeInstallMode = 'local' | 'hosted'

export function badgeInstallMode(value: string | undefined): BadgeInstallMode {
  if (value === undefined || value === '' || value === 'local') return 'local'
  if (value === 'hosted') return 'hosted'
  throw new Error('BADGE_MODE must be local or hosted.')
}

export function hostedBadgeState(origin: string, badgeId: string, badgeSecret: string) {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error('HOSTED_SERVICE_ORIGIN must be the approved HTTPS origin.')
  }
  if (parsed.origin !== hostedServiceOrigin || parsed.href !== `${hostedServiceOrigin}/`) {
    throw new Error('HOSTED_SERVICE_ORIGIN must be the approved HTTPS origin.')
  }
  if (!badgeIdPattern.test(badgeId)) throw new Error('BADGE_ID must be a canonical UUID.')
  if (!badgeSecretPattern.test(badgeSecret)) {
    throw new Error('BADGE_SECRET must be a 32-byte base64url secret.')
  }
  return {
    schema: 1,
    mode: 'hosted',
    serviceOrigin: parsed.origin,
    badgeId,
    badgeSecret,
  } as const
}

export function trustedTimeState(now = new Date()) {
  const unixSeconds = Math.floor(now.getTime() / 1000)
  if (!Number.isSafeInteger(unixSeconds)
    || unixSeconds < 1_735_689_600
    || unixSeconds > 4_102_444_800) {
    throw new Error('The workstation clock cannot seed trusted badge time.')
  }
  return { schema: 1, unixSeconds } as const
}

export function redactBadgeSecret(value: unknown, badgeSecret: string | undefined) {
  const text = String(value)
  return badgeSecret ? text.replaceAll(badgeSecret, '[REDACTED]') : text
}
