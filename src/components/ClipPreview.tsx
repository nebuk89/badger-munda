import { useRef, useState } from 'react'
import { Expand, Smartphone } from 'lucide-react'
import type { Clip } from '../../shared/types'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { errorMessage } from '../lib/api'

interface ClipPreviewProps {
  clip: Clip | null
  onClose: () => void
}

export function ClipPreview({ clip, onClose }: ClipPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')

  async function fullscreen() {
    const video = videoRef.current
    if (!video) return
    try {
      if (video.requestFullscreen) await video.requestFullscreen()
      else if ('webkitEnterFullscreen' in video && typeof video.webkitEnterFullscreen === 'function') {
        video.webkitEnterFullscreen()
      } else {
        throw new Error('Fullscreen is unavailable here. Use the video controls or rotate your phone.')
      }
      setError('')
    } catch (error) {
      setError(errorMessage(error))
    }
  }

  return (
    <Dialog open={clip !== null} onOpenChange={(open) => { if (!open) { onClose(); setError('') } }}>
      <DialogContent className="station-dialog preview-dialog">
        <DialogHeader>
          <span className="eyebrow accent-text"><Smartphone size={14} /> Phone preview only</span>
          <DialogTitle>{clip?.title}</DialogTitle>
          <DialogDescription>This plays on your phone. Your broadcast stays unchanged.</DialogDescription>
        </DialogHeader>
        {clip && (
          <video
            key={clip.id}
            ref={videoRef}
            className="phone-video"
            src={clip.videoUrl}
            poster={clip.posterUrl}
            controls
            playsInline
            preload="metadata"
            onError={() => setError('This video could not load. Check the Mac connection and try again.')}
          />
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="preview-footer">
          <span><Smartphone size={15} /> Not sent to your badge</span>
          <Button variant="outline" onClick={() => void fullscreen()}><Expand /> Fullscreen</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
