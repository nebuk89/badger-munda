import type { Broadcast, Clip, Command } from '../shared/types.js'
import { gameEvents } from '../shared/game-events.js'

export interface EngineState extends Broadcast {
  anchor: number
}

function cloneState(state: EngineState): EngineState {
  return {
    ...state,
    queue: [...state.queue],
    event: state.event ? { ...state.event } : null,
  }
}

function programme(library: Clip[]) {
  return library.filter((clip) => clip.category !== 'event')
}

function clipFor(state: EngineState, library: Clip[]) {
  const clip = library.find((entry) => entry.id === state.clipId)
  if (!clip) throw new Error('Unknown current clip.')
  return clip
}

function select(state: EngineState, library: Clip[], id: string, now: number) {
  if (!programme(library).some((clip) => clip.id === id)) throw new Error('Unknown clip.')
  state.clipId = id
  state.position = 0
  state.startedAt = now
  state.anchor = now
}

function step(state: EngineState, library: Clip[], direction: number, now: number) {
  const clips = programme(library)
  const index = clips.findIndex((clip) => clip.id === state.clipId)
  const next = (index + direction + clips.length) % clips.length
  select(state, library, clips[next].id, now)
}

function startGameClip(state: EngineState, library: Clip[], id: string, now: number) {
  const clip = library.find((entry) => entry.id === id && entry.category === 'event')
  if (!clip) throw new Error('Game event video unavailable. Run npm run content and restart the station.')
  state.event = {
    title: clip.title,
    detail: clip.subtitle,
    clipId: clip.id,
    startedAt: now,
    expiresAt: now + clip.duration * 1000,
  }
}

export function createEngineState(library: Clip[], now: number): EngineState {
  const firstClip = programme(library)[0]
  if (!firstClip) throw new Error('No programme clips found. Run npm run content first.')
  return {
    revision: 1,
    clipId: firstClip.id,
    paused: false,
    loop: false,
    startedAt: now,
    position: 0,
    round: 1,
    event: null,
    queue: [],
    anchor: now,
  }
}

export function restoreEngineState(
  library: Clip[],
  saved: Pick<Broadcast, 'clipId' | 'paused' | 'loop' | 'position' | 'round' | 'queue'>,
  now: number,
): EngineState {
  const state = createEngineState(library, now)
  if (!programme(library).some((clip) => clip.id === saved.clipId)) return state
  Object.assign(state, saved, {
    queue: saved.queue.filter((id) => programme(library).some((clip) => clip.id === id)),
  })
  state.position = Math.min(saved.position, clipFor(state, library).duration - 1 / clipFor(state, library).fps)
  return state
}

export function materializeEngineState(input: EngineState, library: Clip[], now: number): EngineState {
  const state = cloneState(input)
  if (state.event?.clipId) {
    state.anchor = Math.max(state.anchor, Math.min(now, state.event.expiresAt))
  }
  if (!state.paused) {
    state.position += Math.max(0, now - state.anchor) / 1000
    state.anchor = now
    if (!state.queue.length) {
      const cycle = state.loop
        ? clipFor(state, library).duration
        : programme(library).reduce((sum, clip) => sum + clip.duration, 0)
      state.position %= cycle
    }
    let transitions = 0
    while (state.position >= clipFor(state, library).duration && transitions < programme(library).length + 33) {
      const remaining = state.position - clipFor(state, library).duration
      const next = state.queue.shift()
      if (next) select(state, library, next, now - remaining * 1000)
      else if (state.loop) select(state, library, state.clipId, now - remaining * 1000)
      else step(state, library, 1, now - remaining * 1000)
      state.position = remaining
      state.anchor = now
      state.revision++
      transitions++
    }
  }
  state.anchor = now
  if (state.event && now >= state.event.expiresAt) {
    state.event = null
    state.revision++
  }
  return state
}

export function applyEngineCommand(
  input: EngineState,
  library: Clip[],
  command: Command,
  now: number,
): EngineState {
  const state = materializeEngineState(input, library, now)
  switch (command.action) {
    case 'play':
      if (library.some((clip) => clip.id === command.clipId && clip.category === 'event')) {
        startGameClip(state, library, command.clipId, now)
      } else {
        select(state, library, command.clipId, now)
        state.paused = false
        state.event = null
      }
      break
    case 'replay':
      select(state, library, state.clipId, now)
      state.paused = false
      if (state.event?.clipId) state.event = null
      break
    case 'next':
    case 'previous':
      step(state, library, command.action === 'next' ? 1 : -1, now)
      if (state.event?.clipId) state.event = null
      break
    case 'toggle-pause':
      state.paused = !state.paused
      state.anchor = now
      break
    case 'loop':
      state.loop = command.enabled
      break
    case 'queue':
      if (!library.some((clip) => clip.id === command.clipId)) throw new Error('Unknown clip.')
      if (!programme(library).some((clip) => clip.id === command.clipId)) {
        throw new Error('Game events cannot enter the advert queue. Dispatch the event instead.')
      }
      if (state.queue.length >= 32) throw new Error('The queue is full. Remove a queued clip first.')
      state.queue.push(command.clipId)
      break
    case 'clear-queue':
      state.queue = []
      break
    case 'round':
      state.round = command.round
      state.event = {
        title: `CYCLE ${String(command.round).padStart(2, '0')}`,
        detail: 'SHIFT QUOTA INCREASED',
        expiresAt: now + 6000,
      }
      break
    case 'event':
      state.event = {
        title: command.title,
        detail: command.detail,
        expiresAt: now + command.duration * 1000,
      }
      break
    case 'game-event': {
      const preset = gameEvents.find((event) => event.id === command.eventId)
      if (!preset) throw new Error('Unknown game event.')
      startGameClip(state, library, preset.clipId, now)
      break
    }
    case 'clear-event':
      state.event = null
      break
  }
  state.revision++
  return state
}

export function broadcastFromEngine(state: EngineState): Broadcast {
  const { anchor: _anchor, ...broadcast } = cloneState(state)
  return broadcast
}
