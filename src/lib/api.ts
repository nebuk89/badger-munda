import type { Clip, Command, StationState } from '../../shared/types'

export interface Setup {
  paired: boolean
  name: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function responseError(value: unknown, fallback: string) {
  if (typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string') {
    return value.error
  }
  return fallback
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = window.setTimeout(abort, 10_000)

  try {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })
    const text = await response.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      throw new ApiError('Unexpected server response. Check that the Mac station is running.', response.status)
    }
    if (!response.ok) {
      throw new ApiError(responseError(data, `The station could not complete this request (${response.status}).`), response.status)
    }
    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (controller.signal.aborted) throw new ApiError('The station did not respond in time. Check the Mac and your Wi-Fi.')
    throw new ApiError('Cannot reach the Mac station. Keep both devices on the same Wi-Fi.')
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function command(command: Command) {
  return api<StationState>('/api/command', {
    method: 'POST',
    body: JSON.stringify({ ...command, requestId: requestId() }),
  })
}

export function uploadClip(
  file: File,
  title: string,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<{ clip: Clip }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    const cleanup = () => signal.removeEventListener('abort', abort)
    request.open('POST', '/api/library')
    request.timeout = 180_000
    request.upload.onprogress = (event) => onProgress(event.loaded)
    request.upload.onload = () => onProgress(file.size)
    request.onerror = () => {
      cleanup()
      reject(new ApiError('Upload failed. Check your connection to the Mac and try again.'))
    }
    request.ontimeout = () => {
      cleanup()
      reject(new ApiError('The import timed out. Check the library before uploading again.'))
    }
    request.onabort = () => {
      cleanup()
      reject(new ApiError('The upload was cancelled.'))
    }
    request.onload = () => {
      cleanup()
      let value: unknown
      try {
        value = JSON.parse(request.responseText)
      } catch {
        reject(new ApiError('The station returned an unreadable import result.', request.status))
        return
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError(responseError(value, 'The clip could not be imported.'), request.status))
        return
      }
      if (typeof value !== 'object' || value === null || !('clip' in value)) {
        reject(new ApiError('The station did not confirm the imported clip.'))
        return
      }
      resolve(value as { clip: Clip })
    }
    if (signal.aborted) {
      reject(new ApiError('The upload was cancelled.'))
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    const form = new FormData()
    form.append('file', file)
    if (title.trim()) form.append('title', title.trim())
    request.send(form)
  })
}
