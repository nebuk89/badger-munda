import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown, ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, Eye, Film, Flame,
  Link2, ListVideo, LoaderCircle, LockKeyhole, Minus, Pause, Play, Plus, Radio, RadioTower, RefreshCw,
  Repeat2, RotateCcw, Search, ShieldAlert, SkipBack, SkipForward, Smartphone, Trash2, Wifi, WifiOff, X, Zap,
} from 'lucide-react'
import { Toaster, toast } from 'sonner'
import { gameEvents } from '../shared/game-events'
import type { BadgeDevice, Clip, Command, StationState } from '../shared/types'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { BroadcastPreview } from './components/BroadcastPreview'
import { ClipPreview } from './components/ClipPreview'
import { ConnectDialog } from './components/ConnectDialog'
import { GameEventControls } from './components/GameEventControls'
import { HostedBadgesDialog } from './components/HostedBadgesDialog'
import { UploadDialog } from './components/UploadDialog'
import { ApiError, api, command, errorMessage, setCsrfToken, setHostedMode, type Setup } from './lib/api'
import './App.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
})

const formatTime = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60).toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className={`brand ${compact ? 'brand-compact' : ''}`} href="#top" aria-label="Underhive Broadcast home">
      <span className="brand-mark" aria-hidden="true"><RadioTower strokeWidth={1.8} /></span>
      <span className="brand-wordmark">UNDERHIVE<span><i>/</i> BROADCAST</span></span>
    </a>
  )
}

function Pairing({ setup, loading, error, onRetry, sessionNotice }: {
  setup?: Setup
  loading: boolean
  error: Error | null
  onRetry: () => void
  sessionNotice: string
}) {
  const client = useQueryClient()
  const hosted = setup?.authMode === 'password'
  const [pin, setPin] = useState('')
  const pair = useMutation({
    mutationFn: () => api<{ ok: true; csrfToken?: string; expiresAt?: number }>(
      hosted ? '/api/auth/login' : '/api/pair',
      { method: 'POST', body: JSON.stringify(hosted ? { password: pin } : { pin }) },
    ),
    onSuccess: (result) => {
      setCsrfToken(result.csrfToken)
      client.setQueryData<Setup>(['setup'], {
        paired: true,
        name: setup?.name || 'Underhive Broadcast',
        authMode: setup?.authMode,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt,
      })
    },
  })

  return (
    <div className="pairing-page" id="top">
      <header className="pairing-header"><Brand /><span className="eyebrow">SECTOR 07 / PIRATE TELEVISION</span></header>
      <main className="pairing-layout">
        <div className="pairing-story">
          <span className="eyebrow accent-text"><Radio size={15} /> An independent signal</span>
          <h1>SMALL SCREEN.<br /><span>BIG TROUBLE.</span></h1>
          <p>Bring the underhive to your tabletop. Run the adverts, raise the alarm, and give every round a little atmosphere.</p>
          <div className="pairing-insignia" aria-hidden="true"><RadioTower /><span>UHB—07</span><i>KEEP THE SIGNAL ALIVE</i></div>
          <div className="pairing-footnote"><span>{hosted ? 'HOSTED SIGNAL' : 'LOCAL NETWORK'}</span><span>{hosted ? 'PRIVATE CONTROL. PUBLIC AIRWAVES.' : 'NO CLOUD. NO OVERSEERS.'}</span></div>
        </div>
        <section className="access-panel">
          <div className="panel-heading"><span className="eyebrow">Operator access</span><LockKeyhole size={17} /></div>
          {loading ? (
            <div className="access-content"><LoaderCircle className="spin accent-text" size={32} /><h2>FINDING YOUR STATION.</h2><p>{hosted ? 'Checking the hosted service. This should only take a moment.' : 'Checking the Mac connection. This should only take a moment.'}</p></div>
          ) : error ? (
            <div className="access-content">
              <WifiOff className="accent-text" size={32} />
              <h2>NO SIGNAL. YET.</h2>
              <p className="inline-error" role="alert">{errorMessage(error)}</p>
              <p>{hosted ? 'Check the Internet connection, then try again.' : 'Start the station on your Mac. Keep this device on the same Wi-Fi, then try again.'}</p>
              <Button onClick={onRetry}><RefreshCw /> Try connection again</Button>
            </div>
          ) : (
            <form className="access-content" onSubmit={(event) => { event.preventDefault(); if ((hosted ? pin.length > 0 : /^\d{6}$/.test(pin)) && !pair.isPending) pair.mutate() }}>
              <span className="connection-pill"><span className="status-dot connected" /> {hosted ? 'Hosted station found' : 'Mac station found'}</span>
              <h2>{hosted ? <>PRIVATE SIGNAL.<br />AUTHORIZED OPERATORS.</> : <>YOU’RE OFF THE GRID.<br />LET’S GET YOU ON AIR.</>}</h2>
              <p>{hosted ? 'Enter the private controller password.' : 'Enter the six-digit pairing code shown in your Mac terminal.'}</p>
              {sessionNotice && <p className="session-notice" role="status">{sessionNotice}</p>}
              <label className="field-label" htmlFor="pairing-pin">{hosted ? 'Controller password' : 'Station pairing code'}</label>
              <Input
                id="pairing-pin"
                className={hosted ? 'password-input' : 'pin-input'}
                type={hosted ? 'password' : 'text'}
                value={pin}
                onChange={(event) => { setPin(hosted ? event.target.value : event.target.value.replace(/\D/g, '').slice(0, 6)); pair.reset() }}
                inputMode={hosted ? undefined : 'numeric'}
                autoComplete={hosted ? 'current-password' : 'one-time-code'}
                pattern={hosted ? undefined : '[0-9]{6}'}
                maxLength={hosted ? 256 : 6}
                placeholder={hosted ? 'Password' : '000000'}
                required
                disabled={pair.isPending}
                autoFocus
                aria-invalid={pair.isError}
                aria-describedby={pair.isError ? 'pair-error' : undefined}
              />
              {pair.isError && <p id="pair-error" className="inline-error" role="alert">{errorMessage(pair.error)}</p>}
              <Button type="submit" className="pair-submit" disabled={(hosted ? !pin : pin.length !== 6) || pair.isPending}>{pair.isPending ? <LoaderCircle className="spin" /> : <Link2 />}{pair.isPending ? hosted ? 'Unlocking your controller…' : 'Pairing your controller…' : 'Unlock station'}<ArrowRight /></Button>
              <p className="pairing-help"><Smartphone size={17} /> {hosted ? 'The service sends the password through HTTPS. This browser does not store it.' : 'Pair this browser once. Your code stays on the Mac.'}</p>
            </form>
          )}
          <div className="access-footer"><span>UHB / {hosted ? 'HOSTED CONTROL' : 'LOCAL CONTROL'}</span><span>AUTHORIZED PERSONNEL ONLY</span></div>
        </section>
      </main>
      <footer className="pairing-bottom"><span>MADE FOR THE TABLE. NOT THE OVERLORDS.</span><span>UNDERHIVE BROADCAST © 2026</span></footer>
    </div>
  )
}

