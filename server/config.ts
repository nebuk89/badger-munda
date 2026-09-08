import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

export const configSchema = z.object({
  version: z.literal(1),
  controllerPin: z.string().regex(/^\d{6}$/),
  deviceToken: z.string().regex(/^[a-f0-9]{64}$/),
})
export type StationConfig = z.infer<typeof configSchema>

export function writePrivateJson(filename: string, value: unknown) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temp = `${filename}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, filename)
}

export function loadConfig(dataDir: string): StationConfig {
  const filename = path.join(dataDir, 'config.json')
  if (existsSync(filename)) return configSchema.parse(JSON.parse(readFileSync(filename, 'utf8')))
  const config: StationConfig = {
    version: 1,
    controllerPin: randomInt(100000, 1000000).toString(),
    deviceToken: randomBytes(32).toString('hex'),
  }
  writePrivateJson(filename, config)
  return config
}

export function equalSecret(actual: string, expected: string) {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function localAddresses(port: number) {
  const addresses = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        addresses.add(`http://${entry.address}:${port}`)
      }
    }
  }
  return [...addresses]
}

export function allowedHosts(port: number) {
  return new Set([
    'localhost', '127.0.0.1', '[::1]', hostname().toLowerCase(),
    ...localAddresses(port).map((url) => new URL(url).hostname),
  ])
}
