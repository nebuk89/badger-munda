export const gameEvents = [
  { id: 'failed-jump', clipId: 'event-failed-jump', title: 'Failed Jump', detail: 'Gravity remains undefeated.' },
  { id: 'fatality', clipId: 'event-fatality', title: 'Fatality', detail: 'One less name on the payroll.' },
  { id: 'dice-fail', clipId: 'event-dice-fail', title: 'Dice Fail', detail: 'The odds were not informed.' },
  { id: 'critical-hit', clipId: 'event-critical-hit', title: 'Critical Hit', detail: 'That one left a mark.' },
  { id: 'ammo-jam', clipId: 'event-ammo-jam', title: 'Ammo Jam', detail: 'Percussive maintenance required.' },
  { id: 'bottled-it', clipId: 'event-bottled-it', title: 'Bottled It', detail: 'A tactical change of postcode.' },
] as const

export type GameEventId = typeof gameEvents[number]['id']
