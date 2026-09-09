import type { GameEventId } from './game-events.ts'

export interface Clip {
  id: string
  title: string
  subtitle: string
  category: 'advert' | 'notice' | 'event' | 'custom'
  duration: number
  fps: number
  frameCount: number
  width: number
  height: number
  accent: string
  posterUrl: string
  videoUrl: string
}

interface EventNotice {
  title: string
  detail: string
  expiresAt: number
}

export type BroadcastEvent = EventNotice & (
  | { clipId: string; startedAt: number }
  | { clipId?: never; startedAt?: never }
)

export interface Broadcast {
  revision: number
  clipId: string
  paused: boolean
  loop: boolean
  startedAt: number
  position: number
  round: number
  event: BroadcastEvent | null
  queue: string[]
}

export interface BadgeDevice {
  id: string
  lastSeen: number
  lastFrameAt: number | null
  frameId: number | null
  fps: number
  online: boolean
  awaitingPairing: boolean
  format: string
}

export interface StationState {
  library: Clip[]
  broadcast: Broadcast
  devices: BadgeDevice[]
  server: {
    name: string
    version: string
    width: number
    height: number
    fps: number
    addresses: string[]
    now: number
  }
}

export type Command =
  | { action: 'play'; clipId: string }
  | { action: 'replay' | 'toggle-pause' | 'next' | 'previous' | 'clear-event' | 'clear-queue' }
  | { action: 'loop'; enabled: boolean }
  | { action: 'queue'; clipId: string }
  | { action: 'round'; round: number }
  | { action: 'event'; title: string; detail: string; duration: number }
  | { action: 'game-event'; eventId: GameEventId }
