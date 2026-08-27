import { voiceEngine, type LLMReply } from '../voice/VoiceEngine'
import {
  ON_DEVICE_SYSTEM_PROMPT,
  cancelledError,
  type Brain,
  type BrainId,
  type BrainReply,
  type ConversationMessage,
} from './types'

/** How much of the transcript a replay resends, so it cannot outgrow the context. */
const MAX_REPLAY_MESSAGES = 40

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

  /** Clear the node's conversation and set the system prompt. */
  reset(instructions: string = ON_DEVICE_SYSTEM_PROMPT): void {
    voiceEngine.resetConversation(instructions)
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

    // The node holds every message up to and including its reply — unless it dropped
    // the turn as too long, when it holds neither and the next turn rebuilds it.
    const droppedTheTurn = reply.text.trim() === INPUT_TOO_LONG_REPLY
    this.syncedMessages = droppedTheTurn ? 0 : history.length + 2

    return {
      text: trimToCompleteSentence(flattenMultilineReply(stripRoleLabel(reply.text))),
      brain: this.id,
      processingTime,
    }
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
    if (history.length === 0) {
      return transcript
    }
    const past = history
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
