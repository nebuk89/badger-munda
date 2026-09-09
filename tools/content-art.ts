import { bars, clip, FRAME_COUNT, label, rect, svg, tau, text, type Artwork } from './content-primitives.ts'
import { extraArtworks } from './extra-content-art.ts'
import { gameEventArtworks } from './game-event-art.ts'
export { WIDTH, HEIGHT, FPS, FRAME_COUNT, POSTER_FRAME } from './content-primitives.ts'

function ration(frame: number) {
  const ink = '#20251e'
  const yellow = '#d9b440'
  const paper = '#f0d579'
  const phase = (frame / FRAME_COUNT) * tau
  const angle = -5 + Math.sin(phase) * 5
  const turn = Math.sin(phase) * 5
  const copy = frame < 32
    ? `${text('NEW', 8, 73, 12, ink)}${text('FLAVOUR.', 8, 87, 12, ink)}`
    : `${text('SAME', 8, 73, 12, ink)}${text('NUTRIENTS.', 8, 87, 10.5, ink)}`
  const conveyor = Array.from({ length: 27 }, (_, i) =>
    `<path d="M${i * 8 - (frame % 8)} 119l4-4" stroke="${yellow}" stroke-width="2"/>`,
  ).join('')

  return svg(frame, yellow, `
    <defs>
      <clipPath id="can"><path d="M104 34Q124 41 145 34V78Q125 86 104 78Z"/></clipPath>
    </defs>
    ${rect(0, 0, 160, 15, ink)}
    ${label('CIVIC PROVISIONS // 07', 7, 10, paper)}
    ${bars(frame, 139, 2, yellow)}
    ${text('RATION', 6, 34, 21, ink, 'letter-spacing="-1.2"')}
    ${text('WORKS', 6, 54, 21, ink, 'letter-spacing="-.8"')}
    ${rect(8, 58, 82, 2, ink)}
    ${copy}
    ${label('NET WT 400g', 8, 98, ink)}
    <path d="M78 95h10l9-8" fill="none" stroke="${ink}" stroke-width=".7"/>
    <ellipse cx="126" cy="91" rx="25" ry="3" fill="${ink}" opacity=".17"/>
    <g transform="rotate(${angle} 124 59)">
      <path d="M103 33V79Q124 91 146 79V33Z" fill="${ink}"/>
      <path d="M105 35V77Q124 87 144 77V35Z" fill="#89907a"/>
      <g clip-path="url(#can)">
        ${rect(103, 40, 44, 33, ink)}
        ${rect(106 + turn, 38, 3, 45, '#fbecb7', 'opacity=".5"')}
        ${rect(134 + turn, 36, 9, 46, '#000', 'opacity=".19"')}
        <g transform="translate(${turn} 0)">
          <path d="M116 44h19v3h-7v4h5v3h-5v9h-5V51h-7Z" fill="${yellow}"/>
          ${text('RW', 112, 70, 12, yellow, 'letter-spacing="-1"')}
        </g>
        <path d="M101 39q23 10 48 0M101 75q23 10 48 0M101 78q23 10 48 0" fill="none" stroke="#cad0b1" stroke-width="1"/>
      </g>
      <ellipse cx="124.5" cy="33" rx="22" ry="7" fill="${ink}"/>
      <ellipse cx="124.5" cy="32" rx="20" ry="5" fill="#d4d6b4"/>
      <ellipse cx="124.5" cy="32" rx="16" ry="3" fill="#929c83" stroke="${ink}" stroke-width=".6"/>
      <ellipse cx="${125 + turn / 2}" cy="31.5" rx="5" ry="1.8" fill="${ink}"/>
      <path d="M109 30q14-4 29 0" fill="none" stroke="#eff1cf" stroke-width="1"/>
    </g>
    <g transform="rotate(-9 123 95)">
      ${rect(99, 89, 49, 10, ink)}
      ${rect(101, 91, 45, 6, 'none', `stroke="${yellow}" stroke-width=".5"`)}
      ${text('APPROVED', 104, 96, 6, paper)}
    </g>
    ${rect(0, 103, 160, 17, ink)}
    ${label('FUEL FOR THE NEXT SHIFT', 8, 111, paper, 5.5)}
    ${conveyor}
  `, paper)
}

