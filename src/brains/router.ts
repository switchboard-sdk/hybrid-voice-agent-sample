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

import { activeProfile } from '../profiles'
import { CloudBrain } from './CloudBrain'
import { OnDeviceBrain } from './OnDeviceBrain'
import type { Brain, BrainId } from './types'

/** The `LlamaCpp.LLM` node. One node, so one brain. */
export const onDeviceBrain = new OnDeviceBrain(activeProfile())

/**
 * The cloud LLM, reached through Switchboard's chat endpoint. It takes the same
 * app ID and secret that start the SDK, so there is no second credential to set
 * up and no provider key in the bundle. The URL falls back to production; point
 * it elsewhere to run against a proxy of your own.
 */
export const cloudBrain = new CloudBrain({
  profile: activeProfile(),
  appId: process.env.EXPO_PUBLIC_SWITCHBOARD_APP_ID || undefined,
  appSecret: process.env.EXPO_PUBLIC_SWITCHBOARD_APP_SECRET || undefined,
  baseUrl: process.env.EXPO_PUBLIC_CLOUD_LLM_BASE_URL || undefined,
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
 * (see `src/screens/ModelDownloadScreen.tsx`). A failure is different — a cloud
 * turn the endpoint refuses fails with a message saying why, which is more useful
 * than a silent fallback that looks like the cloud working.
 */
export function route(preferred: BrainId, availability: Availability = FULLY_AVAILABLE): Brain {
  const chosen = brains.find((brain) => brain.id === preferred) ?? onDeviceBrain
  if (canAnswer(chosen, availability)) {
    return chosen
  }
  return brains.find((brain) => canAnswer(brain, availability)) ?? onDeviceBrain
}
