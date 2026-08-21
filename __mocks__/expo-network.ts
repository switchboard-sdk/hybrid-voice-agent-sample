// Manual Jest mock for expo-network.
//
// The real module resolves a native module on import, which is not there under
// Jest, so any suite that pulls in `src/connectivity.ts` must mock it via
// `jest.mock('expo-network')`.
//
// Only the two calls the app makes are modelled. `addNetworkStateListener(cb)`
// records the subscriber and returns a subscription with a real `remove()`; use
// `setNetworkState()` to push a change through the current subscribers, the way
// the OS reports one.

type NetworkState = {
  isConnected?: boolean
  isInternetReachable?: boolean
}

type Listener = (state: NetworkState) => void

const CONNECTED: NetworkState = { isConnected: true, isInternetReachable: true }

let state: NetworkState = CONNECTED
const listeners = new Set<Listener>()

export const getNetworkStateAsync = jest.fn<Promise<NetworkState>, []>(() => Promise.resolve(state))

export const addNetworkStateListener = jest.fn((listener: Listener) => {
  listeners.add(listener)
  return {
    remove: jest.fn(() => {
      listeners.delete(listener)
    }),
  }
})

/** Change the state and report it to every current subscriber. */
export function setNetworkState(next: NetworkState): void {
  state = next
  listeners.forEach((listener) => listener(next))
}

/** The state a later `getNetworkStateAsync()` sees, without reporting a change. */
export function primeNetworkState(next: NetworkState): void {
  state = next
}

/** Reset the mock fns, the state and the subscribers between tests. */
export function resetNetworkMock(): void {
  state = CONNECTED
  listeners.clear()
  getNetworkStateAsync.mockClear()
  addNetworkStateListener.mockClear()
}