function curfew(frame: number) {
  const red = '#c64435'
  const ink = '#211c1c'
  const cream = '#f0dfb8'
  const phase = (frame / FRAME_COUNT) * tau
  const buildings = [
    [73, 80, 9, 25], [82, 68, 12, 37], [94, 76, 7, 29], [101, 61, 14, 44],
    [116, 73, 8, 32], [124, 65, 12, 40], [137, 78, 9, 27], [147, 59, 13, 46],
  ].map(([x, y, width, height], i) => `
    ${rect(x, y, width, height, ink)}
    ${rect(x + 2, y + 4, 2, 2, cream, 'opacity=".6"')}
    ${rect(x + 2, y + 11, 2, 2, cream, 'opacity=".4"')}
    ${i % 2 === 0 ? `<path d="M${x + 4} ${y}v-7h3" fill="none" stroke="${ink}" stroke-width="2"/>` : ''}
  `).join('')
  const footer = frame < 32 ? 'REMAIN PRODUCTIVE.' : 'REPORT. REST. REPEAT.'

  return svg(frame, red, `
    <defs><clipPath id="radar"><circle cx="118" cy="76" r="27"/></clipPath></defs>
    ${rect(0, 0, 160, 15, ink)}
    ${label('PUBLIC SAFETY CHANNEL', 7, 10, cream)}
    ${bars(frame, 139, 2, cream)}
    ${text('CURFEW', 6, 37, 28, cream, 'letter-spacing="-1.5"')}
    ${rect(7, 41, 146, 9, cream)}
    ${label('SECTOR 07 / NIGHT DIRECTIVE', 11, 47.5, ink, 5.5)}
    ${rect(0, 95, 160, 10, ink)}
    <path d="M0 90h8v-9h10v12h6v-18h9v20h36v10H0Z" fill="${ink}"/>
    ${buildings}
    <g stroke="${cream}" fill="none" opacity=".35" stroke-width=".6">
      <circle cx="118" cy="76" r="27"/><circle cx="118" cy="76" r="18"/><circle cx="118" cy="76" r="9"/>
      <path d="M91 76h54M118 49v54"/>
    </g>
    <g clip-path="url(#radar)">
      <g transform="rotate(${frame * 360 / FRAME_COUNT} 118 76)">
        <path d="M118 76L118 46A30 30 0 0 1 146 65Z" fill="${cream}" opacity=".16"/>
        <path d="M118 76V47" stroke="${cream}" stroke-width="1.2" opacity=".8"/>
      </g>
    </g>
    ${text('07', 106, 82, 16, cream, 'opacity=".85" letter-spacing="-1"')}
    <circle cx="135" cy="61" r="2" fill="${cream}" opacity="${0.65 + 0.2 * Math.sin(phase)}"/>
    <circle cx="104" cy="91" r="1.5" fill="${cream}" opacity="${0.65 + 0.2 * Math.cos(phase)}"/>
    <path d="M36 52L65 100H7Z" fill="${cream}" stroke="${ink}" stroke-width="2"/>
    <path d="M36 59L59 96H13Z" fill="none" stroke="${red}" stroke-width="1.5"/>
    ${rect(33, 70, 6, 15, ink)}
    ${rect(33, 89, 6, 5, ink)}
    ${rect(0, 105, 160, 15, cream)}
    ${text(footer, 80, 115.5, 7.4, ink, 'text-anchor="middle"')}
    ${rect(4, 108, 2, 9, red)}
    ${rect(154, 108, 2, 9, red)}
  `, cream)
}

