import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Broadcast, Clip, Command } from '../shared/types.ts'
import { writePrivateJson } from './config.ts'

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
])

const savedStateSchema = z.object({
  clipId: z.string(), paused: z.boolean(), loop: z.boolean(),
  position: z.number().min(0), round: z.number().int().min(1).max(99),
  queue: z.array(z.string()).max(32),
})

export class Station {
  private state: Broadcast
  private anchor: number
  private seenCommands = new Map<string, { fingerprint: string; at: number }>()
  private stateFile: string | undefined
  constructor(public library: Clip[], dataDir?: string, private clock = Date.now) {
    if (!library.length) throw new Error('No content found. Run npm run content first.')
    const now = clock()
    this.state = {
      revision: 1, clipId: library[0].id, paused: false, loop: false,
      startedAt: now, position: 0, round: 1, event: null, queue: [],
    }
    this.anchor = now
    if (dataDir) {
      this.stateFile = path.join(dataDir, 'station.json')
      if (existsSync(this.stateFile)) {
        const saved = savedStateSchema.parse(JSON.parse(readFileSync(this.stateFile, 'utf8')))
        if (library.some((clip) => clip.id === saved.clipId)) {
          Object.assign(this.state, saved, { queue: saved.queue.filter((id) => library.some((clip) => clip.id === id)) })
          this.state.position = Math.min(saved.position, this.clip.duration - 1 / this.clip.fps)
        }
      }
    }
  }

  get clip() { return this.library.find((clip) => clip.id === this.state.clipId)! }

  private save() {
    if (this.stateFile) writePrivateJson(this.stateFile, {
      clipId: this.state.clipId, paused: this.state.paused, loop: this.state.loop,
      position: this.state.position, round: this.state.round, queue: this.state.queue,
    })
  }

  private select(id: string, now: number) {
    if (!this.library.some((clip) => clip.id === id)) throw new Error('Unknown clip.')
    this.state.clipId = id
    this.state.position = 0
    this.state.startedAt = now
    this.anchor = now
  }

  private step(direction: number, now: number) {
    const index = this.library.findIndex((clip) => clip.id === this.state.clipId)
    const next = (index + direction + this.library.length) % this.library.length
    this.select(this.library[next].id, now)
  }

  snapshot(): Broadcast {
    const now = this.clock()
    if (!this.state.paused) {
      this.state.position += Math.max(0, now - this.anchor) / 1000
      this.anchor = now
      // Collapse whole cycles after a sleeping Mac without an unbounded catch-up loop.
      if (!this.state.queue.length) {
        const cycle = this.state.loop ? this.clip.duration : this.library.reduce((sum, clip) => sum + clip.duration, 0)
        this.state.position %= cycle
      }
      let transitions = 0
      while (this.state.position >= this.clip.duration && transitions < this.library.length + 33) {
        const remaining = this.state.position - this.clip.duration
        const next = this.state.queue.shift()
        if (next) this.select(next, now - remaining * 1000)
        else if (this.state.loop) this.select(this.state.clipId, now - remaining * 1000)
        else this.step(1, now - remaining * 1000)
        this.state.position = remaining
        this.anchor = now
        this.state.revision++
        transitions++
      }
      if (transitions) this.save()
    }
    if (this.state.event && now >= this.state.event.expiresAt) {
      this.state.event = null
      this.state.revision++
    }
    return { ...this.state, queue: [...this.state.queue], event: this.state.event ? { ...this.state.event } : null }
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
    this.snapshot()
    const before = { ...this.state, queue: [...this.state.queue] }
    const previousAnchor = this.anchor
    switch (command.action) {
      case 'play': this.select(command.clipId, now); this.state.paused = false; this.state.event = null; break
      case 'replay': this.select(this.state.clipId, now); this.state.paused = false; break
      case 'next': this.step(1, now); break
      case 'previous': this.step(-1, now); break
      case 'toggle-pause': this.state.paused = !this.state.paused; this.anchor = now; break
      case 'loop': this.state.loop = command.enabled; break
      case 'queue':
        if (!this.library.some((clip) => clip.id === command.clipId)) throw new Error('Unknown clip.')
        if (this.state.queue.length >= 32) throw new Error('The queue is full. Remove a queued clip first.')
        this.state.queue.push(command.clipId)
        break
      case 'clear-queue': this.state.queue = []; break
      case 'round':
        this.state.round = command.round
        this.state.event = { title: `CYCLE ${String(command.round).padStart(2, '0')}`, detail: 'SHIFT QUOTA INCREASED', expiresAt: now + 6000 }
        break
      case 'event':
        this.state.event = { title: command.title, detail: command.detail, expiresAt: now + command.duration * 1000 }
        break
      case 'clear-event': this.state.event = null; break
    }
    this.state.revision++
    try { this.save() }
    catch (error) {
      this.state = before
      this.anchor = previousAnchor
      throw error
    }
    this.seenCommands.set(requestId, { fingerprint, at: now })
    if (this.seenCommands.size > 1000) this.seenCommands.delete(this.seenCommands.keys().next().value!)
    return this.snapshot()
  }
}
