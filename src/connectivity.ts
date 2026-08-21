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

import { useEffect, useState } from 'react'
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network'

/** Spoken rather than shown — an audible notice is the point of it. */
export const OFFLINE_NOTICE =
  "You're offline now. I'll answer on this phone, so a reply may take a moment."

/** Unknown counts as connected: only a definite answer withdraws the cloud brain. */
function isOnline(state: NetworkState): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false
}

/** Tracks the device's connectivity, starting from the state at mount. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true)

  useEffect(() => {
    let subscribed = true
    let reported = false

    const subscription = addNetworkStateListener((state) => {
      reported = true
      setOnline(isOnline(state))
    })

    // Only a starting point, and only if it lands first: a change reported while
    // this was in flight is newer than it is. A read that fails leaves the
    // optimistic default standing until the OS reports something.
    getNetworkStateAsync()
      .then((state) => {
        if (subscribed && !reported) {
          setOnline(isOnline(state))
        }
      })
      .catch(() => {})

    return () => {
      subscribed = false
      subscription.remove()
    }
  }, [])

  return online
}