function tavern(frame: number) {
  const ink = '#092a27'
  const teal = '#4eb39a'
  const lime = '#d0e66f'
  const cream = '#f1ecc5'
  const phase = (frame / FRAME_COUNT) * tau
  const bob = Math.sin(phase) * 1.2
  const bricks = Array.from({ length: 8 }, (_, row) => `
    <path d="M0 ${row * 15}H160" stroke="#16473f" stroke-width="1"/>
    ${Array.from({ length: 6 }, (_, col) =>
      `<path d="M${col * 32 + (row % 2) * 16} ${row * 15}v15" stroke="#16473f" stroke-width="1"/>`,
    ).join('')}
  `).join('')
  const bubbles = Array.from({ length: 7 }, (_, i) => {
    const travel = (frame * 0.6 + i * 6) % 39
    const x = 25 + ((i * 11) % 33) + Math.sin(phase + i) * 1.5
    return `<circle cx="${x}" cy="${92 - travel}" r="${1 + (i % 2) * .6}" fill="none" stroke="${lime}" stroke-width=".8" opacity=".8"/>`
  }).join('')
  const copy = frame < 32
    ? text('FILTERED TWICE.', 80, 115, 10.5, lime, 'text-anchor="middle" letter-spacing="-.3"')
    : `${text('QUESTIONS COST', 80, 109, 8.3, lime, 'text-anchor="middle"')}${text('EXTRA.', 80, 118, 8.3, lime, 'text-anchor="middle"')}`

  return svg(frame, ink, `
    ${bricks}
    <path d="M16 0v10M144 0v10" stroke="${teal}" stroke-width="2"/>
    <path d="M11 8h138v3h5v26h-5v3H11v-3H6V11h5Z" fill="#061d1c" stroke="#287b67" stroke-width="3"/>
    <path d="M11 8h138v3h5v26h-5v3H11v-3H6V11h5Z" fill="none" stroke="${teal}" stroke-width=".8"/>
    ${text('THE SUMP', 80, 31, 23, '#477a46', 'text-anchor="middle" letter-spacing="-1.3" stroke="#477a46" stroke-width="2"')}
    ${text('THE SUMP', 80, 31, 23, lime, 'text-anchor="middle" letter-spacing="-1.3"')}
    ${label('GOOD COMPANY. BAD AIR.', 18, 48, teal, 5.5)}
    <ellipse cx="48" cy="96" rx="34" ry="3" fill="#000" opacity=".35"/>
    <g transform="translate(0 ${bob})">
      <path d="M64 63h14v5h4v15h-4v5H65" fill="none" stroke="#286953" stroke-width="7"/>
      <path d="M64 62h14v5h4v15h-4v5H65" fill="none" stroke="${teal}" stroke-width="3"/>
      <path d="M18 59h48l-4 34H22Z" fill="#568248" stroke="${teal}" stroke-width="2"/>
      <path d="M23 66h37l-3 24H26Z" fill="#8fa64b"/>
      ${rect(25, 65, 4, 24, '#d0e66f', 'opacity=".5"')}
      ${rect(53, 66, 4, 24, '#305c3e', 'opacity=".55"')}
      ${bubbles}
      <path d="M17 59v-6h6v-4h9v3h7v-5h10v4h8v-1h7v4h5v8h-8v-3h-7v4h-7v-3H31v5h-6v-6Z" fill="${cream}"/>
      <path d="M21 59h8M39 55h8M53 58h9" stroke="#b3c783" stroke-width="1"/>
      <path d="M24 94h36" stroke="${cream}" stroke-width="2"/>
      <path d="M35 75h13v3h-8v3h8v7H35v-3h8v-2h-8Z" fill="${ink}"/>
    </g>
    <circle cx="75" cy="${53 - ((frame * .25) % 8)}" r="2" fill="none" stroke="${teal}" stroke-width="1"/>
    ${text('OPEN', 94, 65, 13, teal, 'letter-spacing=".5"')}
    ${text('LATE', 94, 79, 13, lime, 'letter-spacing="1"')}
    ${rect(94, 83, 52, 1, '#386e54')}
    ${label('LEVEL -09', 96, 92, teal, 6)}
    ${rect(7, 101, 146, 19, '#061d1c')}
    ${rect(7, 100, 146, 1, teal)}
    ${copy}
    ${rect(1, 43, 3, 72, '#287761')}
    ${rect(156, 43, 3, 72, '#287761')}
    ${rect(0, 72, 6, 3, teal)}
    ${rect(154, 85, 6, 3, teal)}
  `, cream)
}

export const artworks: Artwork[] = [
  {
    clip: clip('ration-works', 'Ration Works', 'New flavour. Same nutrients.', 'advert', '#d9b440'),
    frame: ration,
  },
  {
    clip: clip('curfew-signal', 'Curfew Signal', 'Sector 07. Remain productive.', 'notice', '#c64435'),
    frame: curfew,
  },
  {
    clip: clip('sump-tavern', 'The Sump', 'Filtered twice. Questions cost extra.', 'advert', '#4eb39a'),
    frame: tavern,
  },
  ...extraArtworks,
  ...gameEventArtworks,
]
