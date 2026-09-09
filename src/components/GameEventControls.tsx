import { CircleAlert, Radio, Smartphone, X, Zap } from 'lucide-react'
import { gameEvents } from '../../shared/game-events'
import type { Clip, Command, StationState } from '../../shared/types'
import { Button } from './ui/button'

interface GameEventControlsProps {
  state: StationState
  now: number
  disabled: boolean
  send: (value: Command, success?: string) => void
  onPreview: (clip: Clip) => void
}

export function GameEventControls({ state, now, disabled, send, onPreview }: GameEventControlsProps) {
  const activeEvent = state.broadcast.event?.clipId ? state.broadcast.event : null
  const remaining = activeEvent ? Math.max(0, Math.ceil((activeEvent.expiresAt - now) / 1000)) : 0
  const missingClips = gameEvents.some((event) => !state.library.some((clip) => clip.id === event.clipId && clip.category === 'event'))

  return (
    <section className="game-events-section" id="game-events" aria-labelledby="game-events-heading">
      <div className="game-events-heading">
        <h2 id="game-events-heading"><Zap aria-hidden="true" /> GAME EVENTS</h2>
        <p>Each 8-second video plays once, then the advert resumes at its saved position. A paused advert stays paused. A new dispatch replaces the active video.</p>
      </div>
      {activeEvent && (
        <div className="game-event-active">
          <div role="status" aria-live="polite" aria-atomic="true">
            <Radio size={18} aria-hidden="true" />
            <strong>{activeEvent.title}</strong>
            <span>{remaining > 0 ? `${remaining}s left` : 'Ending…'}</span>
          </div>
          <Button variant="outline" disabled={disabled} onClick={() => send({ action: 'clear-event' }, 'Game event cancelled. The advert returns to its saved position.')}>
            <X /> Cancel game event
          </Button>
        </div>
      )}
      {missingClips && (
        <p className="game-events-unavailable" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span>Some event videos are unavailable. On the Mac, run <code>npm run content</code>, then restart the station to load them.</span>
        </p>
      )}
      <div className="game-events-grid">
        {gameEvents.map((event) => {
          const clip = state.library.find((entry) => entry.id === event.clipId && entry.category === 'event')
          const active = activeEvent?.clipId === event.clipId
          return (
            <article key={event.id} className={`game-event-card ${active ? 'is-active' : ''}`} aria-labelledby={`game-event-${event.id}`}>
              <button
                type="button"
                className="game-event-poster"
                aria-label={`Preview ${event.title} video on this phone`}
                disabled={disabled || !clip}
                onClick={() => { if (clip) onPreview(clip) }}
              >
                {clip ? <img src={clip.posterUrl} alt={`${event.title} animated event poster`} width={160} height={120} loading="lazy" /> : <CircleAlert aria-hidden="true" />}
                <span><Smartphone size={12} aria-hidden="true" /> {clip ? 'Phone preview' : 'Unavailable'}</span>
              </button>
              <div className="game-event-copy">
                <h3 id={`game-event-${event.id}`}>{event.title}</h3>
                <p>{event.detail}</p>
                <span>{active ? 'ON AIR · ' : ''}8 sec · plays once</span>
              </div>
              <Button
                className="game-event-dispatch"
                aria-label={`Dispatch ${event.title}`}
                disabled={disabled || !clip}
                onClick={() => send({ action: 'game-event', eventId: event.id }, `${event.title} dispatched to the broadcast.`)}
              >
                <Zap size={14} /> {clip ? active ? 'Dispatch again' : 'Dispatch event' : 'Video unavailable'}
              </Button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
