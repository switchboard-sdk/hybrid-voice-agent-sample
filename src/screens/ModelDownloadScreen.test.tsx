import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native'

import { ModelDownloadScreen } from './ModelDownloadScreen'
import type { ModelDownload, ModelStatus } from '../model'
import { _resetConnectivity } from '../connectivity'

jest.mock('expo-network')
// jest-expo registers its own expo-file-system mock in its setup file, so this has
// to be installed over the top of it rather than picked up from __mocks__.
jest.mock('expo-file-system', () => require('../../__mocks__/fileSystem'))
jest.mock('expo-file-system/legacy', () => require('../../__mocks__/fileSystemDownload'))

const network = jest.requireMock('expo-network') as typeof import('../../__mocks__/expo-network')

const start = jest.fn()
const onSkip = jest.fn()

const download = (status: ModelStatus, extra: Partial<ModelDownload> = {}): ModelDownload => ({
  status,
  received: 0,
  total: null,
  path: null,
  failure: null,
  start,
  ...extra,
})

const renderScreen = (state: ModelDownload) =>
  render(<ModelDownloadScreen download={state} onSkip={onSkip} />)

beforeEach(() => {
  jest.clearAllMocks()
  network.resetNetworkMock()
  _resetConnectivity()
})

describe('ModelDownloadScreen', () => {
  // Meta's licence obligation, not a nicety, so it is held to every state the
  // screen can be in rather than just the one it opens on.
  it.each<ModelStatus>(['checking', 'missing', 'downloading', 'failed'])(
    'attributes Llama while %s',
    (status) => {
      renderScreen(download(status))

      expect(screen.getByText('Built with Llama')).toBeTruthy()
    }
  )

  it('says what the download costs before asking for it', () => {
    renderScreen(download('missing'))

    expect(screen.getByText(/Download the model \(773 MB\)/)).toBeTruthy()
  })

  it('starts the download when asked', () => {
    renderScreen(download('missing'))

    fireEvent.press(screen.getByText(/Download the model/))

    expect(start).toHaveBeenCalledTimes(1)
  })

  it('counts what has arrived against what the server declared', () => {
    renderScreen(download('downloading', { received: 386_512_960, total: 773_025_920 }))

    expect(screen.getByText('387 MB of 773 MB · 50%')).toBeTruthy()
  })

  it('says the download survives the app being put away', () => {
    renderScreen(download('downloading', { received: 1, total: 773_025_920 }))

    expect(screen.getByText(/carries on in the background/)).toBeTruthy()
  })

  it('says a download with no connection will pick itself up', async () => {
    renderScreen(download('downloading', { received: 1, total: 773_025_920 }))

    await act(async () => {
      network.setNetworkState({ isConnected: false, isInternetReachable: false })
    })

    await waitFor(() => expect(screen.getByText(/picks up again on its own/)).toBeTruthy())
  })

  it('shows what went wrong and offers another go', () => {
    renderScreen(download('failed', { failure: { message: 'The model could not be downloaded.' } }))

    expect(screen.getByText('The model could not be downloaded.')).toBeTruthy()
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  it('offers a way past the model, and takes it', () => {
    renderScreen(download('failed', { failure: { message: 'Nope.' } }))

    fireEvent.press(screen.getByText('Use the cloud brain instead'))

    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('does not offer a way past while the download is running', () => {
    // Nothing to escape yet, and leaving mid-download would throw away the bytes.
    renderScreen(download('downloading', { received: 1, total: 2 }))

    expect(screen.queryByText('Use the cloud brain instead')).toBeNull()
  })
})