function useStationTime(updatedAt: number, now: number) {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => { if (!document.hidden) setTick(Date.now()) }, 250)
    return () => window.clearInterval(interval)
  }, [])
  return now + Math.max(0, tick - updatedAt)
}

function deviceReceipt(devices: BadgeDevice[], now: number, offline: boolean) {
  const receiving = devices.filter((device) => device.online && device.lastFrameAt !== null && now - device.lastFrameAt < 10_000)
  const waiting = !devices.length || devices.some((device) => device.online && device.lastFrameAt === null)
  const newest = [...devices].filter((device) => device.lastFrameAt !== null).sort((a, b) => (b.lastFrameAt ?? 0) - (a.lastFrameAt ?? 0))[0]
  return {
    kind: offline ? 'offline' : receiving.length ? 'connected' : waiting ? 'waiting' : 'offline',
    label: offline ? 'Station offline' : receiving.length ? 'Badge connected' : waiting ? 'Waiting for badge' : 'Badge offline',
    receiving,
    newest,
  }
}

const categories: { value: 'all' | Clip['category']; label: string }[] = [
  { value: 'all', label: 'All clips' },
  { value: 'advert', label: 'Adverts' },
  { value: 'notice', label: 'Notices' },
  { value: 'event', label: 'Events' },
  { value: 'custom', label: 'Your uploads' },
]
const presets = [
  { name: 'Power failure', title: 'POWER FAILURE', detail: 'Sector power is down. Watch the shadows.', icon: Zap },
  { name: 'Toxic leak', title: 'TOXIC LEAK', detail: 'Contamination detected. Find higher ground.', icon: Flame },
  { name: 'Lockdown', title: 'LOCKDOWN', detail: 'Sector sealed. No one gets out clean.', icon: ShieldAlert },
]

