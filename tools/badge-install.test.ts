import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  badgeInstallMode,
  hostedBadgeState,
  hostedServiceOrigin,
  redactBadgeSecret,
  trustedTimeState,
} from './badge-install.ts'

const badgeId = '11111111-1111-4111-8111-111111111111'
const badgeSecret = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

test('local installation remains the default', () => {
  assert.equal(badgeInstallMode(undefined), 'local')
  assert.equal(badgeInstallMode(''), 'local')
  assert.equal(badgeInstallMode('local'), 'local')
  assert.equal(badgeInstallMode('hosted'), 'hosted')
  assert.throws(() => badgeInstallMode('remote'), /local or hosted/)
})

test('hosted provisioning accepts only the approved origin and credential shapes', () => {
  assert.deepEqual(hostedBadgeState(hostedServiceOrigin, badgeId, badgeSecret), {
    schema: 1,
    mode: 'hosted',
    serviceOrigin: hostedServiceOrigin,
    badgeId,
    badgeSecret,
  })
  for (const origin of [
    'http://badger-munda.vercel.app',
    'https://badger-munda.vercel.app/path',
    'https://example.vercel.app',
  ]) {
    assert.throws(() => hostedBadgeState(origin, badgeId, badgeSecret), /approved HTTPS origin/)
  }
  assert.throws(
    () => hostedBadgeState(hostedServiceOrigin, badgeId, `${badgeSecret}x`),
    /32-byte base64url secret/,
  )
})

test('installer diagnostics can redact the badge secret', () => {
  const message = `failed Authorization: Badge ${badgeId}.${badgeSecret}`
  const redacted = redactBadgeSecret(message, badgeSecret)
  assert.equal(redacted.includes(badgeSecret), false)
  assert.match(redacted, /\[REDACTED\]/)
})

test('trusted time uses a bounded Unix timestamp', () => {
  assert.deepEqual(trustedTimeState(new Date('2026-09-24T16:00:00Z')), {
    schema: 1,
    unixSeconds: 1_790_265_600,
  })
  assert.throws(
    () => trustedTimeState(new Date('2020-01-01T00:00:00Z')),
    /cannot seed trusted badge time/,
  )
})

test('hosted installer preserves local configuration, Wi-Fi state, and device files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'underhive-installer-'))
  const mount = path.join(root, 'BADGER')
  const dataDir = path.join(root, 'data')
  const app = path.join(mount, 'apps', 'underhive')
  const menu = path.join(mount, 'apps', 'menu')
  const state = path.join(mount, 'state', 'underhive')
  try {
    await Promise.all([
      mkdir(app, { recursive: true }),
      mkdir(menu, { recursive: true }),
      mkdir(state, { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(mount, 'main.py'), 'stock-main\n'),
      writeFile(path.join(mount, 'unrelated.txt'), 'keep-me\n'),
      writeFile(path.join(menu, 'icon.py'), 'stock-menu-icon\n'),
      writeFile(path.join(menu, '__init__.py'), 'old-menu\n'),
      writeFile(path.join(app, 'config.py'), 'SERVER_URL = "http://192.168.1.2:8787"\n'),
      writeFile(path.join(state, 'wifi.v1.json'), '{"schema":1,"networks":[],"selected":null}\n'),
      writeFile(path.join(state, 'hosted.v1.json'), '{"schema":1,"mode":"local"}\n'),
      writeFile(path.join(state, 'hosted.v1.json.new'), '{"schema":1,"mode":"local"}\n'),
      writeFile(path.join(state, 'hosted.v1.json.bak'), '{"schema":1,"mode":"local"}\n'),
    ])
    const output = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('tools/install-badge.ts'),
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          BADGE_MOUNT: mount,
          DATA_DIR: dataDir,
          BADGE_MODE: 'hosted',
          BADGE_ID: badgeId,
          BADGE_SECRET: badgeSecret,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('close', (code) => resolve({ code, stderr }))
    })
    assert.equal(output.code, 0, output.stderr)
    assert.equal(
      await readFile(path.join(app, 'config.py'), 'utf8'),
      'SERVER_URL = "http://192.168.1.2:8787"\n',
    )
    assert.equal(
      await readFile(path.join(state, 'wifi.v1.json'), 'utf8'),
      '{"schema":1,"networks":[],"selected":null}\n',
    )
    assert.equal(await readFile(path.join(mount, 'main.py'), 'utf8'), 'stock-main\n')
    assert.equal(await readFile(path.join(mount, 'unrelated.txt'), 'utf8'), 'keep-me\n')
    assert.match(await readFile(path.join(app, 'hosted_client.py'), 'utf8'), /class HostedClient/)
    assert.match(await readFile(path.join(app, 'hosted_protocol.py'), 'utf8'), /PROTOCOL_VERSION = 2/)
    const saved = JSON.parse(await readFile(path.join(state, 'hosted.v1.json'), 'utf8'))
    assert.equal(saved.badgeId, badgeId)
    assert.equal(saved.badgeSecret, badgeSecret)
    await assert.rejects(readFile(path.join(state, 'hosted.v1.json.new'), 'utf8'), /ENOENT/)
    await assert.rejects(readFile(path.join(state, 'hosted.v1.json.bak'), 'utf8'), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
