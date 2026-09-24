import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  contentAssetUrl,
  controllerLibrary,
  frameUrlTemplate,
  parseHostedCatalog,
  validateCatalogLocation,
} from './catalog.ts'
import type { HostedContentConfig } from './env.ts'

function catalogValue(overrides: Record<string, unknown> = {}) {
  const clip = {
    id: 'clip-one',
    title: 'Clip one',
    subtitle: 'Test signal',
    category: 'advert',
    duration: 8,
    fps: 8,
    frameCount: 2,
    width: 160,
    height: 120,
    accent: '#ffffff',
    posterUrl: 'clips/clip-one/poster.png',
    videoUrl: 'clips/clip-one/video.mp4',
    frameIds: [1, 2],
    framePaths: [
      'clips/clip-one/frames/0000.ubf',
      'clips/clip-one/frames/0001.ubf',
    ],
    frameHashes: ['b'.repeat(64), 'c'.repeat(64)],
    posterPath: 'clips/clip-one/poster.png',
    posterHash: 'd'.repeat(64),
    videoPath: 'clips/clip-one/video.mp4',
    videoHash: 'e'.repeat(64),
    ...overrides,
  }
  const stable = { version: 1 as const, clips: [clip] }
  return {
    ...stable,
    catalogHash: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
  }
}

function contentConfig(hash: string): HostedContentConfig {
  return {
    catalogUrl: new URL(`https://public.example/content/v1/${hash}/catalog.json`),
    blobBaseUrl: new URL('https://public.example/'),
  }
}

test('hosted catalog makes immutable allowlisted public asset URLs', () => {
  const catalog = parseHostedCatalog(catalogValue())
  const config = contentConfig(catalog.catalogHash)
  validateCatalogLocation(catalog, config)
  assert.equal(
    frameUrlTemplate(catalog, 'clip-one', config),
    `https://public.example/content/v1/${catalog.catalogHash}/clips/clip-one/frames/{frame}.ubf`,
  )
  assert.equal(
    controllerLibrary(catalog, config)[0].posterUrl,
    `https://public.example/content/v1/${catalog.catalogHash}/clips/clip-one/poster.png`,
  )
})

test('hosted catalog rejects mutable, escaping, or untrusted asset URLs', () => {
  assert.throws(
    () => parseHostedCatalog(catalogValue({ posterPath: '../poster.png', posterUrl: '../poster.png' })),
    /unsafe asset path/,
  )
  const catalog = parseHostedCatalog(catalogValue())
  assert.throws(
    () => validateCatalogLocation(catalog, {
      catalogUrl: new URL(`https://attacker.example/content/v1/${catalog.catalogHash}/catalog.json`),
      blobBaseUrl: new URL('https://public.example/'),
    }),
    /origin is not allowlisted/,
  )
  assert.throws(
    () => contentAssetUrl('https://attacker.example/frame.ubf', contentConfig(catalog.catalogHash)),
    /unsafe asset path/,
  )
})

test('hosted catalog rejects mutable catalog locations and hash mismatches', () => {
  const catalog = parseHostedCatalog(catalogValue())
  assert.throws(
    () => validateCatalogLocation(catalog, {
      catalogUrl: new URL('https://public.example/catalog.json'),
      blobBaseUrl: new URL('https://public.example/'),
    }),
    /immutable content-addressed/,
  )
  assert.throws(
    () => validateCatalogLocation(catalog, contentConfig('f'.repeat(64))),
    /does not match the catalog hash/,
  )
})
