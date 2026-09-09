import { bars, clip, FRAME_COUNT, label, rect, svg, tau, text, type Artwork } from './content-primitives.ts'

function cleanAir(frame: number) {
  const ink = '#122f3b'
  const cyan = '#bce7e4'
  const white = '#effbf0'
  const phase = frame / FRAME_COUNT * tau
  const bubbles = Array.from({ length: 7 }, (_, i) => {
    const progress = (frame / FRAME_COUNT + i / 7) % 1
    return `<circle cx="${49 + progress * 100}" cy="${83 - Math.sin(progress * Math.PI) * 25 + i % 3 * 5}" r="${1.4 + i % 3 * .7}" fill="none" stroke="${white}" stroke-width="1.2" opacity="${Math.sin(progress * Math.PI) * .8}"/>`
  }).join('')
  const filter = Array.from({ length: 7 }, (_, i) =>
    `<path d="M${15 + i * 4} 57v22" stroke="${cyan}" stroke-width="2" opacity="${.5 + .25 * Math.sin(phase + i * .5)}"/>`,
  ).join('')
  const blades = Array.from({ length: 5 }, (_, i) => `
    <g transform="rotate(${i * 72} 113 66)">
      <path d="M110 63Q95 47 111 45Q124 43 116 62Z" fill="${cyan}" stroke="${ink}" stroke-width="1"/>
      <path d="M113 49q-5 4 0 13" fill="none" stroke="${white}" stroke-width="1"/>
    </g>
  `).join('')

  return svg(frame, cyan, `
    ${label('MEMBERSHIP HAS ITS ATMOSPHERE', 8, 9, ink, 4.7)}
    ${text('CLEAN AIR', 7, 29, 21, ink, 'letter-spacing="-1"')}
    ${text('CLUB', 8, 45, 15, ink, 'letter-spacing="2"')}
    <path d="M49 62h20l14-9M49 75h21l12 7" stroke="${ink}" stroke-width="7" fill="none"/>
    <path d="M49 62h20l14-9M49 75h21l12 7" stroke="#6a9d9f" stroke-width="3" fill="none"/>
    ${rect(9, 51, 42, 34, ink, 'rx="3"')}
    ${rect(12, 54, 36, 28, '#537e85', 'rx="1"')}
    ${filter}
    <path d="M13 54h34M13 82h34" stroke="${white}" stroke-width="1"/>
    <circle cx="113" cy="66" r="30" fill="${ink}"/>
    <circle cx="113" cy="66" r="27" fill="#5f9b9f" stroke="${white}" stroke-width="1"/>
    <circle cx="113" cy="66" r="23" fill="${ink}"/>
    <g transform="rotate(${frame / FRAME_COUNT * 360} 113 66)">${blades}</g>
    <circle cx="113" cy="66" r="6" fill="${white}" stroke="${ink}" stroke-width="1.5"/>
    <circle cx="113" cy="66" r="2" fill="#5f9b9f"/>
    <path d="M86 56h54M85 66h56M87 76h51M103 39v54M123 39v54" stroke="${white}" stroke-width=".6" opacity=".28"/>
    ${[[94, 47], [132, 47], [94, 85], [132, 85]].map(([x, y]) =>
      `<circle cx="${x}" cy="${y}" r="1.2" fill="${white}"/>`,
    ).join('')}
    ${bubbles}
    ${label('4 CREDITS / BREATH', 9, 93, ink, 5.2)}
    ${bars(frame, 139, 87, ink)}
    ${rect(0, 100, 160, 20, ink)}
    ${text(frame < 32 ? 'BREATHE EASY.' : 'TERMS APPLY.', 80, 114, 14.2, white, 'text-anchor="middle" letter-spacing="-.5"')}
  `, white)
}

