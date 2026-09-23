import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { artworks } from './content-art.ts'
import { packageHostedContent } from './package-hosted-content.ts'

test('hosted package contains immutable UBF1 PNG assets and no raw frames', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'underhive-hosted-'))
  try {
    const { catalog, directory: content } = await packageHostedContent(directory, [artworks[0]])
    assert.equal(catalog.clips.length, 1)
    assert.equal(catalog.clips[0].framePaths.length, 64)
    const first = await readFile(path.join(content, catalog.clips[0].framePaths[0]))
    assert.equal(first.subarray(0, 4).toString(), 'UBF1')
    assert.equal(first[8], 4)
    assert.equal(first[9], 0)
    assert.equal(first.readUInt32LE(12), 1)
    assert.equal(first.readUInt32LE(16), first.length - 20)
    assert.ok(first.length - 20 <= 32768)
    assert.ok(!JSON.stringify(catalog).includes('.rgba'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
