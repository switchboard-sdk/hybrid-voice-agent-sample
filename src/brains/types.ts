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
   * Whether answering needs a connection. Declared here rather than inferred from
   * the id, so `route` can withdraw a brain that cannot answer offline and the
   * picker can dim it without naming an implementation.
   */
  readonly requiresNetwork: boolean
  /**
   * Whether answering needs the model's weights on the phone. Declared here for
   * the same reason as `requiresNetwork`: a fresh install that has not fetched
   * them has no on-device brain, and `route` has to withdraw it without naming an
   * implementation.
   */
  readonly requiresModel: boolean

  /**
   * Reply to `transcript`, given the conversation up to but excluding it.
   *
   * Rejects with a `CANCELLED` error if `signal` fires. Both paths stop the work
   * too: the cloud request is aborted, and the on-device node stops within a token
   * and drops the reply it was building.
   */
  reply(
    transcript: string,
    history: ConversationMessage[],
    signal?: AbortSignal
  ): Promise<BrainReply>

  /**
   * Adopt a new agent profile.
   *
   * Nothing is carried over. A profile is a different product rather than a new
   * topic, so the prompt changes and whatever conversation state the
   * implementation held goes with it.
   */
  applyProfile(profile: AgentProfile): void

  /**
   * Drop any cached conversation state, keeping the current profile.
   *
   * Takes no prompt on purpose: the Clear button calls this, and a parameter
   * defaulting to a built-in prompt would quietly undo whatever profile is
   * running.
   */
  reset(): void
}

/**
 * Everything about this app that belongs to one business rather than to the code.
 *
 * White-labelling means writing one of these and nothing else. `src/profiles.ts`
 * holds them, and `EXPO_PUBLIC_AGENT_PROFILE` picks which one a build wears.
 *
 * The refusal wordings travel with the prompts because `OnDeviceBrain` says one
 * in code rather than asking the prompt for it — a sentence written for another
 * domain would contradict the prompt it shipped with.
 */
export interface AgentProfile {
  /** Also the React key that discards the screen's state when the profile changes. */
  readonly id: string
  /** The conversation screen's heading. */
  readonly title: string
  /**
   * What the agent is, in a sentence or two — the line both prompts open with.
   *
   * This is the part a user types. Both prompts below are built from it, so it is
   * kept as its own field rather than only in the assembled text: the editor
   * pre-fills from here, and re-parsing a finished prompt to find it would be
   * guesswork.
   */
  readonly brief: string
  readonly onDevicePrompt: string
  readonly cloudPrompt: string
  /**
   * What a refusal may sound like, said in order so the same one is never heard
   * twice. The first is canonical: it is the wording a reply is matched against,
   * so it has to be the plainest statement of the boundary.
   */
  readonly refusals: readonly string[]
  /** Offered before the first turn, as examples of what to ask. */
  readonly examplePrompts: readonly string[]
}

/**
 * The one rule no profile needs to reword: what a spoken reply looks like. Every
 * other rule names the domain, so it belongs to a profile rather than here.
 */
export const SPOKEN_BREVITY =
  'Reply in one or two short sentences, always. No lists, no verse, no headings, no emoji.'

/**
 * A persona line, then the rules numbered from 1.
 *
 * A worked example belongs to the rule above it, so it travels in the same entry
 * and keeps its indent rather than taking a number of its own. Numbering from 1
 * per set is what lets a rule sit wherever it reads best in either prompt without
 * either having to count.
 */
export function systemPrompt(persona: string, rules: readonly string[]): string {
  return [persona, '', ...rules.map((rule, index) => `${index + 1}. ${rule}`)].join('\n')
}

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