function secondHands(frame: number) {
  const rust = '#be6036'
  const ink = '#352a23'
  const cream = '#f3ddad'
  const steel = '#939688'
  const phase = frame / FRAME_COUNT * tau
  const fingers = [-14, -3, 8].map((x, i) => {
    const bend = -9 + Math.sin(phase + i * .55) * 12
    return `
      <g transform="translate(${x} -10) rotate(${bend})">
        ${rect(-4, -17 - i % 2 * 3, 8, 19 + i % 2 * 3, steel, `rx="2" stroke="${ink}" stroke-width="1.5"`)}
        <path d="M-1-15v11" stroke="${cream}" stroke-width="1.5"/>
        <g transform="translate(0 ${-16 - i % 2 * 3}) rotate(${-12 + Math.sin(phase + i * .7) * 22})">
          <path d="M-4 0v-10q4-5 8 0V0" fill="${cream}" stroke="${ink}" stroke-width="1.5"/>
          <path d="M-3-7h6" stroke="${rust}" stroke-width="2"/>
        </g>
        <circle cy="${-16 - i % 2 * 3}" r="3" fill="${ink}" stroke="${cream}" stroke-width=".8"/>
        <circle r="3.5" fill="${ink}" stroke="${cream}" stroke-width="1"/>
      </g>
    `
  }).join('')

  return svg(frame, rust, `
    ${rect(5, 5, 150, 92, 'none', `stroke="${ink}" stroke-width=".8"`)}
    ${label('JOINT VENTURES SINCE 904', 9, 12, cream, 4.7)}
    ${text('SECOND', 8, 31, 19, cream, 'letter-spacing="-.9"')}
    ${text('HANDS', 8, 51, 22, ink, 'letter-spacing="-.8"')}
    ${rect(9, 58, 63, 1, ink)}
    ${text('REPAIR.', 9, 72, 10.5, cream)}
    ${text('REPEAT.', 9, 84, 10.5, cream)}
    <path d="M72 73h8l9 7" fill="none" stroke="${ink}" stroke-width=".8"/>
    <ellipse cx="118" cy="96" rx="27" ry="2" fill="${ink}" opacity=".25"/>
    <g transform="translate(118 ${74 + Math.sin(phase) * 1.4}) rotate(${Math.sin(phase) * 4})">
      <path d="M-12 12v12h24V12" fill="${steel}" stroke="${ink}" stroke-width="2"/>
      <path d="M-5 15v9M5 15v9" stroke="${ink}" stroke-width="2"/>
      ${fingers}
      <g transform="translate(-18 2) rotate(${-45 + Math.sin(phase + .7) * 13})">
        ${rect(-5, -19, 9, 20, steel, `rx="3" stroke="${ink}" stroke-width="1.5"`)}
        <path d="M-5-17v-8h9v8" fill="${cream}" stroke="${ink}" stroke-width="1.5"/>
        <circle cy="-16" r="3" fill="${ink}"/>
      </g>
      <path d="M-19-11H17l4 19-10 10H-11l-10-10Z" fill="${cream}" stroke="${ink}" stroke-width="2"/>
      <path d="M-13-5H11l3 11-6 6H-8l-7-7Z" fill="${steel}" stroke="${ink}" stroke-width="1"/>
      <path d="M-7-3v10M0-3v10M7-3v10" stroke="${ink}" stroke-width="2"/>
      <circle cx="-15" cy="-7" r="1.3" fill="${ink}"/><circle cx="14" cy="-7" r="1.3" fill="${ink}"/>
      <path d="M-16 9l6 5M12 12l5-5" stroke="${rust}" stroke-width="2"/>
    </g>
    ${rect(0, 102, 160, 18, cream)}
    ${text(frame < 32 ? 'PRE-OWNED.' : 'MOSTLY LOYAL.', 80, 115, 14, ink, 'text-anchor="middle" letter-spacing="-.6"')}
    ${Array.from({ length: 20 }, (_, i) => `<path d="M${i * 9} 101l4-3" stroke="${ink}" stroke-width="2"/>`).join('')}
  `, cream)
}

function shaftNine(frame: number) {
  const ink = '#112c24'
  const green = '#8cd48c'
  const pale = '#def2b1'
  const dim = '#2d5941'
  const phase = frame / FRAME_COUNT * tau
  const cabinY = 36 + (1 - Math.cos(phase)) * 17.5
  const door = 2 + (1 + Math.sin(phase)) * 3
  const floors = [36, 55, 74].map((y, i) => `
    ${rect(86, y, 14, 15, dim)}
    ${rect(139, y, 9, 15, dim)}
    ${rect(88, y + 2, 4, 5, green, 'opacity=".32"')}
    <path d="M83 ${y + 16}h18m36 0h14" stroke="${green}" stroke-width="1.5"/>
    ${label(`0${i + 1}`, 89, y + 12, pale, 4.5)}
  `).join('')

  return svg(frame, ink, `
    ${rect(5, 5, 150, 92, 'none', `stroke="${dim}" stroke-width="1"`)}
    ${text('SHAFT NINE', 80, 24, 19.5, green, 'text-anchor="middle" letter-spacing="-.7"')}
    ${label('VERTICAL TRANSIT AUTHORITY', 9, 34, green, 4.6)}
    ${text('-09', 9, 63, 28, pale, 'letter-spacing="-2"')}
    ${label('CALL REGISTERED', 9, 74, green, 5.2)}
    <path d="M68 61V46m-5 6 5-7 5 7" stroke="${green}" stroke-width="2" fill="none"/>
    <circle cx="18" cy="83" r="3" fill="${green}"/>
    <path d="M18 86v9m-4-7h8m-4 3-4 5m4-5 4 5" stroke="${green}" stroke-width="1.7" fill="none"/>
    ${rect(30, 82, 44, 12, dim)}
    ${label('PLEASE WAIT', 34, 90, pale, 5)}
    ${rect(83, 29, 68, 66, 'none', `stroke="${green}" stroke-width="1"`)}
    ${floors}
    <path d="M102 31v61M136 31v61" stroke="${dim}" stroke-width="2"/>
    <path d="M116 32v${cabinY - 32}m7 ${32 - cabinY}v${cabinY - 32}" stroke="${green}" stroke-width=".7"/>
    <circle cx="119.5" cy="33" r="2.5" fill="${ink}" stroke="${green}" stroke-width=".8"/>
    <g transform="translate(105 ${cabinY})">
      ${rect(0, 0, 28, 19, green, 'rx="1"')}
      ${rect(2, 3, 24, 14, ink)}
      ${rect(3, 4, 10 - door / 2, 12, dim)}
      ${rect(15 + door / 2, 4, 10 - door / 2, 12, dim)}
      <path d="M6 7h3m10 0h3" stroke="${pale}" stroke-width="1"/>
      <circle cx="14" cy="8" r="1.5" fill="${pale}"/>
      <path d="M14 10v5" stroke="${pale}" stroke-width="2"/>
      ${rect(9, 1, 10, 1, pale)}
    </g>
    <path d="M153 ${cabinY + 9}h-4" stroke="${pale}" stroke-width="2"/>
    ${rect(5, 101, 150, 16, green)}
    ${text(frame < 32 ? 'NEXT LIFT:' : 'EVENTUALLY.', 80, 114, 14, ink, 'text-anchor="middle" letter-spacing="-.3"')}
  `, pale)
}

