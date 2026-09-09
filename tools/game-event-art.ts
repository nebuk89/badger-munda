import { gameEvents, type GameEventId } from '../shared/game-events.ts'
import { clip, rect, svg, text, type Artwork } from './content-primitives.ts'

type Palette = {
  ink: string
  field: string
  paper: string
  accent: string
  mid: string
}

type Scene = {
  palette: Palette
  titleSize: number
  setup: [string, string]
  action: [string, string]
  draw: (frame: number, palette: Palette) => string
}

function progress(frame: number, start: number, end: number) {
  return Math.max(0, Math.min(1, (frame - start) / (end - start)))
}

function ease(value: number) {
  return value * value * (3 - 2 * value)
}

function between(frame: number, start: number, end: number) {
  return ease(progress(frame, start, end))
}

function detailLines(detail: string): [string, string] {
  const words = detail.toUpperCase().split(' ')
  let split = 1
  let difference = Infinity
  for (let index = 1; index < words.length; index += 1) {
    const next = Math.abs(words.slice(0, index).join(' ').length - words.slice(index).join(' ').length)
    if (next < difference) {
      difference = next
      split = index
    }
  }
  return [words.slice(0, split).join(' '), words.slice(split).join(' ')]
}

function rivets(palette: Palette) {
  return [9, 151].flatMap((x) => [33, 90].map((y) => `
    ${rect(x - 2, y - 2, 4, 4, palette.ink)}
    ${rect(x - 1, y - 1, 2, 1, palette.paper, 'opacity=".55"')}
  `)).join('')
}

function motes(frame: number, color: string) {
  return Array.from({ length: 9 }, (_, index) => {
    const travel = (frame * .32 + index * 13) % 74
    return rect(12 + (index * 37) % 132 + Math.sin(frame * .09 + index) * 2, 98 - travel, 2, 1, color, 'opacity=".22"')
  }).join('')
}

function fighter(x: number, y: number, stride: number, palette: Palette, angle = 0, scale = 1) {
  return `
    <g transform="translate(${x} ${y}) rotate(${angle}) scale(${scale})">
      <path d="M-6-22h10v3h3v6H-6Z" fill="${palette.ink}" stroke="${palette.paper}" stroke-width="1"/>
      ${rect(-4, -21, 7, 3, palette.accent)}
      ${rect(1, -17, 5, 2, palette.paper)}
      <path d="M-5-13H4l3 11H-7Z" fill="${palette.accent}" stroke="${palette.ink}" stroke-width="1.5"/>
      ${rect(-8, -12, 3, 7, palette.mid)}
      <path d="M-4-3l${-3 - stride} 5h-5M2-3l${3 + stride} 5h5M-5-11l-5 ${4 + stride}M4-11l6 ${2 - stride}" fill="none" stroke="${palette.paper}" stroke-width="3" stroke-linejoin="bevel"/>
      ${rect(-3, -9, 6, 2, palette.ink)}
    </g>
  `
}

function platform(x: number, width: number, palette: Palette) {
  return `
    ${rect(x, 76, width, 8, palette.accent)}
    ${Array.from({ length: Math.ceil(width / 10) }, (_, index) => `
      <path d="M${x + index * 10} 76l-5 8h5l5-8Z" fill="${palette.ink}"/>
    `).join('')}
    <path d="M${x + 5} 85v13m${width - 10}-13v13M${x + 5} 86l${width - 10} 11m0-11-${width - 10} 11" fill="none" stroke="${palette.mid}" stroke-width="3"/>
    ${rect(x, 74, width, 2, palette.paper)}
  `
}

