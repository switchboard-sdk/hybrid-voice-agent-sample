import { act, renderHook } from '@testing-library/react-native'

import { useOnline } from './connectivity'

jest.mock('expo-network')

const network = jest.requireMock('expo-network') as typeof import('../__mocks__/expo-network')

beforeEach(() => {
  network.resetNetworkMock()
})

describe('useOnline', () => {
  it('reads the state at mount', async () => {
    network.primeNetworkState({ isConnected: false, isInternetReachable: false })

    const { result } = renderHook(() => useOnline())
    // Optimistic until the first read lands, so a session never starts by
    // withdrawing a brain it has no answer about yet.
    expect(result.current).toBe(true)

    await act(async () => {})
    expect(result.current).toBe(false)
  })

  it('follows the connection dropping and coming back', async () => {
    const { result } = renderHook(() => useOnline())
    await act(async () => {})

    await act(async () => {
      network.setNetworkState({ isConnected: false, isInternetReachable: false })
    })
    expect(result.current).toBe(false)

    await act(async () => {
      network.setNetworkState({ isConnected: true, isInternetReachable: true })
    })
    expect(result.current).toBe(true)
  })

  it('counts a connection with no internet as offline', async () => {
    const { result } = renderHook(() => useOnline())
    await act(async () => {})

    await act(async () => {
      network.setNetworkState({ isConnected: true, isInternetReachable: false })
    })

    expect(result.current).toBe(false)
  })

  it('keeps a change that arrives before the first read resolves', async () => {
    const { result } = renderHook(() => useOnline())

    await act(async () => {
      // The read at mount is still in flight, and answers with the state as it was.
      network.setNetworkState({ isConnected: false, isInternetReachable: false })
    })

    expect(result.current).toBe(false)
  })

  it('treats an unknown state as connected', async () => {
    // Airplane mode reports a definite answer; anything vaguer is not grounds for
    // taking the cloud brain away.
    network.primeNetworkState({})

    const { result } = renderHook(() => useOnline())
    await act(async () => {})

    expect(result.current).toBe(true)
  })

  it('stops listening once the caller unmounts', async () => {
    const { unmount } = renderHook(() => useOnline())
    await act(async () => {})
    const subscription = network.addNetworkStateListener.mock.results[0].value

    unmount()

    expect(subscription.remove).toHaveBeenCalled()
  })
})
