import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { loadConfig, localAddresses } from '../server/config.ts'
import {
  badgeInstallMode,
  hostedBadgeState,
  hostedServiceOrigin,
  redactBadgeSecret,
  trustedTimeState,
} from './badge-install.ts'

const badgeSecret = process.env.BADGE_SECRET

function reportFatal(error: unknown) {
  const message = error instanceof Error ? error.message : error
  console.error(redactBadgeSecret(message, badgeSecret))
  process.exit(1)
}

process.on('uncaughtException', reportFatal)
process.on('unhandledRejection', reportFatal)

const root = path.resolve(import.meta.dirname, '..')
const mount = path.resolve(process.env.BADGE_MOUNT ?? '/Volumes/BADGER')
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'))
if (!existsSync(path.join(mount, 'main.py')) || !existsSync(path.join(mount, 'apps', 'menu', 'icon.py'))) {
  throw new Error('The MonaOS BADGER drive is not mounted. Press RESET twice to enter USB Disk Mode.')
}
if (!statSync(mount).isDirectory()) throw new Error('BADGE_MOUNT must point to the mounted badge drive.')

const rotation = process.env.BADGE_ROTATION ?? '180'
if (!['0', '180'].includes(rotation)) throw new Error('BADGE_ROTATION must be 0 or 180.')
const mode = badgeInstallMode(process.env.BADGE_MODE)
let address: URL | undefined
let localDeviceToken: string | undefined
let hostedState: ReturnType<typeof hostedBadgeState> | undefined
let hostedTimeState: ReturnType<typeof trustedTimeState> | undefined
if (mode === 'local') {
  const addresses = localAddresses(Number(process.env.PORT ?? 8787))
  const serverUrl = process.env.SERVER_URL ?? (addresses.length === 1 ? addresses[0] : undefined)
  if (!serverUrl) throw new Error('Set SERVER_URL to the Mac address that the badge can reach.')
  address = new URL(serverUrl)
  if (address.protocol !== 'http:' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address.hostname)
    || address.hostname.split('.').some((part) => Number(part) > 255) || address.pathname !== '/'
    || address.search || address.hash || address.username || address.password) {
    throw new Error('SERVER_URL must be an HTTP numeric IPv4 address, with an optional port.')
  }
  localDeviceToken = loadConfig(dataDir).deviceToken
} else {
  if (!process.env.BADGE_ID || !badgeSecret) {
    throw new Error('Set BADGE_ID and BADGE_SECRET for hosted provisioning.')
  }
  hostedState = hostedBadgeState(
    process.env.HOSTED_SERVICE_ORIGIN ?? hostedServiceOrigin,
    process.env.BADGE_ID,
    badgeSecret,
  )
  hostedTimeState = trustedTimeState()
}
const source = path.join(root, 'badge', 'apps', 'underhive')
const modules = [
  'defaults.py',
  'hosted_client.py',
  'hosted_config.py',
  'hosted_protocol.py',
  'hosted_transport.py',
  'onboarding.py',
  'protocol.py',
  'renderer.py',
  'setup_http.py',
  'state_store.py',
  'transport.py',
  'trusted_time.py',
  'wifi_manager.py',
  '__init__.py',
  'gts-roots.pem',
]
for (const file of modules) if (!existsSync(path.join(source, file))) throw new Error(`Missing badge source: ${file}`)
const menu = readFileSync(path.join(root, 'device', 'menu.py'))
const backup = path.join(dataDir, 'backups', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
cpSync(mount, backup, { recursive: true, errorOnExist: true, force: false })

function atomicWrite(filename: string, content: Buffer | string) {
  writeFileSync(`${filename}.tmp`, content)
  renameSync(`${filename}.tmp`, filename)
}

function removeIfPresent(filename: string) {
  try {
    unlinkSync(filename)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

const target = path.join(mount, 'apps', 'underhive')
mkdirSync(target, { recursive: true })
for (const file of modules) atomicWrite(path.join(target, file), readFileSync(path.join(source, file)))
const installedConfig = path.join(target, 'config.py')
if (mode === 'local') {
  atomicWrite(installedConfig, [
    '# Private installed settings. Wi-Fi credentials stay in /system/secrets.py.',
    `SERVER_URL = ${JSON.stringify(address!.origin)}`,
    `DEVICE_TOKEN = ${JSON.stringify(localDeviceToken)}`,
    'DEVICE_ID = "desk-badge"',
    'FRAME_FORMAT = "png"',
    'TARGET_FPS = 8',
    `DISPLAY_ROTATION = ${rotation}`,
    '',
  ].join('\n'))
} else if (!existsSync(installedConfig)) {
  atomicWrite(installedConfig, readFileSync(path.join(source, 'config.py')))
}
if (hostedState) {
  const stateDir = path.join(mount, 'state', 'underhive')
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(
    path.join(stateDir, 'trusted-time.v1.json'),
    `${JSON.stringify(hostedTimeState)}\n`,
  )
  const hostedFile = path.join(stateDir, 'hosted.v1.json')
  atomicWrite(hostedFile, `${JSON.stringify(hostedState)}\n`)
  for (const suffix of ['.new', '.bak']) removeIfPresent(`${hostedFile}${suffix}`)
}
const icon = await sharp(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="2" y="5" width="20" height="15" rx="3" fill="#edc353"/><rect x="5" y="8" width="13" height="9" rx="1" fill="#20251b"/><path d="m9 11 5 2-5 2z" fill="#edc353"/><path d="m8 1 4 4 4-4" stroke="#edc353" stroke-width="2" fill="none"/></svg>',
)).png().toBuffer()
atomicWrite(path.join(target, 'icon.png'), icon)
// Make the new entry accessible only after all app files are in place.
atomicWrite(path.join(mount, 'apps', 'menu', '__init__.py'), menu)
console.log(`Installed Underhive at ${target}`)
console.log(`Backup: ${backup}`)
if (mode === 'local') {
  console.log(`Mode: local`)
  console.log(`Server: ${address!.origin}`)
} else {
  console.log('Mode: hosted foundation')
  console.log(`Service: ${hostedState!.serviceOrigin}`)
  console.log(`Badge ID: ${hostedState!.badgeId}`)
}
console.log(`Badge display rotation: ${rotation} degrees`)
console.log('Wi-Fi settings and firmware are unchanged. Eject BADGER, press RESET, then select underhive on menu page 2.')
