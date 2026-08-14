/**
 * The on-device voice pipeline: VAD → STT and TTS, authored in TypeScript over
 * the Switchboard SDK's JSON-RPC channel.
 *
 * Absorbed from EdgeSpeech (https://github.com/switchboard-sdk/EdgeSpeech, MIT).
 * It lives here as app source rather than as a dependency, so the routing work
 * can reach into the pipeline directly.
 */

export { EdgeSpeechProvider, useEdgeSpeechContext } from './EdgeSpeechProvider'
export type { EdgeSpeechProviderProps, EdgeSpeechContextValue } from './EdgeSpeechProvider'
export { useEdgeSpeech } from './hook'
export { voiceEngine } from './VoiceEngine'
export type { EdgeSpeechEventMap, EdgeSpeechEventName } from './VoiceEngine'
export type {
  VoiceConfig,
  VoiceState,
  VoiceError,
  ErrorEvent,
  TranscriptEvent,
  StateChangeEvent,
  TranscriptCallback,
  StateChangeCallback,
  InterruptedCallback,
  ErrorCallback,
} from './types'
