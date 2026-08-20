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
 *   selection from the UI and whether there is a connection; nothing stops it
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

/**
 * Which brain answers the next turn: what the user picked, unless there is no
 * connection and they picked a brain that needs one.
 *
 * Offline is the one thing that overrides the choice, because it is knowable
 * before the turn and the app says so out loud when it happens — see
 * `src/connectivity.ts`. A failure is different: picking the cloud with no API
 * key fails with a message saying so, which is more useful than a silent fallback
 * that looks like the cloud working.
 */
export function route(preferred: BrainId, online: boolean = true): Brain {
  const chosen = brains.find((brain) => brain.id === preferred) ?? onDeviceBrain
  if (online || !chosen.requiresNetwork) {
    return chosen
  }
  return brains.find((brain) => !brain.requiresNetwork) ?? onDeviceBrain
}
