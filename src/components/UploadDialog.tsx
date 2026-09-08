import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, FileVideo, LoaderCircle, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { errorMessage, uploadClip } from '../lib/api'

const MAX_BYTES = 40 * 1024 * 1024
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function UploadDialog({ onFailure }: { onFailure: (error: unknown) => void }) {
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [loaded, setLoaded] = useState(0)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a video first.')
      controller.current = new AbortController()
      return uploadClip(file, title, setLoaded, controller.current.signal)
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['station'] })
      toast.success('Clip imported. Ready in your library.')
      setFile(null)
      setTitle('')
      setLoaded(0)
      setOpen(false)
      if (fileInput.current) fileInput.current.value = ''
    },
    onError: (error) => {
      setError(errorMessage(error))
      onFailure(error)
    },
  })

  function selectFile(selected?: File) {
    setError('')
    setLoaded(0)
    if (!selected) { setFile(null); return }
    if (selected.size > MAX_BYTES || selected.size === 0) {
      setError(selected.size === 0 ? 'This file is empty. Choose another video.' : 'This video exceeds 40 MB. Choose a smaller file.')
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      return
    }
    if (!/\.(mp4|mov|webm|mkv)$/i.test(selected.name)) {
      setError('Choose an MP4, MOV, WebM, or MKV video.')
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      return
    }
    setFile(selected)
  }

  const processing = Boolean(file && loaded >= file.size)

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className="upload-button">
        {upload.isPending ? <LoaderCircle className="spin" /> : <Upload />} {upload.isPending ? 'Importing…' : 'Upload clip'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="station-dialog upload-dialog">
          <DialogHeader>
            <span className="eyebrow accent-text">Add your own signal</span>
            <DialogTitle>SMUGGLE IN A CLIP.</DialogTitle>
            <DialogDescription>Import a video from your device. Nothing goes on air until you press “Play on badge”.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => {
            event.preventDefault()
            if (!file || upload.isPending) return
            setError('')
            setLoaded(0)
            upload.mutate()
          }}>
            <label className={`upload-dropzone ${file ? 'has-file' : ''}`}>
              {file ? <FileVideo size={36} /> : <Upload size={32} />}
              <strong>{file ? file.name : 'Choose a video'}</strong>
              <span>{file ? megabytes(file.size) : 'MP4, MOV, WebM, or MKV'}</span>
              <input
                ref={fileInput}
                type="file"
                accept=".mp4,.mov,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska"
                disabled={upload.isPending}
                onChange={(event) => selectFile(event.target.files?.[0])}
                aria-label="Choose a video to upload"
              />
              <span className="file-picker-label">{file ? <Check size={14} /> : null}{file ? 'Change file' : 'Browse files'}</span>
            </label>
            {file && !upload.isPending && <Button className="remove-file" variant="ghost" onClick={() => {
              setFile(null)
              if (fileInput.current) fileInput.current.value = ''
            }}><X /> Remove selection</Button>}
            <label className="field-label" htmlFor="upload-title">Clip title <span>Optional</span></label>
            <Input id="upload-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} placeholder="Give your signal a name" disabled={upload.isPending} />
            <div className="upload-limits"><span>40 MB maximum</span><span>First 30 seconds used</span><span>Converted on your Mac</span></div>
            {upload.isPending && (
              <div className="import-progress" role="status">
                <div><LoaderCircle className="spin" size={17} /><strong>{processing ? 'Processing your clip…' : 'Sending to the Mac…'}</strong></div>
                <progress max={file?.size || 1} value={Math.min(loaded, file?.size || 1)} aria-label="Upload progress" />
                <p>{processing ? 'Conversion can take 30 seconds. You can close this panel while you wait.' : `${megabytes(Math.min(loaded, file?.size || 0))} of ${megabytes(file?.size || 0)} uploaded`}</p>
              </div>
            )}
            {error && <p className="inline-error" role="alert">{error}</p>}
            <Button type="submit" className="full-width" disabled={!file || upload.isPending}>
              {upload.isPending ? <LoaderCircle className="spin" /> : <Upload />}
              {upload.isPending ? 'Import in progress' : 'Import clip'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