function failedJump(frame: number, palette: Palette) {
  const run = between(frame, 0, 12)
  const jump = progress(frame, 12, 26)
  const fall = progress(frame, 26, 39)
  const x = frame < 12 ? 25 + run * 24 : 49 + jump * 45 + fall * 10
  const y = 73 - Math.sin(jump * Math.PI) * 23 + fall * fall * 78
  const sign = between(frame, 35, 43)
  const sway = Math.sin(frame * .13) * 3
  return `
    <path d="M17 31v40m8-40v40M135 31v41m8-41v41" stroke="${palette.mid}" stroke-width="2"/>
    <path d="M17 42h8m-8 14h8m110-14h8m-8 14h8" stroke="${palette.paper}" opacity=".25"/>
    <path d="M70 29v66M101 29v66" stroke="${palette.ink}" stroke-width="6"/>
    <path d="M74 38h23m-23 19h23m-23 19h23" stroke="${palette.mid}" opacity=".35"/>
    ${platform(5, 51, palette)}
    ${platform(115, 40, palette)}
    <path d="M136 34v12" stroke="${palette.paper}" stroke-width="1.5"/>
    <g transform="translate(136 47) rotate(${sway})">
      ${rect(-15, 0, 30, 16, palette.paper)}
      ${text('GO!', 0, 12, 11, palette.ink, 'text-anchor="middle"')}
    </g>
    <path d="M82 31q${sway} 13 ${sway * 2} 23" fill="none" stroke="${palette.accent}" stroke-width="1.5"/>
    ${rect(79 + sway * 2, 53, 6, 4, palette.accent)}
    <ellipse cx="${Math.min(x, 50)}" cy="74" rx="${9 - jump * 4}" ry="2" fill="${palette.ink}" opacity="${1 - jump}"/>
    ${fighter(x, y, Math.sin(frame * .6) * 3, palette, fall * 65)}
    <path d="M${95 + sway / 2} 69v7m0 5v7" fill="none" stroke="${palette.paper}" stroke-width="2" opacity="${fall * .5}"/>
    <g opacity="${sign}" transform="translate(80 ${47 - sign * 3}) rotate(${-6 + sway / 3})">
      ${rect(-36, -5, 72, 23, palette.accent, `stroke="${palette.ink}" stroke-width="2"`)}
      ${text('MISSED.', 0, 11, 13, palette.ink, 'text-anchor="middle"')}
    </g>
    ${motes(frame, palette.paper)}
  `
}

function fatality(frame: number, palette: Palette) {
  const tip = between(frame, 18, 34)
  const stamp = between(frame, 18, 30)
  const sway = Math.sin(frame * .12)
  return `
    ${rect(15, 34, 67, 57, palette.mid)}
    <path d="M20 34v-5m13 5v-5m13 5v-5m13 5v-5m13 5v-5" stroke="${palette.paper}" stroke-width="2" opacity=".5"/>
    <g transform="translate(49 ${55 - (1 - stamp) * 5}) rotate(${-5 + sway}) scale(${.87 + stamp * .13})">
      <path d="M-25-12h5v-7h39v7h6v28h-6v9h-39v-9h-5Z" fill="none" stroke="${palette.accent}" stroke-width="2"/>
      <path d="M-15-15H15v5h5v20h-7v9H-13v-9h-7v-20h5Z" fill="${palette.paper}"/>
      ${rect(-13, -4, 10, 8, palette.ink)}
      ${rect(3, -4, 10, 8, palette.ink)}
      <path d="M0 3l-4 6h8Z" fill="${palette.ink}"/>
      <path d="M-7 13v6m7-6v6m7-6v6" stroke="${palette.ink}" stroke-width="2"/>
      <path d="M-17-12h6m-9 9v-5" fill="none" stroke="${palette.accent}" stroke-width="1.5"/>
    </g>
    ${text(frame < 30 ? 'ON FILE' : 'OUT', 49, 88, frame < 30 ? 8 : 12, palette.paper, 'text-anchor="middle"')}
    ${rect(90, 34, 54, 19, palette.paper)}
    ${text('CREW', 94, 47, 8.3, palette.ink)}
    ${text(frame < 30 ? '1' : '0', 134, 49, 15, palette.ink, 'text-anchor="middle"')}
    <path d="M87 85h64l-6 7H93Z" fill="${palette.ink}"/>
    <ellipse cx="118" cy="84" rx="16" ry="3" fill="${palette.mid}"/>
    <g transform="translate(117 81) rotate(${tip * 89 + sway * (1 - tip) * 2})">
      <path d="M-11 0v-24l5-6H7l6 6V0Z" fill="${palette.mid}" stroke="${palette.paper}" stroke-width="1"/>
      ${fighter(0, -3, 0, palette, 0, .88)}
    </g>
    <g opacity="${between(frame, 31, 40)}" transform="translate(${119 + sway * 2} ${60 + Math.sin(frame * .17)}) rotate(-9)">
      ${rect(-22, -5, 44, 15, palette.accent, `stroke="${palette.ink}" stroke-width="1.5"`)}
      ${text('VOID', 0, 6, 11, palette.ink, 'text-anchor="middle"')}
    </g>
    ${motes(frame, palette.paper)}
  `
}

