import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LoaderCircle, LogOut, RadioTower, RefreshCw, ShieldX, Wifi, WifiOff } from 'lucide-react'
import { api, errorMessage } from '../lib/api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

interface HostedBadge {
  id: string
  label: string
  claimed: boolean
  revoked: boolean
  online: boolean
  lastSeenAt: number | null
  firmwareVersion: string | null
  fps: number
  lastErrorCode: string | null
}

interface BadgeSecret {
  badgeId: string
  badgeSecret: string
  serviceUrl?: string
}

export function HostedBadgesDialog({
  open,
  onOpenChange,
  onLogout,
  loggingOut,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLogout: () => void
  loggingOut: boolean
}) {
  const client = useQueryClient()
  const [label, setLabel] = useState('')
  const [claimCode, setClaimCode] = useState('')
  const [secret, setSecret] = useState<BadgeSecret | null>(null)
  const badges = useQuery({
    queryKey: ['hosted-badges'],
    queryFn: () => api<{ badges: HostedBadge[] }>('/api/badges'),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  })
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['hosted-badges'] })
    void client.invalidateQueries({ queryKey: ['station'] })
  }
  const create = useMutation({
    mutationFn: () => api<BadgeSecret>('/api/badges', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
    onSuccess: (value) => {
      setSecret(value)
      setLabel('')
      refresh()
    },
  })
  const claim = useMutation({
    mutationFn: () => api<{ badgeId: string }>('/api/badges/claim', {
      method: 'POST',
      body: JSON.stringify({ code: claimCode }),
    }),
    onSuccess: () => {
      setClaimCode('')
      refresh()
    },
  })
  const revoke = useMutation({
    mutationFn: (badgeId: string) => api(`/api/badges/${badgeId}/revoke`, { method: 'POST' }),
    onSuccess: refresh,
  })
  const rotate = useMutation({
    mutationFn: (badgeId: string) => api<BadgeSecret>(`/api/badges/${badgeId}/rotate-secret`, { method: 'POST' }),
    onSuccess: (value) => {
      setSecret(value)
      refresh()
    },
  })
  const error = create.error ?? claim.error ?? revoke.error ?? rotate.error ?? badges.error

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="station-dialog hosted-badges-dialog">
        <DialogHeader>
          <span className="eyebrow accent-text"><RadioTower size={14} /> Hosted badge registry</span>
          <DialogTitle>BADGES ON THE SIGNAL.</DialogTitle>
          <DialogDescription>Create, claim, rotate, and revoke badges for the shared station.</DialogDescription>
        </DialogHeader>

        <form className="hosted-badge-form" onSubmit={(event) => {
          event.preventDefault()
          if (label.trim() && !create.isPending) create.mutate()
        }}>
          <label className="field-label" htmlFor="badge-label">New badge label</label>
          <div className="address-row">
            <Input id="badge-label" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Table badge" />
            <Button type="submit" disabled={!label.trim() || create.isPending}>{create.isPending ? <LoaderCircle className="spin" /> : <KeyRound />} Create</Button>
          </div>
        </form>

        {secret && (
          <div className="hosted-secret" role="status">
            <strong>Save this secret now.</strong>
            <p>It appears once. Provision it with badge ID <code>{secret.badgeId}</code>.</p>
            {secret.serviceUrl && <Input readOnly value={secret.serviceUrl} aria-label="Hosted service URL" onFocus={(event) => event.target.select()} />}
            <Input readOnly value={secret.badgeSecret} aria-label="Badge secret" onFocus={(event) => event.target.select()} />
            <Button variant="outline" onClick={() => setSecret(null)}>I saved it</Button>
          </div>
        )}

        <form className="hosted-badge-form" onSubmit={(event) => {
          event.preventDefault()
          if (/^\d{6}$/.test(claimCode) && !claim.isPending) claim.mutate()
        }}>
          <label className="field-label" htmlFor="claim-code">Claim code from badge</label>
          <div className="address-row">
            <Input
              id="claim-code"
              className="pin-input"
              value={claimCode}
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setClaimCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
            />
            <Button type="submit" disabled={claimCode.length !== 6 || claim.isPending}>
              {claim.isPending ? <LoaderCircle className="spin" /> : <Wifi />} Claim
            </Button>
          </div>
        </form>

        <div className="hosted-badge-list">
          <div className="field-label">Registered badges</div>
          {badges.isPending ? <p className="muted-copy">Loading badges…</p> : badges.data?.badges.length ? badges.data.badges.map((badge) => (
            <article className="hosted-badge-row" key={badge.id}>
              <div>
                {badge.online ? <Wifi size={17} /> : <WifiOff size={17} />}
                <span><strong>{badge.label}</strong><small>{badge.revoked ? 'Revoked' : badge.claimed ? badge.online ? `${badge.fps.toFixed(1)} FPS` : 'Claimed, offline' : 'Waiting for claim'}</small></span>
              </div>
              {!badge.revoked && <div>
                <Button variant="outline" size="icon" title="Rotate secret" aria-label={`Rotate secret for ${badge.label}`} onClick={() => rotate.mutate(badge.id)}><RefreshCw /></Button>
                <Button
                  variant="outline"
                  size="icon"
                  title="Revoke badge"
                  aria-label={`Revoke ${badge.label}`}
                  onClick={() => {
                    if (window.confirm(`Revoke ${badge.label}? The badge will lose access immediately.`)) revoke.mutate(badge.id)
                  }}
                >
                  <ShieldX />
                </Button>
              </div>}
            </article>
          )) : <p className="muted-copy">No badges are registered.</p>}
        </div>

        {error && <p className="inline-error" role="alert">{errorMessage(error)}</p>}
        <div className="session-settings">
          <div><strong>Private controller session.</strong><p>Signing out does not stop the hosted broadcast.</p></div>
          <Button variant="outline" disabled={loggingOut} onClick={onLogout}>{loggingOut ? <LoaderCircle className="spin" /> : <LogOut />} Sign out</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