function EventControls({ state, now, disabled, send }: {
  state: StationState
  now: number
  disabled: boolean
  send: (value: Command, success?: string) => void
}) {
  const [selectedPreset, setSelectedPreset] = useState(0)
  const [title, setTitle] = useState(presets[0].title)
  const [detail, setDetail] = useState(presets[0].detail)
  const [duration, setDuration] = useState('10')
  const activeEvent = state.broadcast.event?.clipId ? null : state.broadcast.event
  const remaining = activeEvent ? Math.max(0, Math.ceil((activeEvent.expiresAt - now) / 1000)) : 0
  const valid = title.trim().length > 0 && Number.isInteger(Number(duration)) && Number(duration) >= 1 && Number(duration) <= 60
  return (
    <section className="panel event-panel" id="events" aria-labelledby="event-heading">
      <div className="panel-heading"><div><span className="section-number">03</span><h2 id="event-heading">DISRUPT THE SIGNAL</h2></div><Zap size={17} className="accent-text" /></div>
      <div className="event-body">
        <p className="muted-copy">Something brewing? Put the whole sector on notice.</p>
        <div className="event-presets" aria-label="Event presets">
          {presets.map((preset, index) => <button key={preset.name} type="button" aria-pressed={selectedPreset === index} className={selectedPreset === index ? 'selected' : ''} onClick={() => { setSelectedPreset(index); setTitle(preset.title); setDetail(preset.detail) }}><preset.icon size={18} /><span>{preset.name}</span></button>)}
        </div>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (valid && !disabled) send({ action: 'event', title: title.trim(), detail: detail.trim(), duration: Number(duration) }, 'Event is now in the broadcast.')
        }}>
          <div className="label-row"><label className="field-label" htmlFor="event-title">Headline</label><span>{title.length}/32</span></div>
          <Input id="event-title" maxLength={32} required value={title} onChange={(event) => { setTitle(event.target.value); setSelectedPreset(-1) }} />
          <div className="label-row"><label className="field-label" htmlFor="event-detail">Message</label><span>{detail.length}/64</span></div>
          <Input id="event-detail" maxLength={64} value={detail} onChange={(event) => { setDetail(event.target.value); setSelectedPreset(-1) }} />
          <div className="event-submit-row">
            <label className="duration-field" htmlFor="event-duration"><span className="field-label">Duration</span><span><Input id="event-duration" type="number" inputMode="numeric" min={1} max={60} step={1} required value={duration} onChange={(event) => setDuration(event.target.value)} /><i>sec</i></span></label>
            <Button type="submit" disabled={disabled || !valid}><Zap /> Broadcast event</Button>
          </div>
        </form>
        {activeEvent && <div className="active-event" role="status"><div><span className="status-dot waiting" /><strong>{activeEvent.title}</strong><span>{remaining > 0 ? `${remaining}s left` : 'Ending…'}</span></div><Button variant="ghost" disabled={disabled} onClick={() => send({ action: 'clear-event' }, 'Event cleared. Regular programming resumed.')}><X /> Clear event</Button></div>}
        <p className="event-note"><CircleAlert size={13} /> Text notices replace the feed briefly. The advert timeline continues underneath.</p>
      </div>
    </section>
  )
}

