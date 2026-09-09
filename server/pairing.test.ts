import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import sharp from 'sharp'
import type { Clip } from '../shared/types.ts'
import { createApp } from './app.ts'
import { packFrame } from './frames.ts'
import { pairingAddress, pairingSvg } from './pairing.ts'

// Synthetic credentials belong only to these isolated fixtures.
const config = { version: 1 as const, controllerPin: '708194', deviceToken: 'ab'.repeat(32) }
const white = Buffer.alloc(160 * 120 * 4, 255)
const red = Buffer.from(white)
for (let offset = 0; offset < red.length; offset += 4) { red[offset + 1] = 0; red[offset + 2] = 0 }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(process.cwd(), '.pairing-test-'))
  let server: Server | undefined
  t.after(async () => {
    if (server) await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve())
      server!.closeAllConnections()
    })
    await rm(directory, { recursive: true, force: true })
  })
  const clips: Clip[] = ['sample', 'second', 'event-failed-jump'].map((id) => ({
    id, title: id, subtitle: '', category: id.startsWith('event-') ? 'event' : 'advert',
    duration: 2, fps: 2, frameCount: 4, width: 160, height: 120, accent: '#ffffff',
    posterUrl: `/media/${id}/poster.png`, videoUrl: `/media/${id}/video.mp4`,
  }))
  for (const clip of clips) {
    const dir = path.join(directory, 'library', clip.id)
    await mkdir(path.join(dir, 'frames'), { recursive: true })
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(clip))
    for (let i = 0; i < clip.frameCount; i++) {
      await writeFile(path.join(dir, 'frames', `000${i}.rgba`), clip.category === 'event' && i === 0 ? red : white)
    }
  }
  let now = 1_000_000
  const created = await createApp({ dataDir: directory, config, port: 8787, clock: () => now })
  server = created.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  return {
    ...created, url,
    advance: (milliseconds: number) => { now += milliseconds },
    pair: (pin = config.controllerPin) => fetch(`${url}/api/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    }),
    badge: async (id = 'new-badge', receipt?: number, headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}/api/badge/frame?format=png&device=${id}`, {
        headers: {
          authorization: `Bearer ${config.deviceToken}`,
          ...(receipt === undefined ? {} : { 'X-Badge-Frame': String(receipt) }), ...headers,
        },
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes[8], 4)
      assert.equal(bytes.readUInt32LE(16), bytes.length - 20)
      assert.equal(response.headers.get('x-frame-id'), String(bytes.readUInt32LE(12)))
      return bytes
    },
  }
}

function sessionCookie(response: Response) {
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie')!.split(';')[0]
}

test('pairing uses the connection IPv4, handles mapped IPv6, and refuses unavailable addresses safely', () => {
  assert.equal(pairingAddress('192.168.50.12', 8787), '192.168.50.12:8787')
  assert.equal(pairingAddress('::ffff:10.20.30.40', 9001), '10.20.30.40:9001')
  assert.equal(pairingAddress('::FFFF:172.16.0.8', 65535), '172.16.0.8:65535')
  for (const address of [undefined, '::1', '2001:db8::1', 'untrusted.invalid/<svg>', '999.1.1.1']) {
    assert.throws(() => pairingAddress(address, 8787), {
      message: 'Pairing screen needs the Mac’s IPv4 address. Connect the badge to the station’s LAN IPv4 address.',
    })
  }
  assert.throws(() => pairingAddress('192.168.1.1', 0), /IPv4 address/)
})

test('pairing art has a large unclipped code and address, opaque pixels, and a sub-5KB wire PNG', async () => {
  for (const [pin, address] of [['888888', '192.168.255.254:65535'], ['111111', '10.0.0.1:80'], ['000000', '192.168.1.2:8787']]) {
    const svg = pairingSvg(pin, address)
    const { data: rgba, info } = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 160)
    assert.equal(info.height, 120)
    for (let offset = 3; offset < rgba.length; offset += 4) assert.equal(rgba[offset], 255)
    const wire = packFrame(rgba, 'png', 1, false)
    assert.ok(wire.length - 20 <= 5000, `Pairing PNG is ${wire.length - 20} bytes`)
    const decoded = await sharp(wire.subarray(20)).metadata()
    assert.equal(decoded.width, 160)
    assert.equal(decoded.height, 120)
    assert.equal(decoded.hasAlpha, false)
    for (const [index, match] of [...svg.toString().matchAll(/<text\b[^>]*>[^<]*<\/text>/g)].entries()) {
      const pixels = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120">${match[0]}</svg>`))
        .ensureAlpha().raw().toBuffer()
      const xs: number[] = [], ys: number[] = []
      for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
        if (pixels[(y * 160 + x) * 4 + 3]) { xs.push(x); ys.push(y) }
      }
      assert.ok(xs.length, 'Each instruction must be visible')
      assert.ok(Math.min(...xs) >= 7 && Math.max(...xs) <= 152, 'Text stays inside the border')
      assert.ok(Math.min(...ys) >= 8 && Math.max(...ys) <= 112)
      if (index === 4) {
        assert.ok(Math.max(...ys) - Math.min(...ys) >= 24, 'The code is large, not caption-sized')
        assert.ok(Math.min(...ys) >= 67 && Math.max(...ys) < 100, 'The code clears both adjacent instructions')
      }
    }
  }
})