function guildCredit(frame: number) {
  const ink = '#302d23'
  const gold = '#c8a650'
  const paper = '#ecddab'
  const phase = frame / FRAME_COUNT * tau
  const coins = Array.from({ length: 4 }, (_, i) => {
    const angle = phase + i * tau / 4
    const x = 83 + i * 17
    const y = 89 - (1 + Math.sin(angle)) * 3
    return `
      <ellipse cx="${x}" cy="${y + 6}" rx="7" ry="1.4" fill="${ink}" opacity=".14"/>
      <g transform="translate(${x} ${y}) rotate(${Math.sin(angle) * 12})">
        <ellipse rx="${3 + (1 + Math.cos(angle)) * 2}" ry="6" fill="${gold}" stroke="${ink}" stroke-width="1"/>
        <path d="M0-3v6m-2-4h4m-4 2h4" stroke="${ink}" stroke-width=".8"/>
      </g>
    `
  }).join('')
  const height = 11 + (1 + Math.sin(phase)) * 9

  return svg(frame, gold, `
    ${rect(4, 4, 152, 112, ink)}
    ${rect(7, 7, 146, 106, paper)}
    ${rect(10, 10, 140, 100, 'none', `stroke="${gold}" stroke-width="1"`)}
    <path d="M10 17v-7h7m126 0h7v7M10 103v7h7m126 0h7v-7" fill="none" stroke="${ink}" stroke-width="1"/>
    ${text('GUILD CREDIT', 80, 27, 17.4, ink, 'text-anchor="middle" letter-spacing="-.8"')}
    <path d="M17 33h126" stroke="${gold}" stroke-width="1.5"/>
    ${label('A LIFELONG FINANCIAL RELATIONSHIP', 18, 40, ink, 4.5)}
    <circle cx="45" cy="70" r="25" fill="${gold}" stroke="${ink}" stroke-width="1.5"/>
    <g transform="rotate(${frame / FRAME_COUNT * 360} 45 70)">
      ${Array.from({ length: 24 }, (_, i) => `<path d="M45 47v3" stroke="${paper}" stroke-width="1.6" transform="rotate(${i * 15} 45 70)"/>`).join('')}
      <path d="M26 58q8-14 22-9" fill="none" stroke="${paper}" stroke-width="1.3"/>
    </g>
    <circle cx="45" cy="70" r="17" fill="none" stroke="${ink}" stroke-width=".7"/>
    ${text('GC', 45, 75, 15, ink, 'text-anchor="middle" letter-spacing="-1"')}
    <path d="M37 81h16M41 59h8" stroke="${ink}" stroke-width="1"/>
    ${label('COMPOUND INTEREST', 80, 49, ink, 4.5)}
    ${rect(82, 54, 58, 25, ink)}
    <path d="M85 60h52M85 67h52M85 74h52" stroke="${gold}" stroke-width=".4" opacity=".5"/>
    ${rect(86, 76 - height * .3, 7, height * .3, gold)}
    ${rect(97, 76 - height * .45, 7, height * .45, gold)}
    ${rect(108, 76 - height * .6, 7, height * .6, gold)}
    ${rect(119, 76 - height * .75, 7, height * .75, paper)}
    <path d="M131 72V59m-3 4 3-4 3 4" stroke="${paper}" stroke-width="1" fill="none"/>
    ${coins}
    ${rect(16, 97, 128, 13, ink)}
    ${text(frame < 32 ? 'OWN YOUR DEBT.' : 'FOREVER.', 80, 107.5, 12.3, paper, 'text-anchor="middle" letter-spacing="-.6"')}
  `, paper)
}

