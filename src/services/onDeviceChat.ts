import { voiceEngine } from '../voice'
import type { ConversationMessage } from './chatService'

export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful, friendly voice assistant. Keep responses concise (1-2 sentences) since they will be spoken aloud.'

// Messages of the app transcript the node has ingested. App state owns the
// transcript; the node's context is opaque, so this decides incremental vs replay.
let syncedMessages = 0

/** Clear the node's conversation and set the system prompt. */
export function resetOnDeviceConversation(instructions: string = DEFAULT_SYSTEM_PROMPT): void {
  voiceEngine.resetConversation(instructions)
  syncedMessages = 0
}

/** Render past turns into one prompt, for when the node has to be caught up. */
function renderTranscript(history: ConversationMessage[], next: ConversationMessage): string {
  if (history.length === 0) {
    return next.content
  }
  const past = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
  return `Here is our conversation so far:\n${past}\n\nUser: ${next.content}`
}

/**
 * Generate a reply on the device.
 *
 * `history` is the transcript up to but excluding `userMessage`.
 */
export async function replyOnDevice(
  userMessage: ConversationMessage,
  history: ConversationMessage[]
): Promise<{ text: string; processingTime: number }> {
  const inSync = syncedMessages === history.length

  if (!inSync) {
    voiceEngine.resetConversation()
  }

  const prompt = inSync ? userMessage.content : renderTranscript(history, userMessage)
  console.log(`[LLM] ${inSync ? 'incremental' : 'replaying transcript'}:`, prompt)

  const reply = await voiceEngine.generate(prompt)
  console.log(`[LLM] reply in ${reply.processingTime}ms:`, reply.text)

  // The node now holds every message up to and including the reply it just made.
  syncedMessages = history.length + 2

  return reply
}

/** Test seam. @internal */
export function _setSyncedMessages(count: number): void {
  syncedMessages = count
}