const pipPositions: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[-6, -6], [6, 6]],
  3: [[-6, -6], [0, 0], [6, 6]],
  4: [[-6, -6], [6, -6], [-6, 6], [6, 6]],
  5: [[-6, -6], [6, -6], [0, 0], [-6, 6], [6, 6]],
  6: [[-6, -6], [6, -6], [-6, 0], [6, 0], [-6, 6], [6, 6]],
}

function diceFail(frame: number, palette: Palette) {
  const dice = [35, 78, 121].map((x, index) => {
    const settle = between(frame, 23 + index * 4, 31 + index * 4)
    const roll = Math.min(frame, 31 + index * 4)
    const angle = (1 - settle) * (roll * (index % 2 ? -7 : 7) + index * 29) + settle * [-8, 5, -4][index]
    const bounce = Math.abs(Math.sin(frame * .25 + index * 1.2)) * 9 * (1 - settle)
    const y = 66 - bounce + settle * Math.sin(frame * .12 + index) * .6
    const value = settle > .72 ? 1 : 2 + (Math.floor(frame / 6) + index * 2) % 5
    return `
      <ellipse cx="${x + 3}" cy="84" rx="${14 - bounce / 3}" ry="3" fill="${palette.ink}" opacity=".45"/>
      <g transform="translate(${x} ${y}) rotate(${angle})">
        <path d="M-15-14H12l5 5v25h-27l-5-5Z" fill="${palette.accent}" stroke="${palette.ink}" stroke-width="1.5"/>
        ${rect(-15, -14, 27, 25, palette.paper, `stroke="${palette.ink}" stroke-width="1.5"`)}
        <path d="M12-14v25l5 5M-15 11l5 5" fill="none" stroke="${palette.ink}" stroke-width="1.2"/>
        ${pipPositions[value].map(([px, py]) => rect(px - 3, py - 3, 5, 5, palette.ink)).join('')}
      </g>
    `
  }).join('')
  return `
    <path d="M13 48h134l8 38-10 7H15L5 86Z" fill="${palette.mid}" stroke="${palette.paper}" stroke-width="1.5"/>
    <path d="M13 48l8 33h118l8-33M21 81l-6 12m124-12 6 12" fill="none" stroke="${palette.ink}" stroke-width="3"/>
    ${rect(19, 34, 122, 8, palette.ink)}
    ${Array.from({ length: 15 }, (_, index) => rect(23 + index * 8, 36, 2, 4, palette.accent, 'opacity=".6"')).join('')}
    <path d="M${26 + between(frame, 0, 40) * 108 + Math.sin(frame * .12)} 33v10" stroke="${palette.paper}" stroke-width="3"/>
    ${dice}
    ${motes(frame, palette.paper)}
  `
}

