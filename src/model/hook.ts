/**
 * `useModel()` — whether the on-device model is on the phone, and the fetch that
 * puts it there.
 *
 * The download is not started automatically. It is 773 MB, which is not something
 * to spend on someone's data plan without being asked, so the screen offers it and
 * this runs it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { describeError, type ErrorDescription } from '../errors'
import { downloadModel, findModel } from './download'

export type ModelStatus = 'checking' | 'missing' | 'downloading' | 'ready' | 'failed'

export interface ModelDownload {
  status: ModelStatus
  /** Bytes on disk so far. */
  received: number
  /** What the whole file weighs, or `null` until something says. */
  total: number | null
  /** Absolute path to the model, set only once all of it is there. */
  path: string | null
  failure: ErrorDescription | null
  /** Begin the download, or begin it again after a failure. */
  start: () => void
}

export function useModel(): ModelDownload {
  const [status, setStatus] = useState<ModelStatus>('checking')
  const [received, setReceived] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [failure, setFailure] = useState<ErrorDescription | null>(null)

  const mounted = useRef(true)
  // Reflects `status` for the guard in start(), which cannot read the state it
  // is about to set without going stale between two taps.
  const running = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const found = findModel()
    if (!mounted.current) {
      return
    }
    setPath(found)
    setStatus(found ? 'ready' : 'missing')
  }, [])

  const start = useCallback(() => {
    if (running.current) {
      return
    }
    running.current = true
    setStatus('downloading')
    setFailure(null)
    setReceived(0)
    setTotal(null)

    downloadModel((bytes, declared) => {
      if (mounted.current) {
        setReceived(bytes)
        setTotal(declared)
      }
    })
      .then((modelPath) => {
        running.current = false
        if (!mounted.current) {
          return
        }
        setPath(modelPath)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        running.current = false
        console.log('[model] download failed:', error)
        if (!mounted.current) {
          return
        }
        setFailure(describeError(error))
        setStatus('failed')
      })
  }, [])

  return { status, received, total, path, failure, start }
}
