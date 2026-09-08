import { useState } from 'react'
import { Copy, Link2, LoaderCircle, LogOut, Monitor, Smartphone, Wifi } from 'lucide-react'
import type { StationState } from '../../shared/types'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

interface ConnectDialogProps {
  state: StationState
  open: boolean
  onOpenChange: (open: boolean) => void
  onLogout: () => void
  loggingOut: boolean
  logoutError: string
}

async function copyAddress(address: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(address)
      return
    }
  } catch {
    // Clipboard access can be unavailable on an HTTP local network.
  }
  const input = document.createElement('textarea')
  input.value = address
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  let copied = false
  try { copied = document.execCommand('copy') } finally { input.remove() }
  if (!copied) throw new Error('Copy is unavailable. Select the address below and copy it manually.')
}

export function ConnectDialog({ state, open, onOpenChange, onLogout, loggingOut, logoutError }: ConnectDialogProps) {
  const [notice, setNotice] = useState('')
  const [copyFailed, setCopyFailed] = useState(false)

  async function copy(address: string) {
    try {
      await copyAddress(address)
      setCopyFailed(false)
      setNotice('Station address copied.')
    } catch {
      setCopyFailed(true)
      setNotice('Copy is unavailable. Select an address and copy it manually.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="station-dialog connect-dialog">
        <DialogHeader>
          <span className="eyebrow accent-text"><Link2 size={14} /> Local network only</span>
          <DialogTitle>CONNECT TO THE HIVE.</DialogTitle>
          <DialogDescription>Your Mac runs the station. Your phone steers the signal.</DialogDescription>
        </DialogHeader>
        <div className="connection-route"><Monitor /><span>Mac station</span><i /><Wifi /><i /><Smartphone /><span>Your phone</span></div>
        <ol className="connect-steps">
          <li>Keep your Mac, phone, and badge on the same Wi-Fi.</li>
          <li>Open a station address on your phone.</li>
          <li>Enter the six-digit code printed in the Mac terminal.</li>
        </ol>
        <div className="address-list">
          <span className="field-label">Phone addresses</span>
          {state.server.addresses.length ? state.server.addresses.map((address) => (
            <div className="address-row" key={address}>
              <Input readOnly value={address} aria-label="Station phone address" onFocus={(event) => event.target.select()} />
              <Button variant="outline" size="icon" aria-label={`Copy ${address}`} onClick={() => void copy(address)}><Copy /></Button>
            </div>
          )) : <p className="muted-copy">No network addresses found. Check your Mac’s Wi-Fi connection.</p>}
          {notice && <p className={copyFailed ? 'inline-error' : 'copy-success'} role={copyFailed ? 'alert' : 'status'}>{notice}</p>}
        </div>
        <div className="station-facts">
          <div><span>Station</span><strong>{state.server.name}</strong></div>
          <div><span>Output</span><strong>{state.server.width} × {state.server.height} px</strong></div>
          <div><span>Software</span><strong>v{state.server.version}</strong></div>
        </div>
        <div className="session-settings">
          <div><strong>This controller is paired.</strong><p>Disconnecting signs out this browser. The broadcast keeps running.</p></div>
          <Button variant="outline" disabled={loggingOut} onClick={onLogout}>{loggingOut ? <LoaderCircle className="spin" /> : <LogOut />} Disconnect</Button>
        </div>
        {logoutError && <p className="inline-error" role="alert">{logoutError}</p>}
      </DialogContent>
    </Dialog>
  )
}
