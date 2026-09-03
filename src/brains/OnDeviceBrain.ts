import { voiceEngine, type LLMReply } from '../voice/VoiceEngine'
import {
  cancelledError,
  type AgentProfile,
  type Brain,
  type BrainId,
  type BrainReply,
  type ConversationMessage,
} from './types'

/**
 * How much of the transcript a replay resends.
 *
 * Sized by what a 1B model can hold in mind rather than by what fits its context,
 * which is the looser bound. A long background reads to it as the thing to answer:
 * the new message becomes one line among many, and the reply comes back about an
 * older turn or repeats a line of the background word for word. Ten is also what
 * `CloudBrain` sends, so a switch mid-conversation hands the two brains comparable
 * context.
 */
const MAX_REPLAY_MESSAGES = 10

/**
 * The node's canned answer when a prompt cannot fit its context. It reads as an
 * ordinary reply, but the node kept neither the message nor an answer, so the sync
 * counter cannot see the divergence. Matching an SDK string is coupling; the events
 * carry nothing else to key on.
 */
const INPUT_TOO_LONG_REPLY =
  'That message is too long for me to process. Could you send a shorter one?'

/**
 * Drop a transcript label the model wrote instead of just answering. Rare, but a
 * reply starting `Me:` must not be spoken aloud or stored as the assistant's turn,
 * where it would go on to poison every later prompt.
 */
function stripRoleLabel(text: string): string {
  return text.replace(/^\s*(?:Me|You|User|Assistant)\s*:\s*/i, '')
}

/**
 * Whether a reply is verse: several lines, with the first one running into the next
 * rather than ending. A list breaks at sentence ends and prose does not break at
 * all, so this catches what a request to write or entertain produces and nothing
 * else — which is what makes it a usable trigger for a refusal.
 */
function looksLikeVerse(text: string): boolean {
  if (!text.includes('\n')) {
    return false
  }
  const firstLine = text.split('\n')[0].trim()
  if (!firstLine || SENTENCE_END.test(firstLine)) {
    return false
  }
  const flattened = text.replace(/\s*\n+\s*/g, ' ').trim()
  const firstEnd = flattened.search(/[.!?…]/)
  // A sentence carrying on past the end of its line is verse. Text that never ends a
  // sentence at all is a reply cut off mid-list, and its first line is still worth
  // speaking.
  return firstEnd > firstLine.length
}

/**
 * Collapse a reply that arrived as verse or a list to its first line or sentence.
 *
 * The prompt forbids both, but a direct request outranks it at this model size and
 * the speaker reads every line it is given. A reply that obeys the prompt has no
 * line breaks, so nothing legitimate is lost.
 */
function flattenMultilineReply(text: string): string {
  if (!text.includes('\n')) {
    return text
  }
  const firstLine = text.split('\n')[0].trim()
  const flattened = text.replace(/\s*\n+\s*/g, ' ').trim()
  const firstEnd = flattened.search(/[.!?…]/)
  if (firstEnd < 0) {
    return firstLine
  }
  const firstSentence = flattened.slice(0, firstEnd + 1)
  // In verse a sentence runs over several lines, so its first sentence can still be
  // a whole quatrain. A sentence that outgrew its own line is not prose, so keep the
  // line instead.
  return firstSentence.length > firstLine.length + 1 && !firstLine.match(SENTENCE_END)
    ? firstLine
    : firstSentence
}

const forComparison = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')

/**
 * Whether a reply is a refusal, matched against the profile's canonical wording as
 * a prefix so a reply that ran on — "I can only help with travel questions" — is
 * still recognised. Missing one is silent: the wording would go back into the
 * node's context and start the loop this exists to prevent.
 */
function isRefusal(text: string, refusals: readonly string[]): boolean {
  return forComparison(text).startsWith(forComparison(refusals[0])) || isBareRefusal(text, refusals)
}

/**
 * A refusal and nothing else, which is the only kind worth rewording. The model
 * often adds a redirect of its own — "…you'll need a sports website for that" —
 * and that is a better reply than any canned sentence, so it is left to speak for
 * itself. Both kinds are kept out of the replay just the same.
 */