function Station({ hosted, onUnpaired }: { hosted: boolean; onUnpaired: (message: string) => void }) {
  const client = useQueryClient()
  const [connectOpen, setConnectOpen] = useState(false)
  const [preview, setPreview] = useState<Clip | null>(null)
  const [category, setCategory] = useState<'all' | Clip['category']>('all')
  const [search, setSearch] = useState('')
  const [actionError, setActionError] = useState('')
  const [roundInput, setRoundInput] = useState('')
  const stateQuery = useQuery({
    queryKey: ['station'],
    queryFn: ({ signal }) => api<StationState>('/api/state', { signal }),
    refetchInterval: 1000,
    refetchIntervalInBackground: false,
  })
  const state = stateQuery.data
  const now = useStationTime(stateQuery.dataUpdatedAt, state?.server.now ?? 0)

  const handleFailure = useCallback((error: unknown) => {
    const message = hosted && error instanceof ApiError && error.status === 409
      ? 'Another controller changed the broadcast. The latest state is now loaded.'
      : errorMessage(error)
    setActionError(message)
    toast.error(message)
    if (error instanceof ApiError && error.status === 401) {
      onUnpaired(hosted ? 'Your session expired. Enter the private controller password.' : 'Your session expired. Enter the code shown on the Mac.')
    }
  }, [hosted, onUnpaired])
  useEffect(() => {
    if (stateQuery.error instanceof ApiError && stateQuery.error.status === 401) {
      onUnpaired(hosted ? 'Your session expired. Enter the private controller password.' : 'Your session expired. Enter the code shown on the Mac.')
    }
  }, [hosted, stateQuery.error, onUnpaired])
  const commandMutation = useMutation({
    mutationFn: async (variables: { command: Command; success?: string }) => {
      await client.cancelQueries({ queryKey: ['station'] })
      return command(variables.command, state?.broadcast.revision ?? 0)
    },
    onSuccess: (data, variables) => {
      client.setQueryData<StationState>(['station'], data)
      setActionError('')
      if (variables.success) toast.success(variables.success)
    },
    onError: handleFailure,
    onSettled: () => { void client.invalidateQueries({ queryKey: ['station'] }) },
  })
  const logout = useMutation({
    mutationFn: () => api('/api/logout', { method: 'POST' }),
    onSuccess: () => onUnpaired(hosted ? 'This browser is signed out. The hosted broadcast keeps running.' : 'This browser is disconnected. Your station keeps broadcasting.'),
    onError: handleFailure,
  })
  const revokeAll = useMutation({
    mutationFn: () => api('/api/session/revoke-all', { method: 'POST' }),
    onSuccess: () => onUnpaired('All administrator sessions are revoked. Enter the private controller password.'),
    onError: handleFailure,
  })
  const send = (value: Command, success?: string) => {
    if (commandMutation.isPending || stateQuery.isError) return
    commandMutation.mutate({ command: value, success })
  }

  if (!state) return (
    <div className="station-loading">
      <Brand />
      <section className="panel">
        {stateQuery.isError ? <WifiOff size={32} /> : <LoaderCircle size={32} className="spin" />}
        <h1>{stateQuery.isError ? 'THE SIGNAL WENT QUIET.' : 'TUNING YOUR STATION.'}</h1>
        <p>{stateQuery.isError ? errorMessage(stateQuery.error) : 'Loading your clips and checking the broadcast.'}</p>
        {stateQuery.isError && <Button onClick={() => void stateQuery.refetch()}><RefreshCw /> Try again</Button>}
      </section>
    </div>
  )

  const { broadcast, library } = state
  const currentClip = library.find((clip) => clip.id === broadcast.clipId)
  const gameEvent = broadcast.event?.clipId ? broadcast.event : null
  const onAirClip = gameEvent ? library.find((clip) => clip.id === gameEvent.clipId) : currentClip
  const onAirTitle = gameEvent?.title || currentClip?.title
  const onAirSubtitle = gameEvent?.detail || currentClip?.subtitle
  const onAirPaused = broadcast.paused && !gameEvent
  const disabled = commandMutation.isPending || stateQuery.isError
  const transportDisabled = disabled || !!gameEvent
  const receipt = hosted
    ? {
        kind: stateQuery.isError ? 'offline' : 'connected',
        label: stateQuery.isError ? 'Hosted station offline' : 'Hosted station online',
        receiving: [] as BadgeDevice[],
        newest: undefined,
      }
    : deviceReceipt(state.devices, now, stateQuery.isError)
  const measured = receipt.receiving.find((device) => device.fps > 0)
  const elapsed = broadcast.paused || gameEvent ? 0 : Math.max(0, (now - state.server.now) / 1000)
  const position = broadcast.position + elapsed
  const advertPosition = currentClip?.duration
    ? broadcast.loop ? position % currentClip.duration : Math.min(position, currentClip.duration)
    : 0
  const playbackDuration = gameEvent ? (gameEvent.expiresAt - gameEvent.startedAt) / 1000 : currentClip?.duration || 0
  const playbackPosition = gameEvent ? Math.min(playbackDuration, Math.max(0, (now - gameEvent.startedAt) / 1000)) : advertPosition
  const progress = playbackDuration ? (playbackPosition / playbackDuration) * 100 : 0
  const filteredLibrary = library.filter((clip) => (category === 'all' || category === clip.category) && `${clip.title} ${clip.subtitle}`.toLowerCase().includes(search.toLowerCase()))
  const roundValue = roundInput || String(broadcast.round)
  const validRound = Number.isInteger(Number(roundValue)) && Number(roundValue) >= 1 && Number(roundValue) <= 99

  return (
    <div className="station-shell" id="top">
      <div className="station-topline"><span>SECTOR 07 / PIRATE TELEVISION</span><span>NO PERMISSION. JUST TRANSMISSION.</span></div>
      <header className="station-header">
        <Brand />
        <nav aria-label="Station navigation">
          <a href="#broadcast" className="active"><Radio size={15} /> Broadcast desk</a>
          <a href="#game-events"><Zap size={15} /> Game events</a>
          <a href="#library"><Film size={15} /> Content library</a>
        </nav>
        <div className="header-actions"><span className={`connection-pill ${receipt.kind}`}><span className={`status-dot ${receipt.kind}`} />{receipt.label}</span><Button variant="outline" onClick={() => setConnectOpen(true)}><Link2 /><span>{hosted ? 'Badges' : 'Connect'}</span></Button></div>
      </header>

      <main>
        <section className="desk-intro">
          <div><span className="eyebrow">YOUR TABLETOP. YOUR AIRWAVES.</span><h1>CONTROL THE <span>SIGNAL.</span></h1><p>A little propaganda. A little chaos. All under your control.</p></div>
          <div className="station-stamp" aria-label="Underhive independent station number 07"><span>INDEPENDENT</span><strong>UHB<span>07</span></strong><span>KEEP IT TRANSMITTING</span></div>
        </section>
        {stateQuery.isError && <div className="connection-error" role="alert"><WifiOff /><div><strong>{hosted ? 'Connection to the hosted service lost.' : 'Connection to the Mac lost.'}</strong><p>{errorMessage(stateQuery.error)} Controls are locked until the station responds.</p></div><Button variant="outline" onClick={() => void stateQuery.refetch()}><RefreshCw /> Retry</Button></div>}
        {actionError && <div className="action-error" role="alert"><CircleAlert /><span>{actionError}</span><Button variant="ghost" size="icon" aria-label="Dismiss action error" onClick={() => setActionError('')}><X /></Button></div>}

        <section className="broadcast-desk" id="broadcast" aria-label="Live broadcast desk">
          <div className="panel monitor-panel">
            <div className="panel-heading"><div><span className="section-number">01</span><h2>BROADCAST PREVIEW</h2></div><span className="eyebrow monitor-label"><span className={`status-dot ${stateQuery.isError ? 'offline' : onAirPaused ? 'waiting' : 'connected'}`} />{stateQuery.isError ? 'OFFLINE' : onAirPaused ? 'PAUSED' : 'ON AIR'}</span></div>
            <div className="monitor-housing">
              <span className="screw screw-tl" /><span className="screw screw-tr" /><span className="screw screw-bl" /><span className="screw screw-br" />
              <div className="monitor-top"><span>UHB / FIELD MONITOR</span><span>CH. 07</span></div>
              <div className="monitor-bezel"><BroadcastPreview enabled={!hosted && !stateQuery.isError} title={onAirTitle || 'Station feed'} hosted={hosted} /></div>
              <div className="monitor-bottom"><div className="vent-lines" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><span>{state.server.width} × {state.server.height} / 4:3</span><span className={`status-dot ${stateQuery.isError ? 'offline' : 'connected'}`} /></div>
            </div>
            <div className="device-receipt">
              <div>{receipt.kind === 'connected' ? <Wifi size={17} /> : receipt.kind === 'offline' ? <WifiOff size={17} /> : <Radio size={17} />}<span><strong>{receipt.label}</strong><small>{hosted ? 'Station state is stored in PostgreSQL.' : stateQuery.isError ? 'Receipt cannot be checked.' : receipt.receiving.length ? `${receipt.receiving.length} ${receipt.receiving.length === 1 ? 'device receiving' : 'devices receiving'} · Last frame ${Math.max(0, Math.floor((now - (receipt.newest?.lastFrameAt ?? now)) / 1000))}s ago` : receipt.newest ? `Last frame ${Math.max(0, Math.floor((now - (receipt.newest.lastFrameAt ?? now)) / 1000))}s ago` : 'No badge has received a frame yet.'}</small></span></div>
              <span className={`receipt-fps ${measured ? 'lime-text' : ''}`}>{hosted ? 'DURABLE' : stateQuery.isError ? '—' : measured ? `${measured.fps.toFixed(1)} FPS` : receipt.receiving.length ? 'MEASURING' : 'NO RECEIPT'}<small>{hosted ? 'SHARED STATE' : measured && !stateQuery.isError ? 'MEASURED RECEIPT' : 'BADGE STATUS'}</small></span>
            </div>
            <div className="monitor-disclaimer">{hosted ? 'The hosted foundation stores control state. Media delivery comes in a later layer.' : 'Server preview, not a device screenshot. Badge receipt is reported separately.'}</div>
          </div>

          <div className="panel playback-panel">
            <div className="panel-heading"><div><span className="section-number">02</span><h2>ON THE AIRWAVES</h2></div><span className="eyebrow">{gameEvent ? 'GAME EVENT' : currentClip ? currentClip.category : 'NO CLIP'}</span></div>
            <div className="playback-body">
              <div className="now-playing-label"><span className={`status-dot ${stateQuery.isError ? 'offline' : onAirPaused ? 'waiting' : 'connected'}`} /><span>{stateQuery.isError ? 'CONNECTION LOST' : gameEvent ? 'GAME EVENT ON AIR' : broadcast.event ? 'EVENT OVERRIDE ACTIVE' : broadcast.paused ? 'PLAYBACK PAUSED' : 'NOW TRANSMITTING'}</span>{onAirClip && <span className="clip-reference">CLIP / {String(library.indexOf(onAirClip) + 1).padStart(2, '0')}</span>}</div>
              <h2 className="current-clip-title">{onAirTitle || 'DEAD AIR.'}</h2>
              <p className="current-clip-subtitle">{onAirSubtitle || 'Your next transmission starts in the content library.'}</p>
              {gameEvent && <p className="advert-resume-context"><Pause size={13} aria-hidden="true" /><span>{currentClip ? <><strong>{currentClip.title}</strong> held at {formatTime(advertPosition)}. {broadcast.paused ? 'Returns paused' : 'Resumes here'} after the event.</> : 'No advert selected. The event plays once.'}</span></p>}
              <div className="playback-timeline"><div className="timeline-meta"><span>{formatTime(playbackPosition)}</span><span>{gameEvent ? 'PLAYS ONCE' : broadcast.loop ? <><Repeat2 size={12} /> ON REPEAT</> : 'SINGLE PLAY'}<i> / </i>{formatTime(playbackDuration)}</span></div><div className="timeline-track" role="progressbar" aria-label={gameEvent ? 'Game event playback position' : 'Clip playback position'} aria-valuemin={0} aria-valuemax={playbackDuration || 1} aria-valuenow={playbackPosition}><span style={{ width: `${progress}%` }} /></div></div>
              <div className="transport-controls">
                <Button variant="outline" size="icon" aria-label="Previous clip" disabled={transportDisabled || !library.length} onClick={() => send({ action: 'previous' })}><SkipBack /></Button>
                <Button className="pause-button" disabled={transportDisabled || !currentClip} onClick={() => send({ action: 'toggle-pause' })}>{commandMutation.isPending ? <LoaderCircle className="spin" /> : gameEvent ? <Film /> : broadcast.paused ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}{gameEvent ? 'Event playing' : broadcast.paused ? 'Resume broadcast' : 'Pause broadcast'}</Button>
                <Button variant="outline" size="icon" aria-label="Next clip" disabled={transportDisabled || !library.length} onClick={() => send({ action: 'next' })}><SkipForward /></Button>
              </div>
              <div className="secondary-controls"><Button variant="ghost" disabled={transportDisabled || !currentClip} onClick={() => send({ action: 'replay' })}><RotateCcw /> Replay</Button><Button variant="ghost" className={broadcast.loop ? 'loop-enabled' : ''} aria-pressed={broadcast.loop} disabled={disabled || !currentClip} onClick={() => send({ action: 'loop', enabled: !broadcast.loop })}><Repeat2 /> {gameEvent ? 'Advert loop' : 'Loop'} {broadcast.loop ? 'on' : 'off'}{broadcast.loop && <Check size={12} />}</Button><Button variant="ghost" disabled={hosted || !onAirClip} onClick={() => setPreview(onAirClip ?? null)}><Smartphone /> Preview</Button></div>
              <div className="broadcast-target"><RadioTower size={14} /><span>Playback controls change the {hosted ? 'shared station' : 'badge broadcast'}.</span></div>
            </div>
            <div className="round-controls">
              <div className="round-readout"><span className="eyebrow">BATTLE ROUND</span><strong>{String(broadcast.round).padStart(2, '0')}<span>/ 99</span></strong></div>
              <div className="round-actions"><Button disabled={disabled || broadcast.round >= 99} onClick={() => send({ action: 'round', round: broadcast.round + 1 }, `Round ${broadcast.round + 1} is live.`)}>Next round <Plus /></Button><Button variant="ghost" disabled={disabled || broadcast.round <= 1} onClick={() => send({ action: 'round', round: broadcast.round - 1 }, `Returned to round ${broadcast.round - 1}.`)}><Minus /> Previous round</Button></div>
              <details className="round-set"><summary>Set a round <ChevronDown size={13} /></summary><form onSubmit={(event) => { event.preventDefault(); if (!disabled && validRound) { send({ action: 'round', round: Number(roundValue) }, `Round ${roundValue} is live.`); setRoundInput('') } }}><Input type="number" min={1} max={99} step={1} inputMode="numeric" value={roundValue} aria-label="Battle round number" onChange={(event) => setRoundInput(event.target.value)} /><Button variant="outline" type="submit" disabled={disabled || !validRound}>Set round</Button></form></details>
            </div>
          </div>
        </section>

        <GameEventControls state={state} now={now} disabled={disabled} send={send} onPreview={setPreview} />

        <div className="programming-layout">
          <section className="library-section" id="library" aria-labelledby="library-heading">
            <div className="library-heading"><div><span className="eyebrow">FRESH FROM THE LOWER LEVELS</span><h2 id="library-heading">CONTENT LIBRARY<span>{String(library.length).padStart(2, '0')}</span></h2></div>{!hosted && <UploadDialog onFailure={handleFailure} />}</div>
            <div className="library-toolbar"><div className="library-filters" aria-label="Filter clips by category">{categories.filter((item) => !hosted || item.value !== 'custom').map((item) => <button type="button" key={item.value} aria-pressed={category === item.value} className={category === item.value ? 'active' : ''} onClick={() => setCategory(item.value)}>{item.label}</button>)}</div><label className="library-search"><Search size={17} /><Input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search clips" placeholder="Find a clip…" /></label></div>
            <div className="clip-grid">
              {filteredLibrary.map((clip) => {
                const eventClip = clip.category === 'event'
                const gameEventDefinition = eventClip ? gameEvents.find((event) => event.clipId === clip.id) : undefined
                const active = clip.id === (gameEvent?.clipId || broadcast.clipId)
                return <article key={clip.id} className={`clip-card ${active ? 'is-active' : ''}`}>
                  <button className="clip-poster-button" aria-label={hosted ? `${clip.title} media preview unavailable` : `Preview ${clip.title} on this phone`} disabled={hosted} onClick={() => setPreview(clip)}>
                    <img src={clip.posterUrl} alt={`${clip.title} poster`} loading="lazy" width={160} height={120} />
                    <span className="poster-shade" />
                    <span className="clip-category">{clip.category === 'custom' ? 'YOUR UPLOAD' : clip.category}</span>
                    <span className="poster-preview"><Eye size={20} /><span>Phone preview</span></span>
                    <span className="clip-duration">{formatTime(clip.duration)}</span>
                    {active && <span className="active-clip-tag"><span className="status-dot" />SELECTED</span>}
                  </button>
                  <div className="clip-card-content"><div className="clip-card-title"><h3>{clip.title}</h3>{active && <Radio size={16} className="accent-text" />}</div><p>{clip.subtitle}</p><div className="clip-card-actions"><Button className="play-clip-button" variant={active ? 'default' : 'outline'} disabled={disabled} onClick={() => send(gameEventDefinition ? { action: 'game-event', eventId: gameEventDefinition.id } : { action: 'play', clipId: clip.id }, eventClip ? `${clip.title} dispatched to the broadcast.` : `${clip.title} selected for broadcast.`)}>{eventClip ? <Zap size={13} /> : <Play size={13} fill="currentColor" />} {eventClip ? 'Dispatch once' : hosted ? 'Play on station' : 'Play on badge'}</Button>{!eventClip && <Button variant="outline" size="icon" aria-label={`Add ${clip.title} to queue`} title="Add to queue" disabled={disabled} onClick={() => send({ action: 'queue', clipId: clip.id }, `${clip.title} added to the queue.`)}><Plus /></Button>}</div></div>
                </article>
              })}
            </div>
            {!filteredLibrary.length && <div className="empty-library"><Film size={32} /><h3>{library.length ? 'NOTHING ON THIS FREQUENCY.' : 'YOUR AIRWAVES ARE OPEN.'}</h3><p>{library.length ? 'Try another category or a different search.' : 'Import your first clip to get the station moving.'}</p>{library.length > 0 && <Button variant="outline" onClick={() => { setCategory('all'); setSearch('') }}>Clear filters</Button>}</div>}
            <div className="library-footnote"><Eye size={14} /><span>{hosted ? 'Media previews come in a later layer. ' : 'Tap a poster to preview on your phone without changing the broadcast. '}“{hosted ? 'Play on station' : 'Play on badge'}” selects a clip. “Dispatch once” plays an event, then returns to the advert.</span></div>
          </section>

          <aside className="programming-sidebar">
            <EventControls state={state} now={now} disabled={disabled} send={send} />
            <section className="panel queue-panel" aria-labelledby="queue-heading">
              <div className="panel-heading"><div><ListVideo size={17} /><h2 id="queue-heading">UP NEXT</h2><span className="queue-count">{broadcast.queue.length}</span></div><Button variant="ghost" size="icon" aria-label="Clear queue" title="Clear queue" disabled={disabled || !broadcast.queue.length} onClick={() => send({ action: 'clear-queue' }, 'Queue cleared.')}><Trash2 /></Button></div>
              {broadcast.queue.length ? <ol className="queue-list">{broadcast.queue.map((id, index) => {
                const clip = library.find((entry) => entry.id === id)
                return <li key={`${id}-${index}`}><span className="queue-index">{String(index + 1).padStart(2, '0')}</span>{clip ? <img src={clip.posterUrl} width={56} height={42} alt="" loading="lazy" /> : <Film />}<div><strong>{clip?.title || 'Unavailable clip'}</strong><span>{formatTime(clip?.duration || 0)} / {clip?.category || 'unknown'}</span></div>{index === 0 && <ChevronRight size={16} />}</li>
              })}</ol> : <div className="queue-empty"><ListVideo size={28} /><div><strong>Room for more noise.</strong><p>Use <Plus size={12} /> on a clip to line up your next transmission.</p></div></div>}
              <div className="queue-note"><ArrowDown size={14} /><span>Queued clips play after the current clip ends, even with loop on.</span></div>
            </section>
            <div className="field-note"><RadioTower size={24} /><div><span className="eyebrow">FROM THE FIELD</span><p>{hosted ? 'The shared station keeps its revision and command order in PostgreSQL.' : 'Keep the Mac awake, the badge nearby, and the signal a little questionable.'}</p></div></div>
          </aside>
        </div>
      </main>
      <footer className="station-footer"><div><RadioTower size={16} /><span>UNDERHIVE BROADCAST</span><i> / </i><span>INDEPENDENT BY DESIGN.</span></div><span>SECTOR 07 <i>●</i> {state.server.width} × {state.server.height} PIXELS OF TROUBLE</span></footer>
      <ClipPreview clip={preview} onClose={() => setPreview(null)} />
      {hosted
        ? <HostedBadgesDialog
            open={connectOpen}
            onOpenChange={setConnectOpen}
            onLogout={() => logout.mutate()}
            loggingOut={logout.isPending}
            logoutError={logout.isError ? errorMessage(logout.error) : ''}
            onRevokeAll={() => revokeAll.mutate()}
            revokingAll={revokeAll.isPending}
          />
        : <ConnectDialog
            state={state}
            open={connectOpen}
            onOpenChange={setConnectOpen}
            onLogout={() => logout.mutate()}
            loggingOut={logout.isPending}
            logoutError={logout.isError ? errorMessage(logout.error) : ''}
          />}
    </div>
  )
}