function criticalHit(frame: number, palette: Palette) {
  const fly = between(frame, 9, 26)
  const impact = progress(frame, 26, 38)
  const recoil = Math.sin(Math.max(0, frame - 26) * .65) * (1 - between(frame, 26, 46)) * 8
  const sway = Math.sin(frame * .13) * .8
  const rays = Array.from({ length: 10 }, (_, index) => `
    <path d="M0 ${-27 - impact * 5}v${-4 - impact * 7}" transform="rotate(${index * 36})" stroke="${palette.paper}" stroke-width="${index % 2 ? 2 : 3}"/>
  `).join('')
  return `
    <path d="M6 44h147M6 82h147" stroke="${palette.mid}" stroke-width="5"/>
    ${rect(21, 42, 5, 5, palette.paper, 'opacity=".6"')}
    ${rect(137, 80, 5, 5, palette.paper, 'opacity=".6"')}
    <path d="M94 86l-7 9m21-9 7 9" fill="none" stroke="${palette.ink}" stroke-width="5"/>
    <g transform="translate(102 ${62 + sway}) rotate(${recoil})">
      <circle r="29" fill="${palette.ink}"/>
      <circle r="25" fill="${palette.accent}" stroke="${palette.paper}" stroke-width="1.5"/>
      <circle r="18" fill="${palette.field}" stroke="${palette.ink}" stroke-width="1.5"/>
      <circle r="11" fill="${palette.paper}"/>
      <circle r="4" fill="${palette.ink}"/>
      <path d="M-27 0h6m21-27v6m27 21h-6M0 27v-6" stroke="${palette.ink}" stroke-width="2"/>
      <g opacity="${between(frame, 26, 30) * (1 - between(frame, 38, 48))}">${rays}</g>
    </g>
    <path d="M${9 + fly * 68} ${78 - fly * 16}h11m-16 5h7m-10-10h10" fill="none" stroke="${palette.paper}" stroke-width="2" opacity="${1 - fly}"/>
    <g transform="translate(${21 + fly * 81} ${77 - fly * 15 - Math.sin(fly * Math.PI) * 8 + sway * fly}) rotate(${fly * 270})">
      <path d="M-9-5l4-4H5l4 4V5L5 9H-5l-4-4Z" fill="${palette.paper}" stroke="${palette.ink}" stroke-width="2"/>
      <path d="M0-6l2 4h4L3 1l1 5-4-3-4 3 1-5-3-3h4Z" fill="${palette.field}"/>
    </g>
    <g opacity="${between(frame, 27, 36)}" transform="translate(${-8 * (1 - between(frame, 27, 36))} 0)">
      ${text('DIRECT', 10, 53, 11, palette.paper)}
      ${text('HIT!', 9, 72, 19, palette.paper)}
      <path d="M12 77h44l-5 6" fill="none" stroke="${palette.ink}" stroke-width="2"/>
    </g>
    ${motes(frame, palette.paper)}
  `
}

function gear(x: number, y: number, radius: number, angle: number, palette: Palette) {
  return `
    <g transform="translate(${x} ${y}) rotate(${angle})">
      ${Array.from({ length: 8 }, (_, index) => `
        <g transform="rotate(${index * 45})">${rect(-4, -radius, 8, 7, palette.accent, `stroke="${palette.ink}" stroke-width="1.5"`)}</g>
      `).join('')}
      <circle r="${radius - 4}" fill="${palette.accent}" stroke="${palette.ink}" stroke-width="1.5"/>
      <circle r="${radius - 9}" fill="${palette.mid}" stroke="${palette.ink}" stroke-width="1.5"/>
      <path d="M-5 0H5M0-5V5" stroke="${palette.paper}" stroke-width="2"/>
      <circle r="2" fill="${palette.ink}"/>
    </g>
  `
}

