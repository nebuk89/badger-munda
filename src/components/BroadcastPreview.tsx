import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Radio, WifiOff } from 'lucide-react'

interface BroadcastPreviewProps {
  enabled: boolean
  title: string
}

export function BroadcastPreview({ enabled, title }: BroadcastPreviewProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const image = imageRef.current
    if (!image || !enabled) return
    let disposed = false
    let loading = false
    let visible = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let requestedAt = 0

    const load = () => {
      if (disposed || loading || document.hidden || !visible) return
      loading = true
      requestedAt = performance.now()
      image.src = `/api/frame.png?tick=${Date.now()}`
    }
    const schedule = (delay: number) => {
      clearTimeout(timer)
      if (!disposed && !document.hidden && visible) timer = setTimeout(load, delay)
    }
    image.onload = () => {
      loading = false
      if (disposed) return
      setStatus('ready')
      schedule(Math.max(0, 250 - (performance.now() - requestedAt)))
    }
    image.onerror = () => {
      loading = false
      if (disposed) return
      setStatus('error')
      schedule(1500)
    }
    const onVisibilityChange = () => {
      clearTimeout(timer)
      if (!document.hidden) load()
    }
    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting
        clearTimeout(timer)
        if (visible) load()
      })
      : null
    observer?.observe(image)
    document.addEventListener('visibilitychange', onVisibilityChange)
    load()
    return () => {
      disposed = true
      clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      image.onload = null
      image.onerror = null
      image.removeAttribute('src')
    }
  }, [enabled])

  return (
    <div className="broadcast-screen">
      <img ref={imageRef} width="160" height="120" alt={`Broadcast preview: ${title}`} />
      {(!enabled || status !== 'ready') && (
        <div className="screen-message" role="status">
          {!enabled ? <WifiOff /> : status === 'error' ? <Radio /> : <LoaderCircle className="spin" />}
          <strong>{!enabled ? 'Preview offline' : status === 'error' ? 'Preview unavailable' : 'Tuning the signal'}</strong>
          <span>{!enabled || status === 'error' ? 'Checking the Mac connection.' : 'Waiting for the first frame.'}</span>
        </div>
      )}
    </div>
  )
}
