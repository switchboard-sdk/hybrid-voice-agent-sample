/**
 * The two brains, and the one place the cloud configuration is read from the
 * environment — mirroring how `App.tsx` reads the Switchboard credentials.
 *
 * Choosing between them is a plain import for now.
 */

import { CloudBrain } from './CloudBrain'
import { OnDeviceBrain } from './OnDeviceBrain'

export type { Brain, BrainId, BrainReply, ConversationMessage } from './types'
export { DEFAULT_SYSTEM_PROMPT } from './types'
export { CloudBrain } from './CloudBrain'
export { OnDeviceBrain } from './OnDeviceBrain'

/** The `LlamaCpp.LLM` node. One node, so one brain. */
export const onDeviceBrain = new OnDeviceBrain()

/**
 * The cloud LLM. The key is required and the other two fall back to sensible
 * defaults; selecting this brain without a key fails with a message saying so.
 * See the README on why an `EXPO_PUBLIC_` key is demo-grade and what to do
 * instead.
 */
export const cloudBrain = new CloudBrain({
  apiKey: process.env.EXPO_PUBLIC_CLOUD_LLM_API_KEY || undefined,
  baseUrl: process.env.EXPO_PUBLIC_CLOUD_LLM_BASE_URL || undefined,
  model: process.env.EXPO_PUBLIC_CLOUD_LLM_MODEL || undefined,
})
