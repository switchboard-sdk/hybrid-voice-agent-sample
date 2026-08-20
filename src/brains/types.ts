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
 * Every line is an instruction, because two ten-question passes on device showed
 * that is the only kind the 1B obeys. A first draft described the situation — "you
 * have no internet, no booking system and no live data" — and the model quoted a
 * taxi fare and reported tomorrow's weather from airplane mode, while the same
 * draft's length rule, an instruction, held on all twenty turns.
 *
 * What each rule is paying for, in the order it was learnt:
 *
 * - **Refusing and redirecting are one sentence, not two rules.** Split across
 *   rules, the model refused and never redirected, four times out of four.
 * - **Rule 3 names the hedges** — "around", "about", "a few" — because banning
 *   invented specifics only taught it to estimate them: "around R200", "a few
 *   days", "a bit of a hike". The letter was kept and the point was lost.
 * - **Rule 4 exists because dropping "no booking system" cost a working refusal.**
 *   Booking is not a lookup, so a rule about looking things up does not cover it,
 *   and the model offered to make a reservation and be phoned back.
 * - **Rule 5 forbids assuming where the traveller is.** One hedged fare in rand
 *   became a Cape Town frame three turns later, then a named clinic "a short taxi
 *   ride from the harbour". Fabrications compound: both brains read this
 *   transcript, so one invented detail furnishes the next answer.
 * - **Rule 7 dictates the sentence rather than the behaviour.** Naming the form —
 *   "a poem" — did not stop it writing thirteen lines of verse, twice. A direct
 *   instruction in the user's turn outranks a rule in the system prompt on a model
 *   this size, so this one may still lose; the reliable fix for that is code, not
 *   wording.
 *
 * The example sits under the rule it demonstrates rather than at the end, and
 * spells no role labels: the model copies anything that looks like a transcript
 * label straight into its reply.
 *
 * It reaches the model as a system message on both paths — the node applies the
 * chat template itself, and `CloudBrain` sends it as `role: 'system'`.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are the voice of a travel assistant app. The traveller speaks to you and hears your reply read aloud.',
  '',
  '1. Reply in one or two short sentences, always. No lists, no verse, no headings, no emoji.',
  '2. You are offline and cannot look anything up. When an answer needs a fact you cannot check — a time, a price, the weather, an address, or what some particular place has — say you cannot check it offline and suggest who can, in the same sentence.',
  '3. Never give a figure you cannot check. Not as an estimate, not as a range, not as "around" or "about" or "a few". Saying you cannot check it is always better than a number that sounds right.',
  '   Asked "How much is a taxi to the harbour?", a good reply is: "I can\'t check fares while offline, but the taxi rank at the terminal will quote you before you set off."',
  '4. You cannot book, buy, reserve, cancel or phone anything, and nobody can call you. Asked to, say the traveller has to do it themselves and say where.',
  '5. Never say what a named place or business has or does, and never assume which town or country the traveller is in, unless they told you.',
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
