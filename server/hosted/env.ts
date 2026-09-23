export function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

export function hostedConfig() {
  return {
    appOrigin: new URL(requiredEnv('APP_ORIGIN')).origin,
    adminPasswordHash: requiredEnv('ADMIN_PASSWORD_HASH'),
    sessionPepper: requiredEnv('SESSION_TOKEN_PEPPER'),
    claimKey: requiredEnv('CLAIM_CODE_HMAC_KEY'),
    deviceKey: requiredEnv('DEVICE_SECRET_HMAC_KEY'),
    rateLimitKey: requiredEnv('IP_RATE_LIMIT_HMAC_KEY'),
    catalogUrl: requiredEnv('CONTENT_CATALOG_URL'),
    blobBaseUrl: requiredEnv('CONTENT_BLOB_BASE_URL').replace(/\/+$/, ''),
  }
}
