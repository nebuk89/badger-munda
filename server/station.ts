import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Broadcast, Clip, Command } from '../shared/types.ts'
import { gameEvents } from '../shared/game-events.ts'
import { writePrivateJson } from './config.ts'
import {
  applyEngineCommand,
  broadcastFromEngine,
  createEngineState,
  materializeEngineState,
  restoreEngineState,
  type EngineState,
} from './station-engine.ts'

export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play'), clipId: z.string().max(64) }),
  z.object({ action: z.enum(['replay', 'toggle-pause', 'next', 'previous', 'clear-event', 'clear-queue']) }),
  z.object({ action: z.literal('loop'), enabled: z.boolean() }),
  z.object({ action: z.literal('queue'), clipId: z.string().max(64) }),
  z.object({ action: z.literal('round'), round: z.number().int().min(1).max(99) }),
  z.object({
    action: z.literal('event'), title: z.string().trim().min(1).max(32),
    detail: z.string().trim().max(64), duration: z.number().min(1).max(60),
  }),
  z.object({ action: z.literal('game-event'), eventId: z.enum(gameEvents.map((event) => event.id)) }),
])

const savedStateSchema = z.object({
  clipId: z.string(), paused: z.boolean(), loop: z.boolean(),
  position: z.number().min(0), round: z.number().int().min(1).max(99),
  queue: z.array(z.string()).max(32),
})

export class Station {
  private state: EngineState
  private seenCommands = new Map<string, { fingerprint: string; at: number }>()
  private stateFile: string | undefined
  constructor(public library: Clip[], dataDir?: string, private clock = Date.now) {
    const now = clock()
    this.state = createEngineState(library, now)
    if (dataDir) {
      this.stateFile = path.join(dataDir, 'station.json')
      if (existsSync(this.stateFile)) {
        const saved = savedStateSchema.parse(JSON.parse(readFileSync(this.stateFile, 'utf8')))
        this.state = restoreEngineState(library, saved, now)
      }
    }
  }

  get clip() { return this.library.find((clip) => clip.id === this.state.clipId)! }
  get now() { return this.clock() }

  private save() {
    if (this.stateFile) writePrivateJson(this.stateFile, {
      clipId: this.state.clipId, paused: this.state.paused, loop: this.state.loop,
      position: this.state.position, round: this.state.round, queue: this.state.queue,
    })
  }

  snapshot(): Broadcast {
    const now = this.clock()
    const before = this.state.revision
    this.state = materializeEngineState(this.state, this.library, now)
    if (this.state.revision !== before) this.save()
    return broadcastFromEngine(this.state)
  }

  command(command: Command, requestId: string): Broadcast {
    const now = this.clock()
    const fingerprint = JSON.stringify(command)
    for (const [id, entry] of this.seenCommands) {
      if (now - entry.at > 10 * 60_000) this.seenCommands.delete(id)
    }
    const previous = this.seenCommands.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request ID already belongs to a different command.')
      return this.snapshot()
    }
    const before = this.state
    try {
      this.state = applyEngineCommand(this.state, this.library, command, now)
      this.save()
    } catch (error) {
      this.state = before
      throw error
    }
    this.seenCommands.set(requestId, { fingerprint, at: now })
    if (this.seenCommands.size > 1000) this.seenCommands.delete(this.seenCommands.keys().next().value!)
    return broadcastFromEngine(this.state)
  }
}