function salvageUnion(frame: number) {
  const ochre = '#d6af50'
  const oxide = '#8e4634'
  const ink = '#322b22'
  const cream = '#f1dd9e'
  const phase = frame / FRAME_COUNT * tau
  const magnetX = 108 + Math.sin(phase) * 21
  const magnetY = 60 + Math.cos(phase) * 4
  const scraps = Array.from({ length: 6 }, (_, i) => {
    const x = 3 + ((frame / FRAME_COUNT * 144 + i * 24) % 144)
    return `<g transform="translate(${x} 85)">
      <path d="${i % 2 ? 'M-8 0v-7h4v-4h5v6h7v5Z' : 'M-9 0l3-8 6 3 4-5 7 10Z'}" fill="${i % 2 ? oxide : ink}" stroke="${cream}" stroke-width=".7"/>
    </g>`
  }).join('')

  return svg(frame, ochre, `
    <defs><clipPath id="scrap-belt">${rect(11, 72, 138, 15, '#fff')}</clipPath></defs>
    ${label('THE SALVAGE UNION NEEDS YOU', 8, 9, ink, 4.8)}
    ${text('SALVAGE', 7, 30, 23, ink, 'letter-spacing="-1.2"')}
    ${text('UNION', 8, 48, 18, oxide, 'letter-spacing=".2"')}
    ${text('CLOCK IN.', 9, 64, 8.6, ink)}
    ${text('SORT IT OUT.', 9, 74, 7.5, ink)}
    <path d="M144 84V36H72" fill="none" stroke="${ink}" stroke-width="7"/>
    <path d="M144 83V36H72" fill="none" stroke="${oxide}" stroke-width="3"/>
    <path d="M139 78h10m-10-11h10m-10-11h10m-10-11h10" stroke="${ochre}" stroke-width="1"/>
    ${rect(magnetX - 7, 32, 14, 8, ink, 'rx="1"')}
    <circle cx="${magnetX - 4}" cy="37" r="1.5" fill="${cream}"/>
    <circle cx="${magnetX + 4}" cy="37" r="1.5" fill="${cream}"/>
    <path d="M${magnetX} 40V${magnetY}" stroke="${ink}" stroke-width="1.5"/>
    <g transform="translate(${magnetX} ${magnetY}) rotate(${Math.sin(phase + .4) * 5})">
      <path d="M-12 0v11h8V5h8v6h8V0Z" fill="${oxide}" stroke="${ink}" stroke-width="1.5"/>
      <path d="M-12 8h8m8 0h8" stroke="${cream}" stroke-width="2"/>
      <path d="M-8 13l4-3 3 4 7-2 4 6H-8Z" fill="${ink}" stroke="${cream}" stroke-width=".8"/>
      <circle cx="0" cy="-1" r="2" fill="${ochre}" stroke="${ink}" stroke-width="1.5"/>
    </g>
    <g clip-path="url(#scrap-belt)">${scraps}</g>
    ${rect(9, 85, 143, 10, ink, 'rx="5"')}
    ${Array.from({ length: 13 }, (_, i) => `
      <g transform="translate(${15 + i * 11} 90) rotate(${frame / FRAME_COUNT * 720})">
        <circle r="3" fill="${oxide}" stroke="${cream}" stroke-width=".7"/>
        <path d="M-2 0h4" stroke="${cream}" stroke-width=".7"/>
      </g>
    `).join('')}
    <path d="M19 95v5m123-5v5" stroke="${ink}" stroke-width="3"/>
    ${text(frame < 32 ? 'YOUR SCRAP.' : 'OUR FUTURE.', 80, 113, 15, ink, 'text-anchor="middle" letter-spacing="-.5"')}
    ${rect(0, 117, 160, 3, ink)}
    ${Array.from({ length: 20 }, (_, i) => `<path d="M${i * 10} 120l4-3" stroke="${ochre}" stroke-width="3"/>`).join('')}
  `, cream)
}

function ashWasteTours(frame: number) {
  const sky = '#bf8e8a'
  const rose = '#9c686d'
  const ink = '#3c343c'
  const sand = '#e3bba3'
  const cream = '#f4d8b0'
  const phase = frame / FRAME_COUNT * tau
  const busX = 81 + Math.sin(phase) * 17
  const busY = 73 + Math.sin(phase * 2) * 1.2
  const passengers = Array.from({ length: 5 }, (_, i) => `
    ${rect(-27 + i * 10, -7, 8, 9, ink, 'rx="1"')}
    <path d="M${-26 + i * 10} -6h5v2h-5Z" fill="${sky}"/>
    <circle cx="${-23 + i * 10}" cy="-2" r="1.5" fill="${sand}"/>
  `).join('')

  return svg(frame, sky, `
    <circle cx="128" cy="32" r="27" fill="${cream}"/>
    <circle cx="128" cy="32" r="23" fill="none" stroke="${sky}" stroke-width=".7"/>
    <path d="M104 22h49m-51 5h52m-51 18h49" stroke="${sky}" stroke-width=".7" opacity=".7"/>
    ${text('ASH WASTE', 7, 23, 18, ink, 'letter-spacing="-1"')}
    ${text('TOURS', 7, 46, 26, ink, 'letter-spacing="-1"')}
    ${label('NO RETURN DATE REQUIRED', 9, 56, ink, 4.5)}
    <path d="M0 65Q28 ${48 + Math.sin(phase) * 2} 61 64T123 60T174 63V105H0Z" fill="${rose}"/>
    <path d="M0 76Q37 61 71 76T137 69T175 75V105H0Z" fill="${sand}"/>
    <path d="M0 85Q31 ${77 + Math.cos(phase) * 2} 77 86T166 79V105H0Z" fill="#bf9187"/>
    <path d="M139 60v12m-3-10h6m-8 10h10M149 57v15" stroke="${ink}" stroke-width="1" opacity=".5"/>
    <ellipse cx="${busX}" cy="92" rx="37" ry="3" fill="${ink}" opacity=".18"/>
    <g transform="translate(${busX} ${busY})">
      <path d="M-34-9q0-5 5-5h48l12 7 4 18h-70Z" fill="${cream}" stroke="${ink}" stroke-width="1.5"/>
      <path d="M-32 4h65v6h-65Z" fill="${rose}"/>
      ${passengers}
      <path d="M23-7h4l4 9h-8Z" fill="${ink}"/>
      <path d="M20-8v18" stroke="${ink}" stroke-width="1"/>
      <path d="M-30-15v-5h46v5m-35-5v5m17-5v5" stroke="${ink}" stroke-width="1.3" fill="none"/>
      ${rect(-20, -23, 14, 6, ink, 'rx="1"')}
      ${rect(-3, -21, 12, 4, rose, `stroke="${ink}" stroke-width="1"`)}
      <path d="M-15-22v4m17-2v2" stroke="${sand}" stroke-width="1"/>
      ${[-23, 23].map((x) => `
        <g transform="translate(${x} 11) rotate(${frame / FRAME_COUNT * 720})">
          <circle r="6" fill="${ink}"/><circle r="3" fill="${sand}"/>
          <path d="M-3 0h6M0-3v6" stroke="${ink}" stroke-width="1"/>
        </g>
      `).join('')}
      ${rect(30, 5, 3, 2, cream)}
      ${label('ASH / 01', -13, 9, ink, 4.2)}
    </g>
    ${Array.from({ length: 4 }, (_, i) => {
      const progress = (frame / FRAME_COUNT + i / 4) % 1
      return `<path d="M${busX - 39 - progress * 22} ${87 - progress * 5 + i % 2 * 3}h${4 + progress * 7}" stroke="${cream}" stroke-width="1.3" opacity="${Math.sin(progress * Math.PI) * .8}"/>`
    }).join('')}
    <path d="M0 97q33-9 71 0t89-4v11H0Z" fill="${rose}"/>
    ${rect(0, 103, 160, 17, ink)}
    ${text(frame < 32 ? 'LEAVE THE HIVE.' : 'REGRET THE VIEW.', 80, 115, 12.7, cream, 'text-anchor="middle" letter-spacing="-.6"')}
  `, cream)
}

