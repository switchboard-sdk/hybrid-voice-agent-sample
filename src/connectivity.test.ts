import { act, renderHook } from '@testing-library/react-native'

import { _resetConnectivity, useOnline } from './connectivity'

jest.mock('expo-network')

const network = jest.requireMock('expo-network') as typeof import('../__mocks__/expo-network')

beforeEach(() => {
  network.resetNetworkMock()
  _resetConnectivity()
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

  it('keeps one subscription however many callers come and go', async () => {
    // expo-network cancels its NWPathMonitor when the last listener leaves and
    // cannot restart it, so the subscription outlives the components that read it.
    const first = renderHook(() => useOnline())
    await act(async () => {})
    renderHook(() => useOnline())
    first.unmount()

    expect(network.addNetworkStateListener).toHaveBeenCalledTimes(1)
    expect(network.addNetworkStateListener.mock.results[0].value.remove).not.toHaveBeenCalled()
  })

  it('still reports a change after the only reader remounted', async () => {
    const first = renderHook(() => useOnline())
    await act(async () => {})
    first.unmount()

    const { result } = renderHook(() => useOnline())
    await act(async () => {
      network.setNetworkState({ isConnected: false, isInternetReachable: false })
    })

    expect(result.current).toBe(false)
  })
})
