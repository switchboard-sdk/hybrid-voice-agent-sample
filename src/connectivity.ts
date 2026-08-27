/**
 * Whether the phone has a connection, and what to say when it loses one.
 *
 * The cloud brain is the only part of the app that needs a network, so this exists
 * to take it off the table before a turn fails rather than after: `route` withdraws
 * it while offline and the picker dims it.
 *
 * The OS reports the change, so airplane mode registers the moment it is switched
 * on rather than on the next request.
 */

import { useSyncExternalStore } from 'react'
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network'

/** Spoken rather than shown — an audible notice is the point of it. */
export const OFFLINE_NOTICE =
  "You're offline now. I'll answer on this phone, so a reply may take a moment."

/** Unknown counts as connected: only a definite answer withdraws the cloud brain. */
function isOnline(state: NetworkState): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false
}

/**
 * One subscription for the whole process, opened on first use and never closed.
 *
 * `expo-network` starts a single `NWPathMonitor` when its first listener attaches
 * and cancels it when the last one leaves, and a cancelled `NWPathMonitor` cannot be
 * restarted. A subscription owned by a component would therefore stop reporting the
 * moment that component remounted, silently and for the rest of the session — so
 * ownership sits here instead, and React reads it.
 */
let online = true
let listening = false
let reportedByOS = false
const subscribers = new Set<() => void>()

function publish(next: boolean): void {
  if (next === online) {
    return
  }
  online = next
  subscribers.forEach((notify) => notify())
}

function startListening(): void {
  if (listening) {
    return
  }
  listening = true

  addNetworkStateListener((state) => {
    reportedByOS = true
    console.log('[net]', isOnline(state) ? 'online' : 'offline', JSON.stringify(state))
    publish(isOnline(state))
  })

  // Only a starting point, and only if it lands first: a change reported while this
  // was in flight is newer than it is. A read that fails leaves the optimistic
  // default standing until the OS reports something.
  getNetworkStateAsync()
    .then((state) => {
      if (!reportedByOS) {
        publish(isOnline(state))
      }
    })
    .catch(() => {})
}

function subscribe(notify: () => void): () => void {
  startListening()
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** Tracks the device's connectivity, starting from the state at first use. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => online,
    () => online
  )
}

/**
 * Forget the connection state and the subscription. For tests only.
 * @internal
 */
export function _resetConnectivity(): void {
  online = true
  listening = false
  reportedByOS = false
  subscribers.clear()
}