function Controller() {
  const client = useQueryClient()
  const [sessionNotice, setSessionNotice] = useState('')
  const setup = useQuery({ queryKey: ['setup'], queryFn: ({ signal }) => api<Setup>('/api/setup', { signal }), staleTime: 60_000 })
  useEffect(() => {
    setCsrfToken(setup.data?.csrfToken)
    setHostedMode(setup.data?.authMode === 'password')
  }, [setup.data?.authMode, setup.data?.csrfToken])
  const onUnpaired = useCallback((message: string) => {
    setSessionNotice(message)
    setCsrfToken()
    void client.cancelQueries({ queryKey: ['station'] })
    client.removeQueries({ queryKey: ['station'] })
    client.setQueryData<Setup>(['setup'], (old) => ({
      paired: false,
      name: old?.name || 'Underhive Broadcast',
      authMode: old?.authMode,
    }))
  }, [client])
  return <>
    {setup.data?.paired ? <Station hosted={setup.data.authMode === 'password'} onUnpaired={onUnpaired} /> : <Pairing setup={setup.data} loading={setup.isPending} error={setup.error} onRetry={() => void setup.refetch()} sessionNotice={sessionNotice} />}
    <Toaster position="bottom-center" theme="dark" richColors closeButton toastOptions={{ className: 'station-toast' }} />
  </>
}

export default function App() {
  return <QueryClientProvider client={queryClient}><Controller /></QueryClientProvider>
}
