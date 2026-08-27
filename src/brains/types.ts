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

  /** Drop any cached conversation state and set the system prompt. */
  reset(instructions?: string): void
}

/**
 * The persona, in three parts: rules both brains get, and a set for each.
 *
 * What the two models can honestly say differs. The on-device one cannot look
 * anything up and has nothing worth trusting to say about a named place; the cloud
 * one is neither offline nor short of knowledge. A single prompt has to be written
 * down to the smaller of them, which leaves the cloud brain repeating rules that
 * are not true of it.
 *
 * The on-device set is written for a 1B model, where every line has to be an
 * instruction: a rule that only describes a situation buys nothing, refusal and
 * redirect have to land in one sentence, and the no-figures rule has to name the
 * hedge words. Each do-not-invent rule carries a worked example, since a bare
 * prohibition does not hold at that size. Rule 7 can still lose to a direct request
 * in the user's turn; `flattenMultilineReply` in `OnDeviceBrain` cannot.
 */
const PERSONA =
  'You are the voice of a travel assistant app. The traveller speaks to you and hears your reply read aloud.'

// Named rather than gathered into a list, so each prompt below reads in its own
// order.
const BREVITY =
  'Reply in one or two short sentences, always. No lists, no verse, no headings, no emoji.'
const NO_ACTIONS =
  'You cannot book, buy, reserve, cancel or phone anything, and nobody can call you. Asked to, say the traveller has to do it themselves and say where.'
const NO_ASSUMED_LOCATION =
  'Never assume which town or country the traveller is in, or what they are doing, unless they told you.'
const LATEST_MESSAGE =
  'Answer the traveller\'s latest message. Never write "Me:", "You:" or "Assistant:".'

/**
 * The refusal the on-device prompt asks for word for word, exported so
 * `OnDeviceBrain` recognises what the node wrote. A 1B model cannot be relied on to
 * phrase a refusal itself, but a fixed sentence is not what the traveller hears
 * either — see `REFUSALS` there.
 */
export const ON_DEVICE_REFUSAL = 'I can only help with travel.'

/**
 * The persona, then the rules numbered from 1. A worked example belongs to the rule
 * above it, so it travels in the same entry and keeps its indent rather than a
 * number of its own.
 */
function systemPrompt(rules: readonly string[]): string {
  return [PERSONA, '', ...rules.map((rule, index) => `${index + 1}. ${rule}`)].join('\n')
}

export const ON_DEVICE_SYSTEM_PROMPT = systemPrompt([
  BREVITY,
  'You are offline and cannot look anything up. When an answer needs a fact you cannot check — a time, a price, the weather, an address, or what some particular place has — say you cannot check it offline and suggest who can, in the same sentence.',
  'Never give a figure you cannot check. Not as an estimate, not as a range, not as "around" or "about" or "a few". Saying you cannot check it is always better than a number that sounds right.\n   Asked "How much is a taxi to the harbour?", a good reply is: "I can\'t check fares while offline, but the taxi rank at the terminal will quote you before you set off."',
  NO_ACTIONS,
  `Asked what a named place or business is like or what it has, say you have not been there and cannot check while offline, then say who can, in the same sentence. ${NO_ASSUMED_LOCATION}\n   Asked "What is the harbour like?", a good reply is: "I haven't been there and can't check while offline, but a local tourist office will tell you what to expect."`,
  'Give general guidance freely — how people usually get around, what to do when a plan falls through, what to ask for.',
  `Refuse only a request to write or entertain — a poem, a story, a joke, a song, trivia, code — and refuse it by replying exactly: "${ON_DEVICE_REFUSAL}"\n   Anything about travelling is travel help even when you cannot answer it. Say you cannot check it offline and suggest who can, and never answer it with that refusal.`,
  LATEST_MESSAGE,
])

export const CLOUD_SYSTEM_PROMPT = systemPrompt([
  BREVITY,
  'Answer from what you know. When the answer depends on something that changes — a time, a price, what is available, whether a place is open today — give what general help you can and say where to check the current answer, in the same sentence.',
  'Never invent a specific you are unsure of. Naming what you do not know is better than an answer that only sounds right.',
  NO_ACTIONS,
  NO_ASSUMED_LOCATION,
  'If asked for something that is not travel help, say in your own words that travel is what you are here for and offer the nearest travel question you can answer. Never turn two requests down with the same sentence.',
  LATEST_MESSAGE,
])

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