function missingServitor(frame: number) {
  const paper = '#e3d5b9'
  const ink = '#343330'
  const red = '#ac4940'
  const muted = '#a79f88'
  const phase = frame / FRAME_COUNT * tau
  const scanY = 42 + (1 + Math.sin(phase)) * 23
  const bob = Math.sin(phase * 2) * 1.4

  return svg(frame, paper, `
    <defs><clipPath id="machine-search"><circle cx="111" cy="68" r="29"/></clipPath></defs>
    ${rect(5, 5, 150, 25, red)}
    ${text('MISSING', 80, 25, 24, paper, 'text-anchor="middle" letter-spacing="1"')}
    ${text('SERVITOR', 8, 45, 13, ink, 'letter-spacing="-.5"')}
    ${label('CASE: H-07', 9, 56, red, 5.7)}
    ${rect(9, 61, 60, 1, ink)}
    ${text('LAST SEEN', 9, 73, 8.3, ink)}
    ${text('ON BREAK.', 9, 84, 8.3, ink)}
    ${label('DO NOT REBOOT', 9, 94, red, 4.8)}
    <circle cx="111" cy="68" r="29" fill="none" stroke="${muted}" stroke-width=".8"/>
    <circle cx="111" cy="68" r="23" fill="none" stroke="${muted}" stroke-width=".5" stroke-dasharray="2 3"/>
    <path d="M77 68h8m52 0h8M111 34v8m0 52v6" stroke="${red}" stroke-width=".8"/>
    <g transform="translate(111 ${69 + bob}) rotate(${Math.sin(phase) * 5})">
      <path d="M-21-4l-7 7 5 10m42-15 7 8-5 6" fill="none" stroke="${ink}" stroke-width="3"/>
      <path d="M-26 13l3 3 4-3M19 12l3 3 4-3" fill="none" stroke="${ink}" stroke-width="1.3"/>
      ${[-17, 17].map((x) => `
        <g transform="translate(${x} 19) rotate(${Math.sin(phase) * 50})">
          <circle r="6" fill="${ink}"/><circle r="3" fill="${paper}"/>
          <path d="M-3 0h6M0-3v6" stroke="${ink}" stroke-width="1"/>
        </g>
      `).join('')}
      <path d="M-18-10H16l4 27h-39Z" fill="${muted}" stroke="${ink}" stroke-width="1.5"/>
      ${rect(-13, -5, 25, 17, paper, `rx="2" stroke="${ink}" stroke-width="1"`)}
      ${text('07', 0, 7, 13, ink, 'text-anchor="middle"')}
      <path d="M-9 15h17" stroke="${ink}" stroke-width="1"/>
      <path d="M-3-10v-5" stroke="${ink}" stroke-width="4"/>
      <g transform="rotate(${Math.sin(phase + .5) * -9} -2 -20)">
        ${rect(-14, -28, 26, 14, ink, 'rx="4"')}
        ${rect(-11, -25, 20, 7, paper, 'rx="2"')}
        <circle cx="-6" cy="-21.5" r="2.1" fill="${red}"/>
        <circle cx="4" cy="-21.5" r="2.1" fill="${ink}"/>
        <path d="M7-28l4-7" stroke="${ink}" stroke-width="1.2"/>
        <circle cx="11" cy="-35" r="1.6" fill="${red}"/>
      </g>
      <circle cx="-19" cy="-3" r="2.5" fill="${paper}" stroke="${ink}" stroke-width="1"/>
      <circle cx="18" cy="-3" r="2.5" fill="${paper}" stroke="${ink}" stroke-width="1"/>
    </g>
    <g clip-path="url(#machine-search)">
      ${rect(80, scanY - 3, 62, 6, red, 'opacity=".1"')}
      <path d="M80 ${scanY}h62" stroke="${red}" stroke-width=".8" opacity=".7"/>
    </g>
    ${rect(6, 102, 148, 15, ink)}
    ${text(frame < 32 ? 'ANSWERS TO 07.' : 'REWARD: CREDIT.', 80, 114, 12.5, paper, 'text-anchor="middle" letter-spacing="-.5"')}
    <path d="M7 99h146" stroke="${red}" stroke-width="1" stroke-dasharray="4 2"/>
  `, ink)
}

