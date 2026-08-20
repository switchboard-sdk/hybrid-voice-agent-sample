import { useCallback, useEffect, useRef, useState } from 'react'
import { type VoiceState } from './types'
import { useEdgeSpeechContext } from './EdgeSpeechProvider'

export function useEdgeSpeech() {
  const { addListener, listen, stopListening, speak, stopSpeaking, requestMicrophonePermission } =
    useEdgeSpeechContext()

  const [transcript, setTranscript] = useState('')
  const transcriptCompleteCallback = useRef<((text: string) => void) | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  // Kept beside the message because that is what decides the wording and whether
  // anything can be offered about it — see `describeError` in src/errors.ts.
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [hasMicrophonePermission, setHasMicrophonePermission] = useState<boolean | null>(null)
  const interruptedCallback = useRef<(() => void) | null>(null)

  useEffect(() => {
    const transcriptSub = addListener('onTranscript', ({ text, isFinal }) => {
      setTranscript(text)

      if (isFinal) {
        transcriptCompleteCallback.current?.(text)
        setTranscript('')
      }
    })

    const stateSub = addListener('onStateChange', ({ state }) => {
      setVoiceState(state)
    })

    const interruptedSub = addListener('onInterrupted', () => {
      interruptedCallback.current?.()
    })

    const errorSub = addListener('onError', ({ code, message }) => {
      setError(message)
      setErrorCode(code)
    })

    return () => {
      transcriptSub.remove()
      stateSub.remove()
      interruptedSub.remove()
      errorSub.remove()
    }
  }, [addListener])

  const onTranscriptComplete = useCallback((cb: (text: string) => void) => {
    transcriptCompleteCallback.current = cb
  }, [])

  const onInterrupted = useCallback((cb: () => void) => {
    interruptedCallback.current = cb
  }, [])

  /** Drop the last error, so a dismissed banner stays dismissed. */
  const clearError = useCallback(() => {
    setError(null)
    setErrorCode(null)
  }, [])

  /** Record a rejection from one of the calls below, keeping its code. */
  const recordError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e))
    setErrorCode((e as { code?: string })?.code ?? null)
  }, [])

  // Each of these reports whether the call worked, as well as recording the reason,
  // so a caller can tell a failure apart from a success.
  const wrappedListen = useCallback(async (): Promise<boolean> => {
    try {
      await listen()
      return true
    } catch (e) {
      recordError(e)
      return false
    }
  }, [listen, recordError])

  const wrappedStopListening = useCallback(async (): Promise<boolean> => {
    try {
      await stopListening()
      return true
    } catch (e) {
      recordError(e)
      return false
    }
  }, [stopListening, recordError])

  const wrappedSpeak = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await speak(text)
        return true
      } catch (e) {
        recordError(e)
        return false
      }
    },
    [speak, recordError]
  )

  const wrappedStopSpeaking = useCallback(async (): Promise<boolean> => {
    try {
      await stopSpeaking()
      return true
    } catch (e) {
      recordError(e)
      return false
    }
  }, [stopSpeaking, recordError])

  const wrappedRequestMicrophonePermission = useCallback(async () => {
    try {
      const granted = await requestMicrophonePermission()
      setHasMicrophonePermission(granted)
      return granted
    } catch (e) {
      recordError(e)
      setHasMicrophonePermission(false)
      return false
    }
  }, [requestMicrophonePermission, recordError])

  return {
    transcript,
    onTranscriptComplete,
    onInterrupted,
    voiceState,
    error,
    errorCode,
    clearError,
    hasMicrophonePermission,
    listen: wrappedListen,
    stopListening: wrappedStopListening,
    speak: wrappedSpeak,
    stopSpeaking: wrappedStopSpeaking,
    requestMicrophonePermission: wrappedRequestMicrophonePermission,
  }
}
