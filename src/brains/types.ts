/**
 * One interface, two brains. A brain takes what the user just said plus the
 * conversation so far and returns a reply; the on-device model and a cloud LLM
 * both sit behind it, so the rest of the app never learns which one answered.
 *
 * App state owns the transcript (see the README's "Conversation history"), so a
 * brain is handed the history rather than keeping its own. Whatever caching an
 * implementation does underneath is its business, not the app's.
 */

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export type BrainId = 'on-device' | 'cloud'

/** A completed turn, whichever brain served it. */
export interface BrainReply {
  text: string
  /** Which brain answered, so a turn can be labelled with it. */
  brain: BrainId
  /**
   * Wall-clock milliseconds the user waited. Measured by the brain itself so
   * the two paths are comparable — the on-device node reports its own,
   * narrower, number, which is logged but not returned.
   */
  processingTime: number
}

export interface Brain {
  readonly id: BrainId
  /** Short label for the UI. */
  readonly label: string

  /**
   * Reply to `transcript`, given the conversation up to but excluding it.
   *
   * Rejects with a `CANCELLED` error if `signal` fires. Cancellation means the
   * reply is abandoned, not necessarily that the work stops: the on-device node
   * has no cancel action, so its generation runs to completion unheard.
   */
  reply(
    transcript: string,
    history: ConversationMessage[],
    signal?: AbortSignal
  ): Promise<BrainReply>

  /** Drop any cached conversation state and set the system prompt. */
  reset(instructions?: string): void
}

/**
 * The persona both brains share, so a turn reads the same whichever one served
 * it. Tuned for the smaller of the two: what the 1B on-device model can follow,
 * a cloud model can follow as well.
 *
 * Deliberately minimal — enough that the answers match the travel framing on
 * screen. Hand-tuning it against the small model is its own step.
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are the voice of a travel assistant app. Help the traveller with destinations, ' +
  'getting around, and what to do when plans change. Answer in one or two short ' +
  'sentences, because your answer is spoken aloud. Never invent flight numbers, ' +
  'schedules or prices.'

/** Build an Error carrying a machine `code`, matching VoiceEngine's convention. */
export function brainError(code: string, message: string): Error {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

/** The rejection both brains use when a turn is abandoned. */
export function cancelledError(): Error {
  return brainError('CANCELLED', 'The reply was cancelled')
}
