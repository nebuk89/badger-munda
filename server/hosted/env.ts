export function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function publicHttpsUrl(name: string) {
  const url = new URL(requiredEnv(name))
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must be a public HTTPS URL without credentials, a query, or a fragment.`)
  }
  return url
}

export interface HostedContentConfig {
  catalogUrl: URL
  blobBaseUrl: URL
}

export function hostedConfig() {
  const blobBaseUrl = publicHttpsUrl('CONTENT_BLOB_BASE_URL')
  blobBaseUrl.pathname = `${blobBaseUrl.pathname.replace(/\/+$/, '')}/`
  return {
    appOrigin: new URL(requiredEnv('APP_ORIGIN')).origin,
    adminPasswordHash: requiredEnv('ADMIN_PASSWORD_HASH'),
    sessionPepper: requiredEnv('SESSION_TOKEN_PEPPER'),
    rateLimitKey: requiredEnv('IP_RATE_LIMIT_HMAC_KEY'),
    claimKey: requiredEnv('CLAIM_CODE_HMAC_KEY'),
    deviceKey: requiredEnv('DEVICE_SECRET_HMAC_KEY'),
    catalogUrl: publicHttpsUrl('CONTENT_CATALOG_URL'),
    blobBaseUrl,
  }
}
