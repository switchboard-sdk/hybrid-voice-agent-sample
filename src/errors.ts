/**
 * The one place that turns an error `code` into a sentence for the user. Every
 * layer tags its errors — `makeError` in `VoiceEngine`, `brainError` in
 * `src/brains/types.ts`, `modelError` in `src/model/download.ts`.
 *
 * An unknown code keeps its own message rather than becoming a generic apology.
 * An action only appears where one exists: Settings for a denied microphone, the
 * other brain for a failing one.
 */
/** What the banner can offer to do about a failure. */
export type ErrorAction = 'open-settings' | 'switch-brain'

export interface ErrorDescription {
  /** One sentence, aimed at whoever is holding the phone. */
  message: string
  action?: ErrorAction
}

/** The `code` a layer tagged its error with, if it tagged one at all. */
export function codeOf(error: unknown): string | undefined {
  return (error as { code?: string })?.code
}

/** A turn that was abandoned rather than failing — never shown to anyone. */
export function isCancelled(error: unknown): boolean {
  const code = codeOf(error)
  return code === 'CANCELLED' || code === 'GENERATION_CANCELLED'
}

const MESSAGES: Record<string, ErrorDescription> = {
  // MARK: - The device and the pipeline

  PERMISSION_DENIED: {
    message: 'The agent cannot hear you without microphone access.',
    action: 'open-settings',
  },
  INIT_FAILED: {
    message: 'The Switchboard SDK could not start. Check the app ID and secret in .env.',
  },
  ENGINE_CREATION_FAILED: {
    message: 'The audio engine could not be created, so the agent cannot listen or speak.',
  },
  LISTEN_FAILED: {
    message: 'The microphone could not be started.',
  },
  STOP_LISTENING_FAILED: {
    message: 'The microphone could not be stopped.',
  },
  SPEAK_FAILED: {
    message: 'That reply could not be spoken aloud. It is still in the transcript.',
  },
  TTS_TIMEOUT: {
    message: 'The agent stopped speaking unexpectedly. You can carry on talking.',
  },
  ENGINE_STOPPED: {
    message: 'The audio engine was torn down while the agent was thinking.',
  },

  // MARK: - The on-device model
  //
  // An abandoned turn and a slow one look the same over the wire, and the cloud
  // brain is the way out of both.

  GENERATE_TIMEOUT: {
    message: 'The on-device model is not responding. The cloud brain still works.',
    action: 'switch-brain',
  },
  MODEL_NOT_RESPONDING: {
    message: 'The on-device model is not responding. The cloud brain still works.',
    action: 'switch-brain',
  },
  GENERATE_FAILED: {
    message: 'The on-device model could not answer that turn.',
    action: 'switch-brain',
  },
  GENERATION_IN_PROGRESS: {
    message: 'The on-device model is still finishing the previous reply.',
  },
  EMPTY_PROMPT: {
    message: 'There was nothing to send to the model.',
  },
  NOT_INITIALIZED: {
    message: 'The Switchboard SDK has not started yet.',
  },

  // MARK: - The model's weights
  //
  // Fetched on first launch rather than shipped in the app, so a fresh install
  // has a failure the second one cannot have. Each of these keeps its own
  // sentence rather than the underlying NSURLSession text, which is not written
  // for whoever is holding the phone.

  MODEL_DOWNLOAD_FAILED: {
    message: 'The model could not be downloaded. Check the connection and try again.',
  },
  MODEL_INCOMPLETE: {
    message: 'Only part of the model arrived. Try the download again.',
  },
  MODEL_NO_SPACE: {
    message: 'There is not enough free space on this phone for the model.',
  },
  // The cloud is the way out, offered as an action — but not claimed in the
  // sentence, since a phone with no model and no connection has neither brain.
  MODEL_NOT_AVAILABLE: {
    message: 'The on-device model is not on this phone.',
    action: 'switch-brain',
  },

  // MARK: - The cloud model

  CLOUD_NO_API_KEY: {
    message:
      'No cloud API key. Set EXPO_PUBLIC_CLOUD_LLM_API_KEY in .env, or use the on-device brain.',
    action: 'switch-brain',
  },
  CLOUD_UNREACHABLE: {
    message: 'The cloud model cannot be reached. The on-device brain works with no connection.',
    action: 'switch-brain',
  },
  CLOUD_TIMEOUT: {
    message: 'The cloud model did not reply in time. The on-device brain works with no connection.',
    action: 'switch-brain',
  },
  CLOUD_EMPTY_REPLY: {
    message: 'The cloud model returned an empty reply.',
  },
}

/** Cloud HTTP failures, keyed by what the caller can do about them. */
function describeHttpStatus(status: number): ErrorDescription {
  if (status === 401 || status === 403) {
    return {
      message: 'The cloud model rejected the API key.',
      action: 'switch-brain',
    }
  }
  if (status === 429) {
    return {
      message: 'The cloud model is rate limited. Wait a moment, or use the on-device brain.',
      action: 'switch-brain',
    }
  }
  if (status >= 500) {
    return {
      message: 'The cloud model is having trouble. The on-device brain works meanwhile.',
      action: 'switch-brain',
    }
  }
  return { message: `The cloud model refused the request (HTTP ${status}).` }
}

/** A sentence for the user, and optionally something to offer them. */
export function describeError(error: unknown): ErrorDescription {
  const code = codeOf(error)

  if (code?.startsWith('CLOUD_HTTP_')) {
    const status = Number(code.slice('CLOUD_HTTP_'.length))
    if (Number.isFinite(status)) {
      return describeHttpStatus(status)
    }
  }

  if (code && MESSAGES[code]) {
    return MESSAGES[code]
  }

  // Also accepts a bare { code, message } pair, the shape the voice hook records.
  const raw =
    error instanceof Error
      ? error.message
      : ((error as { message?: string })?.message ?? String(error ?? ''))
  return { message: raw.trim() || 'Something went wrong.' }
}
