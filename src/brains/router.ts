/**
 * Which brain answers, and how that is decided.
 *
 * **This is the file to change.** Everything else in the app talks to the `Brain`
 * interface and never learns which implementation it got, so this is the only
 * place that names them. Two things you might want to do here:
 *
 * - **Add a brain.** Write a class implementing `Brain`, construct it below, and
 *   add it to `brains`. It appears in the UI on its own — the picker is rendered
 *   from this list.
 * - **Route on something other than the user's choice.** `route` is handed the
 *   selection from the UI and what the phone can currently do; nothing stops it
 *   consulting the length of the conversation or a latency budget as well.
 */

import { CloudBrain } from './CloudBrain'
import { OnDeviceBrain } from './OnDeviceBrain'
import type { Brain, BrainId } from './types'

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

/** Every brain the app can route to, in the order the UI offers them. */
export const brains: readonly Brain[] = [onDeviceBrain, cloudBrain]

/** What the phone can do right now, which is what a brain needs to be able to answer. */
export interface Availability {
  /** Whether there is a connection. */
  online: boolean
  /** Whether the model's weights are on the phone — see `src/model`. */
  modelReady: boolean
}

/** Everything available, the state the app spends nearly all its time in. */
const FULLY_AVAILABLE: Availability = { online: true, modelReady: true }

/**
 * Whether `brain` could answer right now. Exported so the picker can dim an
 * option without learning which implementation it is dimming.
 */
export function canAnswer(brain: Brain, availability: Availability): boolean {
  if (brain.requiresNetwork && !availability.online) {
    return false
  }
  return !brain.requiresModel || availability.modelReady
}

/**
 * Which brain answers the next turn: what the user picked, unless the phone
 * cannot currently give that brain what it needs.
 *
 * Only these two things override the choice, because both are knowable before the
 * turn: the app says the offline one out loud when it happens (see
 * `src/connectivity.ts`) and puts the missing model in front of the conversation
 * (see `src/screens/ModelDownloadScreen.tsx`). A failure is different — picking
 * the cloud with no API key fails with a message saying so, which is more useful
 * than a silent fallback that looks like the cloud working.
 */
export function route(preferred: BrainId, availability: Availability = FULLY_AVAILABLE): Brain {
  const chosen = brains.find((brain) => brain.id === preferred) ?? onDeviceBrain
  if (canAnswer(chosen, availability)) {
    return chosen
  }
  return brains.find((brain) => canAnswer(brain, availability)) ?? onDeviceBrain
}
