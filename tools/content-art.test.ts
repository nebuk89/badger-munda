import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { artworks, FPS, FRAME_COUNT, HEIGHT, POSTER_FRAME, WIDTH } from './content-art.ts'
import { label, svg, text } from './content-primitives.ts'
import { gameEvents } from '../shared/game-events.ts'

test('starter clips use unique identities and the badge media contract', () => {
  assert.deepEqual(artworks.map(({ clip }) => clip.id), [
    'ration-works', 'curfew-signal', 'sump-tavern',
    'clean-air', 'second-hands', 'shaft-nine', 'guild-credit', 'salvage-union',
    'ash-waste-tours', 'missing-servitor', 'power-coop', 'sump-shuffle', 'hab-block-thirteen',
    ...gameEvents.map((event) => event.clipId),
  ])
  for (const { clip } of artworks) {
    assert.equal(clip.duration, 8)
    assert.equal(clip.fps, FPS)
    assert.equal(clip.frameCount, FRAME_COUNT)
    assert.equal(clip.width, WIDTH)
    assert.equal(clip.height, HEIGHT)
    assert.equal(clip.posterUrl, `/media/${clip.id}/poster.png`)
    assert.equal(clip.videoUrl, `/media/${clip.id}/video.mp4`)
    assert.match(clip.accent, /^#[0-9a-f]{6}$/i)
    assert.ok(['advert', 'notice', 'event'].includes(clip.category))
  }
})

test('every game preset has a dedicated event video, never an ambient advert', () => {
  const eventArt = artworks.filter(({ clip }) => clip.category === 'event')
  assert.equal(eventArt.length, 6)
  for (const event of gameEvents) {
    const artwork = eventArt.find(({ clip }) => clip.id === event.clipId)
    assert.ok(artwork, `Missing video for ${event.title}`)
    assert.equal(artwork.clip.title, event.title)
    assert.equal(artwork.clip.subtitle, event.detail)
  }
})

for (const artwork of artworks) {
  test(`${artwork.clip.id} renders opaque badge frames with continuously changing illustrations`, async () => {
    const hashes = new Set<string>()
    for (const frame of [0, 1, POSTER_FRAME, 31, 32, 48, 63]) {
      const { data, info } = await sharp(Buffer.from(artwork.frame(frame)))
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(info.width, WIDTH)
      assert.equal(info.height, HEIGHT)
      assert.equal(info.channels, 4)
      assert.equal(data.length, WIDTH * HEIGHT * 4)
      for (let offset = 3; offset < data.length; offset += 4) assert.equal(data[offset], 255)
      hashes.add(createHash('sha256').update(data).digest('hex'))
      assert.equal(artwork.frame(frame), artwork.frame(frame), 'art must be deterministic')
      assert.doesNotMatch(artwork.frame(frame), /https?:\/\/(?!www\.w3\.org)/)
    }
    assert.equal(hashes.size, 7, 'motion must continue within each held copy state')
  })
}

test('each message gets a four-second hold and the poster retains the main identity', () => {
  const [ration, curfew, tavern] = artworks
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    assert.match(ration.frame(frame), frame < 32 ? /FLAVOUR\./ : /NUTRIENTS\./)
    assert.match(curfew.frame(frame), frame < 32 ? /REMAIN PRODUCTIVE\./ : /REPORT\. REST\. REPEAT\./)
    assert.match(tavern.frame(frame), frame < 32 ? /FILTERED TWICE\./ : /QUESTIONS COST/)
  }
  assert.match(ration.frame(POSTER_FRAME), /RATION/)
  assert.match(curfew.frame(POSTER_FRAME), /CURFEW/)
  assert.match(tavern.frame(POSTER_FRAME), /THE SUMP/)
})

test('drawing helpers preserve ampersands and angle brackets as visible text', async () => {
  const copy = 'BOLT & SONS <REPAIRS>'
  const drawing = text(copy, 5, 30, 8, '#fff') + label(copy, 5, 50, '#fff')
  assert.match(drawing, /BOLT &amp; SONS &lt;REPAIRS&gt;/)
  const image = await sharp(Buffer.from(svg(0, '#000', drawing, '#fff'))).png().toBuffer()
  const metadata = await sharp(image).metadata()
  assert.equal(metadata.width, WIDTH)
  assert.equal(metadata.height, HEIGHT)
})
