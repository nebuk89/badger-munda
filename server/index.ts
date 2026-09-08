import path from 'node:path'
import { createApp } from './app.ts'
import { loadConfig, localAddresses } from './config.ts'

const port = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.')
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data')
const config = loadConfig(dataDir)
const { app } = await createApp({ dataDir, config, port })
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`\nUNDERHIVE BROADCAST\nMac: http://localhost:${port}`)
  for (const address of localAddresses(port)) console.log(`Phone: ${address}`)
  console.log(`Pairing code: ${config.controllerPin}\nKeep this terminal open. Use a trusted local network.\n`)
})
server.on('error', (error) => { console.error(`Station could not start: ${error.message}`); process.exitCode = 1 })
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { server.close(); server.closeAllConnections() })
}
