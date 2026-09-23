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

test('hosted package is deterministic and keeps catalog-wide frame IDs', async () => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), 'underhive-hosted-first-'))
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'underhive-hosted-second-'))
  try {
    const first = await packageHostedContent(firstRoot, [artworks[1]])
    const second = await packageHostedContent(secondRoot, [artworks[1]])
    assert.deepEqual(first.catalog, second.catalog)
    assert.equal(first.catalog.clips[0].frameIds[0], 65)
    assert.equal(first.catalog.clips[0].frameIds.at(-1), 128)
    assert.deepEqual(
      await readFile(path.join(first.directory, first.catalog.clips[0].framePaths[0])),
      await readFile(path.join(second.directory, second.catalog.clips[0].framePaths[0])),
    )
  } finally {
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
    ])
  }
})

test('built-in hosted package contains nineteen clips and 1,216 stable frames', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'underhive-hosted-full-'))
  try {
    const { catalog } = await packageHostedContent(directory)
    const frameIds = catalog.clips.flatMap((clip) => clip.frameIds)
    assert.equal(catalog.clips.length, 19)
    assert.equal(frameIds.length, 1216)
    assert.deepEqual(frameIds, Array.from({ length: 1216 }, (_, index) => index + 1))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
