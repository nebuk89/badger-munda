import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { loadConfig, localAddresses } from '../server/config.ts'

const root = path.resolve(import.meta.dirname, '..')
const mount = path.resolve(process.env.BADGE_MOUNT ?? '/Volumes/BADGER')
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'))
if (!existsSync(path.join(mount, 'main.py')) || !existsSync(path.join(mount, 'apps', 'menu', 'icon.py'))) {
  throw new Error('The MonaOS BADGER drive is not mounted. Press RESET twice to enter USB Disk Mode.')
}
if (!statSync(mount).isDirectory()) throw new Error('BADGE_MOUNT must point to the mounted badge drive.')

const addresses = localAddresses(Number(process.env.PORT ?? 8787))
const serverUrl = process.env.SERVER_URL ?? (addresses.length === 1 ? addresses[0] : undefined)
if (!serverUrl) throw new Error('Set SERVER_URL to the Mac address that the badge can reach.')
const address = new URL(serverUrl)
if (address.protocol !== 'http:' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address.hostname)
  || address.hostname.split('.').some((part) => Number(part) > 255) || address.pathname !== '/'
  || address.search || address.hash || address.username || address.password) {
  throw new Error('SERVER_URL must be an HTTP numeric IPv4 address, with an optional port.')
}
const config = loadConfig(dataDir)
const source = path.join(root, 'badge', 'apps', 'underhive')
const modules = ['renderer.py', 'transport.py', 'protocol.py', '__init__.py']
for (const file of modules) if (!existsSync(path.join(source, file))) throw new Error(`Missing badge source: ${file}`)
const menu = readFileSync(path.join(root, 'device', 'menu.py'))
const backup = path.join(dataDir, 'backups', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
cpSync(mount, backup, { recursive: true, errorOnExist: true, force: false })

function atomicWrite(filename: string, content: Buffer | string) {
  writeFileSync(`${filename}.tmp`, content)
  renameSync(`${filename}.tmp`, filename)
}

const target = path.join(mount, 'apps', 'underhive')
mkdirSync(target, { recursive: true })
for (const file of modules) atomicWrite(path.join(target, file), readFileSync(path.join(source, file)))
atomicWrite(path.join(target, 'config.py'), [
  '# Private installed settings. Wi-Fi credentials stay in /secrets.py.',
  `SERVER_URL = ${JSON.stringify(address.origin)}`,
  `DEVICE_TOKEN = ${JSON.stringify(config.deviceToken)}`,
  'DEVICE_ID = "desk-badge"',
  'FRAME_FORMAT = "png"',
  'TARGET_FPS = 8',
  '',
].join('\n'))
const icon = await sharp(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="2" y="5" width="20" height="15" rx="3" fill="#edc353"/><rect x="5" y="8" width="13" height="9" rx="1" fill="#20251b"/><path d="m9 11 5 2-5 2z" fill="#edc353"/><path d="m8 1 4 4 4-4" stroke="#edc353" stroke-width="2" fill="none"/></svg>',
)).png().toBuffer()
atomicWrite(path.join(target, 'icon.png'), icon)
// Make the new entry accessible only after all app files are in place.
atomicWrite(path.join(mount, 'apps', 'menu', '__init__.py'), menu)
console.log(`Installed Underhive at ${target}`)
console.log(`Backup: ${backup}`)
console.log(`Server: ${address.origin}`)
console.log('Wi-Fi settings and firmware are unchanged. Eject BADGER, press RESET, then select underhive on menu page 2.')
