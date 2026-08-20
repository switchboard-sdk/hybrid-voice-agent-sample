import React, { createContext, useContext, useEffect, type ReactNode } from 'react'
import { voiceEngine } from './VoiceEngine'

export interface EdgeSpeechContextValue {
  addListener: typeof voiceEngine.addListener
  listen: () => Promise<void>
  stopListening: () => Promise<void>
  speak: (text: string) => Promise<void>
  stopSpeaking: () => Promise<void>
  requestMicrophonePermission: () => Promise<boolean>
}

const EdgeSpeechContext = createContext<EdgeSpeechContextValue | null>(null)

export interface EdgeSpeechProviderProps {
  appId: string
  appSecret: string
  sttModel?: string
  ttsVoice?: string
  vadSensitivity?: number
  sampleRate?: number
  bufferSize?: number
  llmModelPath?: string
  llmContextSize?: number
  llmTemperature?: number
  llmMaxTokens?: number
  llmSeed?: number
  llmInstructions?: string
  children?: ReactNode
}

const defaultConfig = {
  sttModel: 'whisper-base-en',
  ttsVoice: 'en_GB',
  vadSensitivity: 0.5,
}

export function EdgeSpeechProvider({
  appId,
  appSecret,
  sttModel,
  ttsVoice,
  vadSensitivity,
  sampleRate,
  bufferSize,
  llmModelPath,
  llmContextSize,
  llmTemperature,
  llmMaxTokens,
  llmSeed,
  llmInstructions,
  children,
}: EdgeSpeechProviderProps) {
  if (!appId || appId.trim() === '') {
    throw new Error('EdgeSpeechProvider: appId is required')
  }
  if (!appSecret || appSecret.trim() === '') {
    throw new Error('EdgeSpeechProvider: appSecret is required')
  }
  if (vadSensitivity !== undefined && (vadSensitivity < 0.0 || vadSensitivity > 1.0)) {
    throw new Error('EdgeSpeechProvider: vadSensitivity must be between 0.0 and 1.0')
  }
  if (sttModel !== undefined && sttModel.trim() === '') {
    throw new Error('EdgeSpeechProvider: sttModel cannot be an empty string')
  }
  if (ttsVoice !== undefined && ttsVoice.trim() === '') {
    throw new Error('EdgeSpeechProvider: ttsVoice cannot be an empty string')
  }

  useEffect(() => {
    voiceEngine.initialize(appId, appSecret)

    return () => {
      voiceEngine.stopListening().catch(() => {})
    }
  }, [appId, appSecret])

  useEffect(() => {
    voiceEngine.configure({
      sttModel: sttModel ?? defaultConfig.sttModel,
      ttsVoice: ttsVoice ?? defaultConfig.ttsVoice,
      vadSensitivity: vadSensitivity ?? defaultConfig.vadSensitivity,
      ...(sampleRate !== undefined && { sampleRate }),
      ...(bufferSize !== undefined && { bufferSize }),
      ...(llmModelPath !== undefined && { llmModelPath }),
      ...(llmContextSize !== undefined && { llmContextSize }),
      ...(llmTemperature !== undefined && { llmTemperature }),
      ...(llmMaxTokens !== undefined && { llmMaxTokens }),
      ...(llmSeed !== undefined && { llmSeed }),
      ...(llmInstructions !== undefined && { llmInstructions }),
    })
  }, [
    sttModel,
    ttsVoice,
    vadSensitivity,
    sampleRate,
    bufferSize,
    llmModelPath,
    llmContextSize,
    llmTemperature,
    llmMaxTokens,
    llmSeed,
    llmInstructions,
  ])

  const value: EdgeSpeechContextValue = {
    // Keep the method bound so it does not lose its `this`.
    addListener: voiceEngine.addListener.bind(voiceEngine),
    listen: () => voiceEngine.listen(),
    stopListening: () => voiceEngine.stopListening(),
    speak: (text) => voiceEngine.speak(text),
    stopSpeaking: () => voiceEngine.stopSpeaking(),
    requestMicrophonePermission: () => voiceEngine.requestMicrophonePermission(),
  }

  return <EdgeSpeechContext.Provider value={value}>{children}</EdgeSpeechContext.Provider>
}

export function useEdgeSpeechContext(): EdgeSpeechContextValue {
  const ctx = useContext(EdgeSpeechContext)
  if (!ctx) {
    throw new Error('useEdgeSpeech must be used within an <EdgeSpeechProvider>')
  }
  return ctx
}