function powerCoop(frame: number) {
  const ink = '#11283d'
  const blue = '#397cac'
  const pale = '#c8e3dd'
  const yellow = '#ecce54'
  const phase = frame / FRAME_COUNT * tau
  const charge = 7 + (1 + Math.sin(phase)) * 10
  const travel = frame / FRAME_COUNT * 64
  const sparkX = travel < 22 ? 47 + travel : travel < 44 ? 69 : 69 + travel - 44
  const sparkY = travel < 22 ? 77 : travel < 44 ? 77 - (travel - 22) : 55
  const spokes = Array.from({ length: 6 }, (_, i) => `
    <g transform="rotate(${i * 60} 115 68)">
      <path d="M111 47h8l-2 15h-4Z" fill="${blue}" stroke="${pale}" stroke-width=".7"/>
      <path d="M113 49h4" stroke="${yellow}" stroke-width="2"/>
    </g>
  `).join('')

  return svg(frame, ink, `
    ${Array.from({ length: 8 }, (_, i) => `<path d="M${i * 20} 0v101M0 ${i * 16}h160" stroke="${blue}" stroke-width=".4" opacity=".2"/>`).join('')}
    ${label('COMMUNITY CURRENT / METERED', 8, 9, pale, 4.7)}
    ${text('POWER', 7, 30, 24, pale, 'letter-spacing="-1.1"')}
    ${text('CO-OP', 8, 49, 20, yellow, 'letter-spacing="-.6"')}
    ${rect(9, 61, 38, 26, 'none', `rx="2" stroke="${pale}" stroke-width="2"`)}
    ${rect(47, 68, 4, 11, pale)}
    ${rect(13, 65, charge, 18, yellow)}
    <path d="M19 65v18m7-18v18m7-18v18" stroke="${ink}" stroke-width="1"/>
    <path d="M47 77h22V55h20" fill="none" stroke="${blue}" stroke-width="3"/>
    <path d="M47 77h22V55h20" fill="none" stroke="${pale}" stroke-width=".6"/>
    <circle cx="${sparkX}" cy="${sparkY}" r="2" fill="${yellow}" opacity="${.3 + Math.sin(frame / FRAME_COUNT * Math.PI) * .7}"/>
    <path d="M80 91H60v-9" stroke="${blue}" stroke-width="2" fill="none"/>
    <path d="M83 96h63l-5-16H88Z" fill="${blue}" stroke="${pale}" stroke-width="1"/>
    <circle cx="115" cy="68" r="28" fill="${blue}" stroke="${pale}" stroke-width="1.5"/>
    <circle cx="115" cy="68" r="24" fill="${ink}" stroke="${yellow}" stroke-width="1.5"/>
    <g transform="rotate(${frame / FRAME_COUNT * 360} 115 68)">${spokes}</g>
    <circle cx="115" cy="68" r="9" fill="${yellow}" stroke="${ink}" stroke-width="1"/>
    <path d="M115 61l-5 8h5l-1 6 6-9h-5l2-5Z" fill="${ink}"/>
    <circle cx="89" cy="92" r="1.3" fill="${yellow}"/><circle cx="140" cy="92" r="1.3" fill="${yellow}"/>
    ${label('SHARED GRID', 10, 95, pale, 5.4)}
    ${rect(0, 102, 160, 18, yellow)}
    ${text(frame < 32 ? 'KEEP IT ON.' : 'PAY BY THE SPARK.', 80, 115, 12.9, ink, 'text-anchor="middle" letter-spacing="-.6"')}
  `, pale)
}