function isBareRefusal(text: string, refusals: readonly string[]): boolean {
  const value = forComparison(text)
  return refusals.some((refusal) => forComparison(refusal) === value)
}

/**
 * Leave a refused exchange out of what the node is replayed.
 *
 * A canned refusal in the node's own context is the likeliest thing for it to write
 * next, and two of them are enough to make it the answer to everything — a question
 * it should have answered included. The transcript on screen keeps them, because
 * the user heard them; the model does not read them back.
 *
 * The request that drew the refusal goes with it. It was off topic anyway, and a
 * question left in the background with no answer under it is the one shape the
 * replay is written to avoid.
 */
function withoutRefusedExchanges(
  history: ConversationMessage[],
  refusals: readonly string[]
): ConversationMessage[] {
  const kept: ConversationMessage[] = []
  for (const message of history) {
    if (message.role === 'assistant' && isRefusal(message.content, refusals)) {
      if (kept[kept.length - 1]?.role === 'user') {
        kept.pop()
      }
      continue
    }
    kept.push(message)
  }
  return kept
}

/** Sentence enders, in the order the model is likely to produce them. */
const SENTENCE_END = /[.!?…]["')\]]?$/

/**
 * Drop a trailing fragment from a reply that was cut off rather than finished —
 * half a sentence read aloud sounds like a fault. A reply with no sentence end at
 * all is kept whole.
 */
function trimToCompleteSentence(text: string): string {
  const trimmed = text.trimEnd()
  if (SENTENCE_END.test(trimmed)) {
    return trimmed
  }
  const lastEnd = Math.max(
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf('!'),
    trimmed.lastIndexOf('?'),
    trimmed.lastIndexOf('…')
  )
  if (lastEnd < 0) {
    return trimmed
  }
  return trimmed.slice(0, lastEnd + 1)
}

/**
 * The `LlamaCpp.LLM` node as a brain.
 *
 * App state owns the transcript, but the node keeps its own rolling context that
 * cannot be read or appended to — only reset. So this tracks how many messages
 * the node has ingested and, when that no longer matches the transcript, resets
 * it and replays the conversation as a single prompt. See the README's
 * "Conversation history" for why it works that way.
 */
export class OnDeviceBrain implements Brain {
  readonly id: BrainId = 'on-device'
  readonly label = 'On-device'
  readonly requiresNetwork = false
  readonly requiresModel = true

  /** How many messages of the app transcript the node has ingested. */
  private syncedMessages = 0

  /** How many refusals have been said, so the next one is worded differently. */
  private refusalsSaid = 0

  private profile: AgentProfile

  // Deliberately does not write the prompt to the engine. The router constructs
  // this at module load, and `App.tsx` applies the profile in an effect, so the
  // node is written once the tree is up rather than as an import side effect.
  constructor(profile: AgentProfile) {
    this.profile = profile
  }

  /**
   * Wear a new profile: new prompt, and the node's context goes with it.
   *
   * Writing `instructions` is the node's only way to accept a prompt and it clears
   * the history as it does, so there is nothing to preserve here even if there
   * were a reason to.
   */
  applyProfile(profile: AgentProfile): void {
    this.profile = profile
    voiceEngine.resetConversation(profile.onDevicePrompt)
    this.syncedMessages = 0
    this.refusalsSaid = 0
  }

  /** Clear the node's conversation, keeping the current profile's prompt. */
  reset(): void {
    voiceEngine.resetConversation()
    this.syncedMessages = 0
  }

  async reply(
    transcript: string,
    history: ConversationMessage[],
    signal?: AbortSignal
  ): Promise<BrainReply> {
    if (signal?.aborted) {
      throw cancelledError()
    }

    const inSync = this.syncedMessages === history.length
    if (!inSync) {
      voiceEngine.resetConversation()
    }

    const prompt = inSync ? transcript : this.renderReplay(history, transcript)
    console.log(`[LLM] ${inSync ? 'incremental' : 'replaying transcript'}:`, prompt)

    const startedAt = Date.now()
    const reply = await this.generate(prompt, history.length, signal)
    const processingTime = Date.now() - startedAt
    console.log(
      `[LLM] reply in ${reply.processingTime}ms (${processingTime}ms round trip):`,
      reply.text
    )

    // Verse is the one thing the model produces that no amount of trimming turns
    // into an answer: a line of it read aloud is worse than saying no. Refusing here
    // rather than in the prompt is what keeps a travel question from drawing the
    // refusal, since the code can see what the model wrote and a rule cannot.
    const cleaned = stripRoleLabel(reply.text)
    // Verse is the one thing the model produces that no amount of trimming turns
    // into an answer, and a line of it read aloud is worse than saying no.
    const answer = looksLikeVerse(cleaned)
      ? null
      : trimToCompleteSentence(flattenMultilineReply(cleaned))
    // A refusal the model wrote as one bare sentence is reworded on the way out, so
    // the traveller never hears the same one twice; one that carried its own
    // redirect is better than anything canned and is spoken as written.
    const text =
      answer === null || isBareRefusal(answer, this.profile.refusals) ? this.nextRefusal() : answer

    // The node holds every message up to and including its reply — unless it dropped
    // the turn as too long, when it holds neither and the next turn rebuilds it.
    // A refusal forces the same rebuild, so the node never reads back the sentence
    // it just wrote. That costs one re-prefill on the turn after a refusal and
    // nothing otherwise.
    const droppedTheTurn = reply.text.trim() === INPUT_TOO_LONG_REPLY
    const refused = isRefusal(text, this.profile.refusals)
    this.syncedMessages = droppedTheTurn || refused ? 0 : history.length + 2

    return { text, brain: this.id, processingTime }
  }

  /** Say the refusal a different way each time it comes up. */
  private nextRefusal(): string {
    const { refusals } = this.profile
    const refusal = refusals[this.refusalsSaid % refusals.length]
    this.refusalsSaid += 1
    return refusal
  }

  /**
   * Await the node's reply, giving up early if `signal` fires.
   *
   * A cancelled turn leaves the node holding the conversation plus the user's
   * message, with no reply — which is exactly what the transcript holds too, since
   * the app records what was said before asking for an answer. So the counter
   * moves on by one and the next turn stays incremental: no reset, no replay.
   */
  private async generate(
    prompt: string,
    historyLength: number,
    signal?: AbortSignal
  ): Promise<LLMReply> {
    const onAbort = () => {
      this.syncedMessages = historyLength + 1
      voiceEngine.cancelGeneration()
    }
    signal?.addEventListener('abort', onAbort)

    try {
      return await voiceEngine.generate(prompt)
    } catch (error) {
      // cancelGeneration() is what rejected it, so report it as a cancellation
      // rather than as a failure of the model.
      throw signal?.aborted ? cancelledError() : error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Catch the node up: the whole conversation, plus this turn, as one prompt.
   *
   * The node takes a single string rather than a list of turns, so the roles have
   * to be spelled out in the text for the model to tell them apart. That makes the
   * prompt look like a transcript, and a small model will happily carry on writing
   * one — answering with `Me: ...` instead of answering at all. So the labels are
   * first-person, the history is fenced off as background, and the last line is an
   * instruction rather than another transcript line for it to continue.
   */
  private renderReplay(history: ConversationMessage[], transcript: string): string {
    const kept = withoutRefusedExchanges(history, this.profile.refusals)
    if (kept.length === 0) {
      return transcript
    }
    const past = kept
      .slice(-MAX_REPLAY_MESSAGES)
      .map((m) => `${m.role === 'user' ? 'Me' : 'You'}: ${m.content}`)
      .join('\n')
    return [
      'Background — what we have said so far:',
      '---',
      past,
      '---',
      `My new message is: ${transcript}`,
      'Reply to my new message in your own words, in one or two short sentences. Do not repeat the background or write "Me:" or "You:".',
    ].join('\n')
  }
}