test('a paused badge holds the actual code card until pairing, without changing programme state or receipts', async (t) => {
  const f = await fixture(t)
  f.station.command({ action: 'play', clipId: 'sample' }, 'pairing-play')
  f.station.command({ action: 'loop', enabled: true }, 'pairing-loop')
  f.station.command({ action: 'queue', clipId: 'second' }, 'pairing-queue')
  f.station.command({ action: 'toggle-pause' }, 'pairing-pause')
  const broadcast = f.station.snapshot()
  const first = await f.badge('alpha', 99999, { host: 'localhost:1234' })
  const sequence = first.readUInt32LE(12)
  assert.equal(first[9], 0, 'Pairing is not paused even when the programme is')
  const expected = await sharp(pairingSvg(config.controllerPin, '127.0.0.1:8787')).ensureAlpha().raw().toBuffer()
  assert.deepEqual(first, packFrame(expected, 'png', sequence, false), 'Use the socket address and configured port, not Host')
  assert.equal(f.snapshot().devices[0].awaitingPairing, true)
  assert.equal(f.snapshot().devices[0].lastFrameAt, null, 'An unsent receipt is ignored')
  f.advance(7000)
  const retry = await f.badge('alpha', sequence)
  assert.deepEqual(retry, first)
  assert.equal(f.snapshot().devices[0].frameId, sequence)
  assert.equal(f.snapshot().devices[0].lastFrameAt, 1_007_000)
  for (let i = 0; i < 3; i++) { f.advance(7000); assert.deepEqual(await f.badge('alpha'), first) }
  assert.equal((await f.pair('000001')).status, 401)
  assert.deepEqual(await f.badge('beta'), first, 'An incorrect PIN releases no badge')
  assert.deepEqual(f.station.snapshot(), broadcast)
  const cookie = sessionCookie(await f.pair())
  assert.ok(f.snapshot().devices.every((device) => !device.awaitingPairing), 'Pairing releases all waiting badges')
  const released = await f.badge('alpha', sequence)
  assert.ok(released.readUInt32LE(12) > sequence)
  assert.equal(released[9], 1)
  assert.deepEqual(await sharp(released.subarray(20)).ensureAlpha().raw().toBuffer(), white)
  assert.deepEqual(await f.badge('beta'), released)
  assert.deepEqual(f.station.snapshot(), broadcast)
  const state = await (await fetch(`${f.url}/api/state`, { headers: { cookie } })).text()
  assert.ok(!state.includes(config.controllerPin) && !state.includes(config.deviceToken))
  assert.ok(state.includes('"awaitingPairing":false'))
})

test('pairing code is private to badge auth, not setup, state, preview, or media', async (t) => {
  const f = await fixture(t)
  for (const route of ['/api/setup', '/api/state', '/api/frame.png', '/api/badge/frame', '/media/pairing/frame.png']) {
    const response = await fetch(`${f.url}${route}`)
    assert.equal(response.status, route === '/api/setup' ? 200 : 401)
    const body = await response.text()
    assert.ok(!body.includes(config.controllerPin) && !body.includes(config.deviceToken))
    if (route === '/api/setup') assert.deepEqual(JSON.parse(body), { paired: false, name: 'Underhive Broadcast' })
  }
  const card = await f.badge()
  assert.deepEqual(await sharp(await f.frames.png()).ensureAlpha().raw().toBuffer(), white, 'Preview renderer does not reuse the card')
  const nextCard = await f.badge()
  assert.ok(nextCard.readUInt32LE(12) > card.readUInt32LE(12), 'Preview and badge share one sequence allocator')
  const cookie = sessionCookie(await f.pair())
  const preview = await fetch(`${f.url}/api/frame.png`, { headers: { cookie } })
  assert.deepEqual(await sharp(Buffer.from(await preview.arrayBuffer())).ensureAlpha().raw().toBuffer(), white)
  for (const route of ['/media/pairing/frame.png', '/media/sample/pairing.png', '/media/sample/frames/0000.rgba']) {
    assert.equal((await fetch(`${f.url}${route}`, { headers: { cookie } })).status, 404)
  }
})