function sumpShuffle(frame: number) {
  const ink = '#241b36'
  const purple = '#6b4e91'
  const pink = '#ed93bc'
  const cream = '#ecd1df'
  const phase = frame / FRAME_COUNT * tau
  const equalizer = Array.from({ length: 8 }, (_, i) => {
    const height = 10 + (1 + Math.sin(phase * 2 + i * .7)) * 13
    return `
      ${rect(92 + i * 7, 90 - height, 4, height, i % 3 ? pink : purple, 'rx="1"')}
      ${rect(92 + i * 7, 86 - height, 4, 1.5, cream)}
    `
  }).join('')

  return svg(frame, ink, `
    <defs><clipPath id="dance-stage">${rect(5, 35, 150, 64, '#fff')}</clipPath></defs>
    ${rect(5, 5, 150, 25, 'none', `rx="2" stroke="${purple}" stroke-width="1"`)}
    ${text('SUMP SHUFFLE', 80, 23, 18.5, pink, 'text-anchor="middle" letter-spacing="-1"')}
    ${label('NIGHT SHIFT SOCIAL / LEVEL -12', 28, 34, cream, 4.9)}
    <g clip-path="url(#dance-stage)">
      <g transform="rotate(${Math.sin(phase) * 15} 21 38)">
        <path d="M21 38L45 106H103Z" fill="${pink}" opacity=".09"/>
        <path d="M21 38L48 106H72Z" fill="${pink}" opacity=".08"/>
      </g>
      <g transform="rotate(${Math.sin(phase + 1.5) * 17} 138 38)">
        <path d="M138 38L51 106H114Z" fill="${purple}" opacity=".23"/>
      </g>
      <path d="M6 93h148M14 99l29-18m5 18 13-18m18 18V81m32 18-15-18m46 18-31-18" stroke="${purple}" stroke-width=".6" opacity=".6"/>
    </g>
    <path d="M13 38h16m101 0h16" stroke="${pink}" stroke-width="3" opacity=".8"/>
    <circle cx="49" cy="69" r="30" fill="#121521" stroke="${purple}" stroke-width="2"/>
    ${[16, 19, 22, 25, 27].map((r) => `<circle cx="49" cy="69" r="${r}" fill="none" stroke="${purple}" stroke-width=".5" opacity=".6"/>`).join('')}
    <g transform="rotate(${frame / FRAME_COUNT * 360} 49 69)">
      <path d="M23 61a27 27 0 0 1 15-17l7 15a11 11 0 0 0-7 7Z" fill="${cream}" opacity=".1"/>
      <path d="M60 72l16 5a28 28 0 0 1-13 15l-8-15Z" fill="${pink}" opacity=".13"/>
      <circle cx="49" cy="69" r="11" fill="${pink}"/>
      <path d="M41 65q8-9 16 0l-8 4Z" fill="${purple}"/>
      <path d="M44 74h10m-8 2h6" stroke="${ink}" stroke-width="1"/>
    </g>
    <circle cx="49" cy="69" r="2" fill="${cream}"/>
    <g transform="rotate(${Math.sin(phase) * 2} 79 47)">
      <circle cx="79" cy="47" r="4" fill="${purple}" stroke="${pink}" stroke-width=".7"/>
      <path d="M79 47l-3 23-9 8" fill="none" stroke="${ink}" stroke-width="4"/>
      <path d="M79 47l-3 23-9 8" fill="none" stroke="${cream}" stroke-width="1.7"/>
      <path d="M65 75l5 4-4 4-5-4Z" fill="${pink}"/>
    </g>
    ${equalizer}
    ${label('NO QUIET QUITTING', 89, 98, cream, 4.4)}
    ${rect(5, 103, 150, 14, purple)}
    ${text(frame < 32 ? 'ONE MORE SHIFT.' : 'ONE MORE DANCE.', 80, 114, 12.3, cream, 'text-anchor="middle" letter-spacing="-.5"')}
  `, pink)
}

