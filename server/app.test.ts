import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import sharp from 'sharp'
import type { Clip, StationState } from '../shared/types.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

let directory: string
let url: string
let cookie: string
let token: string
let close: () => Promise<void>

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'underhive-test-'))
  const clipDir = path.join(directory, 'library', 'sample')
  await mkdir(path.join(clipDir, 'frames'), { recursive: true })
  const rgba = Buffer.alloc(160 * 120 * 4, 255)
  for (let frame = 0; frame < 4; frame++) await writeFile(path.join(clipDir, 'frames', `000${frame}.rgba`), rgba)
  const clip: Clip = {
    id: 'sample', title: 'Sample', subtitle: '', category: 'advert', duration: 2, fps: 2,
    frameCount: 4, width: 160, height: 120, accent: '#ffffff',
    posterUrl: '/media/sample/poster.png', videoUrl: '/media/sample/video.mp4',
  }
  await writeFile(path.join(clipDir, 'manifest.json'), JSON.stringify(clip))
  const config = loadConfig(directory)
  token = config.deviceToken
  const { app } = await createApp({ dataDir: directory, config, port: 8787 })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  url = `http://127.0.0.1:${address.port}`
  close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
  const response = await fetch(`${url}/api/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: config.controllerPin }),
  })
  assert.equal(response.status, 200)
  cookie = response.headers.get('set-cookie')!.split(';')[0]
})

after(async () => { await close?.(); if (directory) await rm(directory, { recursive: true, force: true }) })

test('state and media require a controller session', async () => {
  assert.equal((await fetch(`${url}/api/state`)).status, 401)
  assert.equal((await fetch(`${url}/media/sample/poster.png`)).status, 401)
  const setup = await (await fetch(`${url}/api/setup`, { headers: { cookie } })).json()
  assert.equal(setup.paired, true)
})

test('device credentials cannot control the browser API', async () => {
  const result = await fetch(`${url}/api/state`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(result.status, 401)
})

test('cross-origin commands and rebinding hosts are blocked', async () => {
  const headers = { cookie, 'Content-Type': 'application/json', origin: 'https://attacker.invalid' }
  const response = await fetch(`${url}/api/command`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'next', requestId: 'host-test-001' }),
  })
  assert.equal(response.status, 403)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    get(`${url}/api/setup`, { headers: { host: 'attacker.invalid' } }, (response) => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
  assert.equal(status, 403)
})

test('invalid command fields are rejected, with no fake success', async () => {
  const response = await fetch(`${url}/api/command`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'round', round: -1, requestId: 'bad-round-001' }),
  })
  assert.equal(response.status, 400)
  assert.ok((await response.json()).error)
})

test('wireless frames require device auth and acknowledge actual received sequences', async () => {
  assert.equal((await fetch(`${url}/api/badge/frame`)).status, 401)
  const headers = { authorization: `Bearer ${token}` }
  const first = await fetch(`${url}/api/badge/frame?format=rgba&device=test-badge`, { headers })
  assert.equal(first.status, 200)
  const bytes = Buffer.from(await first.arrayBuffer())
  assert.equal(bytes.length, 76820)
  const sequence = bytes.readUInt32LE(12)
  const initial: StationState = await (await fetch(`${url}/api/state`, { headers: { cookie } })).json()
  assert.equal(initial.devices[0].lastFrameAt, null)
  const second = await fetch(`${url}/api/badge/frame?format=rgb332&device=test-badge`, {
    headers: { ...headers, 'X-Badge-Frame': String(sequence), 'X-Badge-Fps': '5.5' },
  })
  assert.equal((await second.arrayBuffer()).byteLength, 19220)
  const state: StationState = await (await fetch(`${url}/api/state`, { headers: { cookie } })).json()
  assert.equal(state.devices[0].frameId, sequence)
  assert.equal(state.devices[0].fps, 5.5)
  assert.ok(state.devices[0].lastFrameAt)
})

test('preview renders a real PNG with the badge dimensions', async () => {
  const result = await fetch(`${url}/api/frame.png`, { headers: { cookie } })
  assert.equal(result.status, 200)
  const metadata = await sharp(Buffer.from(await result.arrayBuffer())).metadata()
  assert.equal(metadata.width, 160)
  assert.equal(metadata.height, 120)
})

test('event text is escaped before SVG rendering', async () => {
  const command = await fetch(`${url}/api/command`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'event', title: '<&" ALERT', detail: 'A < B & C > D', duration: 1, requestId: 'escape-event-001' }),
  })
  assert.equal(command.status, 200)
  const image = await fetch(`${url}/api/frame.png`, { headers: { cookie } })
  assert.equal(image.status, 200)
})

test('unsafe upload formats are refused and their temporary files are removed', async () => {
  const form = new FormData()
  form.append('file', new Blob(['#EXTM3U\nfile:///etc/passwd']), 'playlist.m3u8')
  const result = await fetch(`${url}/api/library`, { method: 'POST', headers: { cookie }, body: form })
  assert.equal(result.status, 400)
  // The response can finish immediately before the handler's final cleanup.
  for (let attempt = 0; attempt < 20 && (await readdir(path.join(directory, 'uploads'))).length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual(await readdir(path.join(directory, 'uploads')), [])
})

test('private config persists but is never served as media', async () => {
  const stored = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'))
  assert.equal(loadConfig(directory).deviceToken, stored.deviceToken)
  const response = await fetch(`${url}/media/sample/manifest.json`, { headers: { cookie } })
  assert.equal(response.status, 404)
})
