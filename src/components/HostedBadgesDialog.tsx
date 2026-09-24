import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  KeyRound,
  LoaderCircle,
  LogOut,
  RadioTower,
  RefreshCw,
  ShieldX,
} from 'lucide-react'
import { api, errorMessage } from '../lib/api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

interface HostedBadge {
  id: string
  label: string
  claimed: boolean
  revoked: boolean
  claimedAt: number | null
  revokedAt: number | null
  createdAt: number
  updatedAt: number
}

interface BadgeSecret {
  badgeId: string
  badgeSecret: string
  serviceUrl: string
  reason: 'create' | 'rotate'
}

export function HostedBadgesDialog({
  open,
  onOpenChange,
  onLogout,
  loggingOut,
  logoutError,
  onRevokeAll,
  revokingAll,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLogout: () => void
  loggingOut: boolean
  logoutError: string
  onRevokeAll: () => void
  revokingAll: boolean
}) {
  const client = useQueryClient()
  const [label, setLabel] = useState('')
  const [claimCode, setClaimCode] = useState('')
  const [secret, setSecret] = useState<BadgeSecret | null>(null)
  const badges = useQuery({
    queryKey: ['hosted-badges'],
    queryFn: () => api<{ badges: HostedBadge[] }>('/api/badges'),
    enabled: open,
  })
  const refresh = () => void client.invalidateQueries({ queryKey: ['hosted-badges'] })
  const create = useMutation({
    mutationFn: () => api<Omit<BadgeSecret, 'reason'>>('/api/badges', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
    onSuccess: (value) => {
      setSecret({ ...value, reason: 'create' })
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
    mutationFn: (badgeId: string) => api<Omit<BadgeSecret, 'reason'>>(
      `/api/badges/${badgeId}/rotate-secret`,
      { method: 'POST' },
    ),
    onSuccess: (value) => {
      setSecret({ ...value, reason: 'rotate' })
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
          <DialogDescription>Create badge credentials, claim badges, and control badge access.</DialogDescription>
        </DialogHeader>

        <form className="hosted-badge-form" onSubmit={(event) => {
          event.preventDefault()
          if (label.trim() && !create.isPending) create.mutate()
        }}>
          <label className="field-label" htmlFor="badge-label">New badge label</label>
          <div className="hosted-badge-action">
            <Input
              id="badge-label"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Table badge"
            />
            <Button type="submit" disabled={!label.trim() || create.isPending}>
              {create.isPending ? <LoaderCircle className="spin" /> : <KeyRound />} Create
            </Button>
          </div>
        </form>

        {secret && (
          <div className="hosted-secret" role="status">
            <strong>Save this secret now.</strong>
            <p>
              It appears once. {secret.reason === 'rotate'
                ? 'Use the safe USB installer to reprovision this badge. The old secret expires within 24 hours.'
                : 'Use the safe USB installer to provision this badge.'}
            </p>
            <label className="field-label" htmlFor="hosted-service-url">Hosted service URL</label>
            <Input
              id="hosted-service-url"
              readOnly
              value={secret.serviceUrl}
              onFocus={(event) => event.target.select()}
            />
            <label className="field-label" htmlFor="hosted-badge-id">Badge ID</label>
            <Input
              id="hosted-badge-id"
              readOnly
              value={secret.badgeId}
              onFocus={(event) => event.target.select()}
            />
            <label className="field-label" htmlFor="hosted-badge-secret">Badge secret</label>
            <Input
              id="hosted-badge-secret"
              readOnly
              value={secret.badgeSecret}
              onFocus={(event) => event.target.select()}
            />
            <p>The service stores only a keyed HMAC. It never sends a replacement secret to badge runtime.</p>
            <Button variant="outline" onClick={() => setSecret(null)}>I saved it</Button>
          </div>
        )}

        <form className="hosted-badge-form" onSubmit={(event) => {
          event.preventDefault()
          if (/^\d{6}$/.test(claimCode) && !claim.isPending) claim.mutate()
        }}>
          <label className="field-label" htmlFor="claim-code">Claim code from badge</label>
          <div className="hosted-badge-action">
            <Input
              id="claim-code"
              className="pin-input"
              value={claimCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              onChange={(event) => setClaimCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
            />
            <Button type="submit" disabled={claimCode.length !== 6 || claim.isPending}>
              {claim.isPending ? <LoaderCircle className="spin" /> : <BadgeCheck />} Claim
            </Button>
          </div>
          <p className="hosted-badge-help">Claim codes work once and expire after ten minutes.</p>
        </form>

        <div className="hosted-badge-list">
          <div className="field-label">Registered badges</div>
          {badges.isPending ? <p className="muted-copy">Loading badges…</p> : badges.data?.badges.length
            ? badges.data.badges.map((badge) => (
              <article className="hosted-badge-row" key={badge.id}>
                <div>
                  <RadioTower size={17} />
                  <span>
                    <strong>{badge.label}</strong>
                    <small>{badge.revoked ? 'Revoked' : badge.claimed ? 'Claimed' : 'Waiting for claim'}</small>
                  </span>
                </div>
                {!badge.revoked && (
                  <div>
                    <Button
                      variant="outline"
                      size="icon"
                      title="Rotate secret for USB reprovisioning"
                      aria-label={`Rotate secret for ${badge.label}`}
                      disabled={rotate.isPending || revoke.isPending}
                      onClick={() => rotate.mutate(badge.id)}
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      title="Revoke badge"
                      aria-label={`Revoke ${badge.label}`}
                      disabled={rotate.isPending || revoke.isPending}
                      onClick={() => {
                        if (window.confirm(`Revoke ${badge.label}? The badge will lose access immediately.`)) {
                          revoke.mutate(badge.id)
                        }
                      }}
                    >
                      <ShieldX />
                    </Button>
                  </div>
                )}
              </article>
            ))
            : <p className="muted-copy">No badges are registered.</p>}
        </div>

        {(error || logoutError) && <p className="inline-error" role="alert">{errorMessage(error ?? new Error(logoutError))}</p>}
        <div className="session-settings">
          <div>
            <strong>This administrator session is active.</strong>
            <p>Sign out this browser, or revoke all administrator sessions. The hosted broadcast keeps running.</p>
          </div>
          <Button variant="outline" disabled={loggingOut || revokingAll} onClick={onLogout}>
            {loggingOut ? <LoaderCircle className="spin" /> : <LogOut />} Sign out
          </Button>
          <Button variant="outline" disabled={loggingOut || revokingAll} onClick={onRevokeAll}>
            {revokingAll ? <LoaderCircle className="spin" /> : <LogOut />} Revoke all sessions
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