function habBlockThirteen(frame: number) {
  const paper = '#dec69a'
  const brick = '#a6644c'
  const teal = '#386762'
  const ink = '#343c36'
  const cream = '#f2dfb6'
  const phase = frame / FRAME_COUNT * tau
  const liftY = 35 + (1 - Math.cos(phase)) * 22
  const shutter = 3 + (1 + Math.sin(phase)) * 4
  const masonry = Array.from({ length: 9 }, (_, row) =>
    `<path d="M62 ${32 + row * 7}h88m${-82 + row % 2 * 5} 0v5m14-5v5m18-5v5m18-5v5m18-5v5" fill="none" stroke="${paper}" stroke-width=".5" opacity=".35"/>`,
  ).join('')

  return svg(frame, paper, `
    <defs><clipPath id="hab-shutter">${rect(119, 35, 26, 16, '#fff')}</clipPath></defs>
    ${text('HAB BLOCK', 7, 23, 20, ink, 'letter-spacing="-1"')}
    ${text('13', 9, 54, 33, brick, 'letter-spacing="-2"')}
    ${label('ELEVATED LIVING', 8, 96, ink, 4.7)}
    <path d="M16 58v10m29-10v10" stroke="${ink}" stroke-width="1"/>
    <g transform="rotate(${Math.sin(phase) * 5} 30 63)">
      ${rect(7, 63, 47, 25, teal, 'rx="1"')}
      ${rect(9, 65, 43, 21, 'none', `stroke="${paper}" stroke-width=".6"`)}
      ${text('TO LET', 30, 77, 10.8, cream, 'text-anchor="middle" letter-spacing="-.5"')}
      ${label('ASK BELOW', 15, 84, paper, 5)}
      <circle cx="12" cy="67" r="1" fill="${paper}"/><circle cx="48" cy="67" r="1" fill="${paper}"/>
    </g>
    <path d="M61 96V30h90v66" fill="${brick}" stroke="${ink}" stroke-width="1.5"/>
    ${masonry}
    <path d="M59 29h94M62 95h90" stroke="${ink}" stroke-width="3"/>
    <path d="M132 29V15m-5 5h10m-7-4h5" stroke="${teal}" stroke-width="1.1"/>
    ${rect(68, 35, 31, 16, cream)}
    ${rect(119, 35, 26, 16, teal)}
    ${rect(68, 56, 31, 16, teal)}
    ${rect(119, 56, 26, 16, cream)}
    ${rect(68, 77, 31, 16, cream)}
    ${rect(119, 77, 26, 16, '#9eb1a0')}
    <path d="M70 46h25v3H70Zm2-4h5v3h-5Z" fill="${brick}"/>
    <path d="M70 43v8m25-7v7m-26-13h26" stroke="${ink}" stroke-width="1"/>
    <path d="M121 46h20v2m-16 0v3m13-3v3" stroke="${paper}" stroke-width="1"/>
    ${rect(126, 39, 10, 6, ink)}
    ${rect(127, 40, 7, 3, '#91b8a3')}
    <g clip-path="url(#hab-shutter)">
      ${rect(118, 35, 28, shutter, brick)}
      ${Array.from({ length: 4 }, (_, i) => `<path d="M119 ${35 + shutter - i * 2}h26" stroke="${paper}" stroke-width=".6"/>`).join('')}
    </g>
    <path d="M70 58q14 5 27 0" fill="none" stroke="${paper}" stroke-width=".7"/>
    <g transform="rotate(${Math.sin(phase + .5) * 7} 79 60)">
      <path d="M76 60h6l3 3-2 2-2-1v6h-6v-6l-2 1-1-2Z" fill="${paper}"/>
    </g>
    <g transform="rotate(${Math.sin(phase + 1) * -8} 91 60)">
      <path d="M87 60h7v9h-3v-5h-1v5h-3Z" fill="${brick}"/>
    </g>
    <path d="M121 68h22m-19-1V57h5v5" stroke="${teal}" stroke-width="2" fill="none"/>
    <path d="M133 64h6v4h-6Z" fill="${brick}"/>
    <path d="M139 64h3v3h-3" stroke="${brick}" stroke-width="1" fill="none"/>
    <path d="M71 84h23v6H71Zm2-4h19v6H73Z" fill="${teal}"/>
    <path d="M73 90v2m19-2v2m-10-11v5" stroke="${ink}" stroke-width="1"/>
    <circle cx="138" cy="81" r="3" fill="${cream}"/>
    <path d="M119 91l9-8 8 5 9-4v9h-26Z" fill="${teal}" opacity=".6"/>
    <path d="M119 85h26m-22 0v8m6-8v8m6-8v8m6-8v8" stroke="${ink}" stroke-width=".8"/>
    ${rect(104, 33, 10, 61, ink)}
    <path d="M106 34v59m6-59v59" stroke="${paper}" stroke-width=".5"/>
    <path d="M109 33V${liftY}" stroke="${paper}" stroke-width=".7"/>
    <g transform="translate(105 ${liftY})">
      ${rect(0, 0, 8, 12, teal, `stroke="${cream}" stroke-width=".6"`)}
      <path d="M4 1v10m-3-9h6" stroke="${cream}" stroke-width=".5"/>
    </g>
    <path d="M65 53h36m16 0h32M65 74h36m16 0h32" stroke="${ink}" stroke-width="2"/>
    ${rect(0, 102, 160, 18, teal)}
    ${text(frame < 32 ? 'ROOMS WITH A VIEW.' : 'WALL OPTIONAL.', 80, 115, 12.2, cream, 'text-anchor="middle" letter-spacing="-.7"')}
  `, cream)
}

export const extraArtworks: Artwork[] = [
  {
    clip: clip('clean-air', 'Clean Air Club', 'Breathe easy. Terms apply.', 'advert', '#bce7e4'),
    frame: cleanAir,
  },
  {
    clip: clip('second-hands', 'Second Hands', 'Pre-owned. Mostly loyal.', 'advert', '#be6036'),
    frame: secondHands,
  },
  {
    clip: clip('shaft-nine', 'Shaft Nine', 'Next lift: eventually.', 'notice', '#8cd48c'),
    frame: shaftNine,
  },
  {
    clip: clip('guild-credit', 'Guild Credit', 'Own your debt. Forever.', 'advert', '#c8a650'),
    frame: guildCredit,
  },
  {
    clip: clip('salvage-union', 'Salvage Union', 'Your scrap. Our future.', 'advert', '#d6af50'),
    frame: salvageUnion,
  },
  {
    clip: clip('ash-waste-tours', 'Ash Waste Tours', 'Leave the hive. Regret the view.', 'advert', '#bf8e8a'),
    frame: ashWasteTours,
  },
  {
    clip: clip('missing-servitor', 'Missing Servitor', 'Answers to 07. Reward: credit.', 'notice', '#ac4940'),
    frame: missingServitor,
  },
  {
    clip: clip('power-coop', 'Power Co-op', 'Keep it on. Pay by the spark.', 'advert', '#397cac'),
    frame: powerCoop,
  },
  {
    clip: clip('sump-shuffle', 'Sump Shuffle', 'One more shift. One more dance.', 'advert', '#ed93bc'),
    frame: sumpShuffle,
  },
  {
    clip: clip('hab-block-thirteen', 'Hab Block 13', 'Rooms with a view. Wall optional.', 'advert', '#a6644c'),
    frame: habBlockThirteen,
  },
]
