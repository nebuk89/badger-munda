import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { artworks } from './content-art.ts'
import { packageHostedContent } from './package-hosted-content.ts'
import {
  checkHostedPackage,
  resolveBlobAuthOptions,
  uploadHostedContent,
} from './upload-hosted-content.ts'

test('hosted upload uses an explicit token before OIDC credentials', () => {
  assert.deepEqual(resolveBlobAuthOptions('explicit-token', {
    VERCEL_OIDC_TOKEN: 'oidc-token',
    BLOB_STORE_ID: 'store-id',
    BLOB_READ_WRITE_TOKEN: 'environment-token',
  }), { token: 'explicit-token' })
})

test('hosted upload omits the token option for complete OIDC credentials', () => {
  assert.deepEqual(resolveBlobAuthOptions(undefined, {
    VERCEL_OIDC_TOKEN: 'oidc-token',
    BLOB_STORE_ID: 'store-id',
  }), {})
})

test('hosted upload ignores a protected token placeholder with OIDC credentials', () => {
  assert.deepEqual(resolveBlobAuthOptions(undefined, {
    VERCEL_OIDC_TOKEN: 'oidc-token',
    BLOB_STORE_ID: 'store-id',
    BLOB_READ_WRITE_TOKEN: '[SENSITIVE]',
  }), {})
})

test('hosted upload uses the legacy environment token without OIDC credentials', () => {
  assert.deepEqual(resolveBlobAuthOptions(undefined, {
    BLOB_READ_WRITE_TOKEN: 'environment-token',
  }), { token: 'environment-token' })
})

test('hosted upload rejects missing credentials', () => {
  assert.throws(
    () => resolveBlobAuthOptions(undefined, {}),
    /BLOB_READ_WRITE_TOKEN is required unless --dry-run is set/,
  )
})

test('hosted upload dry run checks every immutable package object without credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'underhive-upload-'))
  try {
    const packaged = await packageHostedContent(directory, [artworks[0]])
    const checked = await checkHostedPackage(directory)
    assert.equal(checked.catalog.catalogHash, packaged.catalog.catalogHash)
    assert.equal(checked.assets.length, 67)
    assert.ok(checked.assets.every((asset) => asset.pathname.startsWith(
      `content/v1/${packaged.catalog.catalogHash}/`,
    )))
    const dryRun = await uploadHostedContent(directory, { dryRun: true })
    assert.equal(dryRun.assetCount, 67)
    assert.ok(dryRun.totalBytes > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('hosted upload check rejects changed frames and raw RGBA objects', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'underhive-upload-invalid-'))
  try {
    const packaged = await packageHostedContent(directory, [artworks[0]])
    const frame = path.join(packaged.directory, packaged.catalog.clips[0].framePaths[0])
    await writeFile(frame, Buffer.concat([await readFile(frame), Buffer.from([0])]))
    await assert.rejects(checkHostedPackage(directory), /hash does not match/)

    await packageHostedContent(directory, [artworks[0]])
    await writeFile(path.join(packaged.directory, 'frame.rgba'), Buffer.alloc(4))
    await assert.rejects(checkHostedPackage(directory), /does not match the immutable catalog/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