function ammoJam(frame: number, palette: Palette) {
  const jam = between(frame, 19, 31)
  const rotation = frame <= 23
    ? frame * 4
    : 92 + between(frame, 23, 31) * 14 + Math.sin(frame * .6) * jam * 2
  const sway = Math.sin(frame * .14)
  return `
    ${rect(11, 34, 138, 55, palette.ink)}
    ${rect(14, 37, 64, 49, palette.mid)}
    <path d="M20 48h15v-6h22v7h13v14H52l-6 17H33l5-17H20Z" fill="${palette.paper}"/>
    ${rect(24, 51, 38, 6, palette.ink)}
    <path d="M35 66h11l-3 8h-9" fill="${palette.accent}"/>
    <path d="M78 40v43" stroke="${palette.paper}" stroke-width="1" opacity=".5"/>
    ${gear(100, 55, 17, rotation, palette)}
    ${gear(124, 72, 17, -rotation + 22, palette)}
    <g transform="translate(${144 - jam * 29} ${36 + jam * 17}) rotate(${-22 + jam * 10 + sway})">
      <path d="M-5-7H7L3 8H-2Z" fill="#dc8159" stroke="${palette.paper}" stroke-width="1.5"/>
      <path d="M0-4v5" stroke="${palette.ink}" stroke-width="2"/>
    </g>
    <g opacity="${between(frame, 28, 37)}" transform="translate(46 ${62 - sway * .5}) rotate(-8)">
      ${rect(-24, -12, 48, 25, palette.accent, `stroke="${palette.ink}" stroke-width="2"`)}
      ${text('JAM', 0, 6, 18, palette.ink, 'text-anchor="middle"')}
    </g>
    <path d="M17 91h125" stroke="${palette.paper}" stroke-width="1"/>
    ${[0, 1, 2].map((index) => rect(85 + index * 7, 83, 4, 3, palette.paper, `opacity="${.4 + jam * .5}"`)).join('')}
    ${motes(frame, palette.paper)}
  `
}

function bottledIt(frame: number, palette: Palette) {
  const door = between(frame, 11, 25) * 17 - between(frame, 46, 61) * 8
  const runners = [27, 57, 86].map((startX, index) => {
    const start = 10 + (2 - index) * 6
    const run = between(frame, start, 39 + (2 - index) * 5)
    const stride = Math.sin(frame * .8 + index * 2) * (run > 0 && run < 1 ? 4 : 1)
    const bob = Math.sin(frame * .4 + index) * (1 - run) * 1.2
    return `<g opacity="${1 - between(frame, 36 + (2 - index) * 5, 41 + (2 - index) * 5)}">
      ${fighter(startX + run * (151 - startX), 83 - run * 4 + bob, stride, { ...palette, accent: index % 2 ? palette.paper : palette.accent }, 10 * run, 1 - run * .25)}
    </g>`
  }).join('')
  const boot = between(frame, 30, 43)
  const swing = Math.sin(frame * .12) * 2
  return `
    <defs><clipPath id="event-hallway">${rect(5, 29, 137, 65, '#fff')}</clipPath></defs>
    <path d="M8 37l106 10M8 86l106-9M44 39v44M80 42v37" fill="none" stroke="${palette.mid}" stroke-width="2"/>
    <path d="M0 94l116-18h31l13 18Z" fill="${palette.ink}"/>
    <path d="M21 94l95-18M65 94l59-18M111 94l22-18" stroke="${palette.mid}" stroke-width="1.5"/>
    ${rect(113, 32, 40, 54, palette.ink)}
    ${rect(117, 46, 31, 36, palette.paper)}
    <path d="M117 49L71 83h46Z" fill="${palette.paper}" opacity=".12"/>
    <g transform="translate(133 33) rotate(${swing})">
      ${rect(-18, 0, 37, 12, palette.accent)}
      ${text('EXIT', 1, 10, 10, palette.ink, 'text-anchor="middle"')}
    </g>
    <path d="M123 61h17m-6-6 6 6-6 6" fill="none" stroke="${palette.ink}" stroke-width="3"/>
    ${rect(140 + door, 46, 13, 36, palette.mid, `stroke="${palette.ink}" stroke-width="2"`)}
    <g clip-path="url(#event-hallway)">${runners}</g>
    <g opacity="${between(frame, 31, 37)}" transform="translate(${39 + boot * 20} ${82 - Math.sin(boot * Math.PI) * 14}) rotate(${-40 + boot * 43 + Math.sin(frame * .15) * .8})">
      <path d="M-12-10h12v7l11 3v5h-25V-3Z" fill="${palette.accent}" stroke="${palette.ink}" stroke-width="1.5"/>
      <path d="M-13 3h24M-6-7h5m-5 3h5" stroke="${palette.paper}" stroke-width="2"/>
    </g>
    <g opacity="${between(frame, 42, 49)}" transform="translate(45 48) rotate(${-5 + swing})">
      <path d="M-13 0l13-12L13 0" fill="none" stroke="${palette.paper}" stroke-width="1"/>
      ${rect(-23, -2, 46, 20, palette.paper, `stroke="${palette.ink}" stroke-width="2"`)}
      ${text('BRB.', 0, 12, 14, palette.ink, 'text-anchor="middle"')}
    </g>
    ${motes(frame, palette.paper)}
  `
}

