import { copyFile, mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'

const dataDir = await mkdtemp(path.join(tmpdir(), 'underhive-browser-'))
await mkdir(path.join(dataDir, 'library'))
for (const entry of await readdir(path.resolve('data/library'), { withFileTypes: true })) {
  if (entry.isDirectory() && !entry.name.startsWith('.')) {
    const target = path.join(dataDir, 'library', entry.name)
    await mkdir(target)
    await copyFile(path.resolve('data/library', entry.name, 'manifest.json'), path.join(target, 'manifest.json'))
    for (const file of ['frames', 'poster.png', 'video.mp4']) {
      await symlink(path.resolve('data/library', entry.name, file), path.join(target, file))
    }
  }
}
const config = loadConfig(dataDir)
config.controllerPin = '314159'
const { app } = await createApp({ dataDir, config, port: 18787 })
const server = app.listen(18787, '127.0.0.1')
async function close() {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dataDir, { recursive: true, force: true })
}
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
