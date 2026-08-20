import { voiceEngine, type LLMReply } from '../voice/VoiceEngine'
import {
  DEFAULT_SYSTEM_PROMPT,
  cancelledError,
  type Brain,
  type BrainId,
  type BrainReply,
  type ConversationMessage,
} from './types'

/**
 * Drop a transcript label the model wrote instead of just answering. Rare, but a
 * reply starting `Me:` must not be spoken aloud or stored as the assistant's turn,
 * where it would go on to poison every later prompt.
 */
function stripRoleLabel(text: string): string {
  return text.replace(/^\s*(?:Me|You|User|Assistant)\s*:\s*/i, '')
}

/**
 * Collapse a reply that arrived as verse or a list to its first sentence, read as
 * prose.
 *
 * Rule 1 of the prompt forbids both and rule 7 tells the model to decline the
 * requests that provoke them, but a direct "write me a poem" outranks the system
 * prompt on a model this size: in testing it answered with thirteen lines of verse,
 * twice, and the speaker read every one. Nothing legitimate is lost — a reply that
 * obeys the prompt is one or two sentences with no line breaks in it.
 *
 * A multi-line reply with no sentence end anywhere keeps its first line, which is
 * the shortest honest thing to say.
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
  // In verse a sentence runs over several lines, so the first one can still be a
  // whole quatrain — which is what shipped the first time this guard ran on device.
  // A sentence that outgrew its own line is not prose, so keep the line instead.
  return firstSentence.length > firstLine.length + 1 && !firstLine.match(SENTENCE_END)
    ? firstLine
    : firstSentence
}

/** Sentence enders, in the order the model is likely to produce them. */
const SENTENCE_END = /[.!?…]["')\]]?$/

/**
 * Drop a trailing fragment from a reply that was cut off rather than finished.
 *
 * The node's `maxTokens` ceiling stops wherever the count runs out, which is
 * usually mid-sentence — and half a sentence read aloud sounds like a fault
 * rather than a short answer. A reply with no sentence end at all is kept whole:
 * a fragment still beats saying nothing.
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

  /** How many messages of the app transcript the node has ingested. */
  private syncedMessages = 0

  /** Clear the node's conversation and set the system prompt. */
  reset(instructions: string = DEFAULT_SYSTEM_PROMPT): void {
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

    // The node now holds every message up to and including the reply it made.
    this.syncedMessages = history.length + 2

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
    const past = history.map((m) => `${m.role === 'user' ? 'Me' : 'You'}: ${m.content}`).join('\n')
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