const scenes: Record<GameEventId, Scene> = {
  'failed-jump': {
    palette: { ink: '#172830', field: '#244a53', paper: '#f2e4b4', accent: '#d9b440', mid: '#497581' },
    titleSize: 17.5,
    setup: ['MIND THE GAP.', 'PROBABLY FINE.'],
    action: ['COMMITMENT: HIGH.', 'TRAJECTORY: LOW.'],
    draw: failedJump,
  },
  fatality: {
    palette: { ink: '#261c28', field: '#402331', paper: '#ecd9b8', accent: '#ce7963', mid: '#724859' },
    titleSize: 20,
    setup: ['TOKEN ON DUTY.', 'PAPERWORK READY.'],
    action: ['STATUS UPDATED.', 'STAMP IT OUT.'],
    draw: fatality,
  },
  'dice-fail': {
    palette: { ink: '#132f43', field: '#27617b', paper: '#edf0cc', accent: '#6fb5cb', mid: '#3a7789' },
    titleSize: 20,
    setup: ['THREE DICE.', 'WHAT COULD GO WRONG?'],
    action: ['ROLLING...', 'HOPE NOT INCLUDED.'],
    draw: diceFail,
  },
  'critical-hit': {
    palette: { ink: '#342222', field: '#c35e36', paper: '#ffe0aa', accent: '#e8b756', mid: '#884635' },
    titleSize: 17.4,
    setup: ['LINE IT UP.', 'MAKE IT COUNT.'],
    action: ['RIGHT ON TARGET.', 'VERY MUCH NOTED.'],
    draw: criticalHit,
  },
  'ammo-jam': {
    palette: { ink: '#253629', field: '#788963', paper: '#ebebba', accent: '#d0af50', mid: '#4c6244' },
    titleSize: 20,
    setup: ['SYSTEM CHECK.', 'ALL VERY NORMAL.'],
    action: ['CLICK. CLUNK.', 'NOTHING.'],
    draw: ammoJam,
  },
  'bottled-it': {
    palette: { ink: '#142f2a', field: '#285b4c', paper: '#e7e8ac', accent: '#b1c860', mid: '#598465' },
    titleSize: 18.5,
    setup: ['MORALE CHECK.', 'EXIT LOCATED.'],
    action: ['NOT A RETREAT.', 'A RELOCATION.'],
    draw: bottledIt,
  },
}

export const gameEventArtworks: Artwork[] = gameEvents.map((preset) => {
  const scene = scenes[preset.id]
  const palette = scene.palette
  const ending = detailLines(preset.detail)
  return {
    clip: clip(preset.clipId, preset.title, preset.detail, 'event', palette.accent),
    frame: (frame) => {
      const copy = frame < 14 ? scene.setup : frame < 40 ? scene.action : ending
      return svg(frame, palette.field, `
        <defs><clipPath id="event-scene">${rect(5, 29, 150, 65, '#fff')}</clipPath></defs>
        <g clip-path="url(#event-scene)">${scene.draw(frame, palette)}</g>
        ${rivets(palette)}
        ${rect(0, 0, 160, 28, palette.ink)}
        ${text(preset.title.toUpperCase(), 80, 21, scene.titleSize, palette.paper, 'text-anchor="middle" letter-spacing="-.5"')}
        ${rect(5, 26, 150, 2, palette.accent)}
        ${rect(0, 95, 160, 25, palette.ink)}
        ${rect(5, 95, 150, 1, palette.accent)}
        ${text(copy[0], 80, 106, 8.5, palette.paper, 'text-anchor="middle"')}
        ${text(copy[1], 80, 116, 8.5, palette.paper, 'text-anchor="middle"')}
      `, palette.paper)
    },
  }
})
