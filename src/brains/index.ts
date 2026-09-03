/**
 * The brains, and the router that picks between them.
 *
 * The interesting file is `router.ts` — this one just re-exports.
 */

export type { AgentProfile, Brain, BrainId, BrainReply, ConversationMessage } from './types'
export { SPOKEN_BREVITY, systemPrompt } from './types'
export { CloudBrain } from './CloudBrain'
export { OnDeviceBrain } from './OnDeviceBrain'
export { brains, canAnswer, cloudBrain, onDeviceBrain, route } from './router'
export type { Availability } from './router'