test('already paired badges play immediately; logout gates only new or timed-out connections', async (t) => {
  const f = await fixture(t)
  const cookie = sessionCookie(await f.pair())
  const first = await f.badge('established')
  assert.deepEqual(await sharp(first.subarray(20)).ensureAlpha().raw().toBuffer(), white)
  assert.equal(f.snapshot().devices[0].awaitingPairing, false)
  assert.equal((await fetch(`${f.url}/api/logout`, { method: 'POST', headers: { cookie } })).status, 200)
  f.advance(7999)
  await f.badge('established')
  assert.equal(f.snapshot().devices.find((device) => device.id === 'established')!.awaitingPairing, false)
  await f.badge('new')
  assert.equal(f.snapshot().devices.find((device) => device.id === 'new')!.awaitingPairing, true)
  await f.badge('established')
  assert.equal(f.snapshot().devices.find((device) => device.id === 'established')!.awaitingPairing, false)
  f.advance(8000)
  assert.equal(f.snapshot().devices.find((device) => device.id === 'established')!.online, false)
  const reconnect = await f.badge('established')
  assert.equal(f.snapshot().devices.find((device) => device.id === 'established')!.awaitingPairing, true)
  assert.notDeepEqual(reconnect.subarray(20), first.subarray(20))
})

test('any unexpired controller session satisfies reconnect, but expired sessions do not', async (t) => {
  const f = await fixture(t)
  const firstCookie = sessionCookie(await f.pair())
  const secondCookie = sessionCookie(await f.pair())
  await f.badge('established')
  assert.equal((await fetch(`${f.url}/api/logout`, { method: 'POST', headers: { cookie: firstCookie } })).status, 200)
  f.advance(7 * 24 * 60 * 60_000 - 1)
  await f.badge('established')
  assert.equal(f.snapshot().devices[0].awaitingPairing, false, 'The other valid controller satisfies a reconnect')
  f.advance(1)
  await f.badge('established')
  assert.equal(f.snapshot().devices[0].awaitingPairing, false, 'Expiry alone cannot interrupt playback')
  await f.badge('new')
  assert.equal(f.snapshot().devices[1].awaitingPairing, true)
  const setup = await (await fetch(`${f.url}/api/setup`, { headers: { cookie: secondCookie } })).json()
  assert.equal(setup.paired, false)
  f.advance(8000)
  await f.badge('established')
  assert.equal(f.snapshot().devices[0].awaitingPairing, true)
})

test('pairing releases into animated game events over a paused programme and restores its pause flag', async (t) => {
  const f = await fixture(t)
  f.station.command({ action: 'play', clipId: 'sample' }, 'pair-event-play')
  f.station.command({ action: 'toggle-pause' }, 'pair-event-pause')
  f.station.command({ action: 'game-event', eventId: 'failed-jump' }, 'pair-event-dispatch')
  const broadcast = f.station.snapshot()
  const card = await f.badge()
  assert.equal(card[9], 0)
  assert.deepEqual(f.station.snapshot(), broadcast)
  sessionCookie(await f.pair())
  const event = await f.badge()
  assert.equal(event[9], 0)
  assert.deepEqual(await sharp(event.subarray(20)).ensureAlpha().raw().toBuffer(), red)
  f.advance(500)
  const next = await f.badge()
  assert.equal(next[9], 0)
  assert.ok(next.readUInt32LE(12) > event.readUInt32LE(12))
  assert.deepEqual(await sharp(next.subarray(20)).ensureAlpha().raw().toBuffer(), white)
  assert.equal(f.station.snapshot().position, broadcast.position)
  f.station.command({ action: 'clear-event' }, 'pair-event-clear')
  assert.equal((await f.badge())[9], 1)
})

test('a phone pairing during card rendering releases that in-flight badge response', async (t) => {
  const f = await fixture(t)
  let started!: () => void, release!: () => void
  const rendering = new Promise<void>((resolve) => { started = resolve })
  const paired = new Promise<void>((resolve) => { release = resolve })
  const original = f.frames.pairing.bind(f.frames)
  f.frames.pairing = async (...args) => {
    const frame = await original(...args)
    started()
    await paired
    return frame
  }
  const request = f.badge()
  await rendering
  try { sessionCookie(await f.pair()) }
  finally { release() }
  const response = await request
  assert.deepEqual(await sharp(response.subarray(20)).ensureAlpha().raw().toBuffer(), white)
  assert.equal(f.snapshot().devices[0].awaitingPairing, false)
})

test('concurrent pairing renders share work and remain sequenced with programme renders', async (t) => {
  const f = await fixture(t)
  const cards = await Promise.all(Array.from({ length: 8 }, () => f.frames.pairing(config.controllerPin, '192.168.1.10:8787')))
  assert.ok(cards.every((card) => card === cards[0]))
  const programme = await f.frames.render()
  assert.ok(programme.sequence > cards[0].sequence)
  const [a, normal, b] = await Promise.all([
    f.frames.pairing(config.controllerPin, '192.168.1.10:8787'),
    f.frames.render(),
    f.frames.pairing(config.controllerPin, '192.168.1.10:8787'),
  ])
  assert.equal(a, b)
  assert.equal(normal, programme)
  assert.equal(a.rgba, cards[0].rgba, 'The fixed art is rasterized once')
  assert.ok(a.sequence > programme.sequence)
  const resumed = await f.frames.render()
  assert.ok(resumed.sequence > a.sequence, 'A cached normal frame cannot replay an older card sequence')
})
