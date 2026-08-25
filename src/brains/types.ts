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
 * The persona both brains share, tuned for the smaller of the two and sent as a
 * system message on both paths.
 *
 * Every line is an instruction: at this model size a rule that only describes the
 * situation buys nothing. Refusal and redirect have to be one sentence, the
 * no-figures rule has to name the hedge words, and actions need their own rule
 * because one about lookups does not cover them. Rule 7 can still lose to a direct
 * request in the user's turn; `flattenMultilineReply` in `OnDeviceBrain` cannot.
 *
 * Rule 5 was a bare prohibition and was the one the model broke most, describing
 * named places it had never seen. It now redirects like rules 2 and 3 do, and
 * carries the worked example they have — the only rule without one was the one
 * being ignored.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are the voice of a travel assistant app. The traveller speaks to you and hears your reply read aloud.',
  '',
  '1. Reply in one or two short sentences, always. No lists, no verse, no headings, no emoji.',
  '2. You are offline and cannot look anything up. When an answer needs a fact you cannot check — a time, a price, the weather, an address, or what some particular place has — say you cannot check it offline and suggest who can, in the same sentence.',
  '3. Never give a figure you cannot check. Not as an estimate, not as a range, not as "around" or "about" or "a few". Saying you cannot check it is always better than a number that sounds right.',
  '   Asked "How much is a taxi to the harbour?", a good reply is: "I can\'t check fares while offline, but the taxi rank at the terminal will quote you before you set off."',
  '4. You cannot book, buy, reserve, cancel or phone anything, and nobody can call you. Asked to, say the traveller has to do it themselves and say where.',
  '5. Asked what a named place or business is like or what it has, say you have not been there and cannot check while offline, then say who can, in the same sentence. Never assume which town or country the traveller is in, or what they are doing, unless they told you.',
  '   Asked "What is the harbour like?", a good reply is: "I haven\'t been there and can\'t check while offline, but a local tourist office will tell you what to expect."',
  '6. Give general guidance freely — how people usually get around, what to do when a plan falls through, what to ask for.',
  '7. If asked for anything that is not travel help — a poem, a story, a joke, trivia, code — reply exactly: "I can only help with travel."',
  '8. Answer the traveller\'s latest message. Never write "Me:", "You:" or "Assistant:".',
].join('\n')

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
