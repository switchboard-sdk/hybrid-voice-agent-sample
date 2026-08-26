import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native'

import { ConversationScreen } from './ConversationScreen'
import { EdgeSpeechProvider } from '../voice'
import { voiceEngine } from '../voice/VoiceEngine'
import { cloudBrain, onDeviceBrain, type BrainReply } from '../brains'
import { OFFLINE_NOTICE } from '../connectivity'

// Capture addListener callbacks by event name so tests can simulate the pipeline.
const eventListeners: Record<string, Array<(data?: unknown) => void>> = {}

jest.mock('expo-network')

const network = jest.requireMock('expo-network') as typeof import('../../__mocks__/expo-network')

jest.mock('../voice/VoiceEngine', () => ({
  __esModule: true,
  voiceEngine: {
    addListener: jest.fn(),
    initialize: jest.fn(),
    configure: jest.fn(),
    listen: jest.fn(() => Promise.resolve()),
    stopListening: jest.fn(() => Promise.resolve()),
    speak: jest.fn(() => Promise.resolve()),
    stopSpeaking: jest.fn(() => Promise.resolve()),
    requestMicrophonePermission: jest.fn(() => Promise.resolve(true)),
    resetConversation: jest.fn(),
  },
}))

/** Fire a simulated pipeline event with optional payload. */
function fireNativeEvent(eventName: string, data?: unknown): void {
  ;(eventListeners[eventName] ?? []).forEach((cb) => cb(data))
}

const renderScreen = (modelReady = true) =>
  render(
    <EdgeSpeechProvider appId="test-id" appSecret="test-secret">
      <ConversationScreen modelReady={modelReady} />
    </EdgeSpeechProvider>
  )

const reply = (text: string, brain: BrainReply['brain'], ms: number): BrainReply => ({
  text,
  brain,
  processingTime: ms,
})

/** Press Talk and settle the permission + listen promises. */
async function startTalking(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByText('Talk'))
  })
}

/** Deliver a final transcript and let the turn it starts run to completion. */
async function say(text: string): Promise<void> {
  await act(async () => {
    fireNativeEvent('onTranscript', { text, isFinal: true })
  })
}

/** An error tagged the way both layers tag theirs. */
const codedError = (code: string, message: string): Error => {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

describe('ConversationScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    network.resetNetworkMock()
    Object.keys(eventListeners).forEach((key) => {
      eventListeners[key] = []
    })

    jest.mocked(voiceEngine.addListener).mockImplementation((eventName, listener) => {
      const name = eventName as string
      const callback = listener as (data?: unknown) => void
      if (!eventListeners[name]) {
        eventListeners[name] = []
      }
      eventListeners[name].push(callback)
      return { remove: jest.fn() }
    })

    // clearAllMocks clears calls, not implementations, so a failure set by one test
    // would leak into the rest.
    jest.mocked(voiceEngine.requestMicrophonePermission).mockResolvedValue(true)
    jest.mocked(voiceEngine.listen).mockResolvedValue(undefined)
    jest.mocked(voiceEngine.stopListening).mockResolvedValue(undefined)
    jest.mocked(voiceEngine.speak).mockResolvedValue(undefined)
    jest.mocked(voiceEngine.stopSpeaking).mockResolvedValue(undefined)

    jest.spyOn(onDeviceBrain, 'reply').mockResolvedValue(reply('On the device.', 'on-device', 1234))
    jest.spyOn(cloudBrain, 'reply').mockResolvedValue(reply('From the cloud.', 'cloud', 840))
    jest.spyOn(onDeviceBrain, 'reset').mockImplementation(() => {})
    jest.spyOn(cloudBrain, 'reset').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('framing', () => {
    it('presents itself as a travel agent with a voice that is not human', () => {
      renderScreen()

      expect(screen.getByText('Travel Assistant')).toBeTruthy()
      expect(screen.getByText('◆ AI VOICE')).toBeTruthy()
      expect(screen.getByText('A synthetic voice — not a person')).toBeTruthy()
    })

    it('suggests what to ask before the first turn', () => {
      renderScreen()

      expect(screen.getByText('Ask about your trip')).toBeTruthy()
      expect(screen.getByText('“How do I get from the airport to the harbour?”')).toBeTruthy()
    })
  })

  describe('the talk control', () => {
    it('asks for the microphone and starts listening', async () => {
      renderScreen()
      await startTalking()

      expect(voiceEngine.requestMicrophonePermission).toHaveBeenCalled()
      expect(voiceEngine.listen).toHaveBeenCalled()
      expect(screen.getByText('End conversation')).toBeTruthy()
    })

    it('stops the pipeline when the conversation is ended', async () => {
      renderScreen()
      await startTalking()

      await act(async () => {
        fireEvent.press(screen.getByText('End conversation'))
      })

      expect(voiceEngine.stopSpeaking).toHaveBeenCalled()
      expect(voiceEngine.stopListening).toHaveBeenCalled()
      expect(screen.getByText('Talk')).toBeTruthy()
    })

    it('ignores a transcript that arrives outside a conversation', async () => {
      renderScreen()
      await say('stray audio')

      expect(onDeviceBrain.reply).not.toHaveBeenCalled()
      expect(screen.queryByText('stray audio')).toBeNull()
    })
  })

  describe('a turn', () => {
    it('shows what was said, the reply, and who answered how fast', async () => {
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')

      expect(screen.getByText('How do I get to the harbour?')).toBeTruthy()
      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())
      expect(screen.getByTestId('turn-brain-1').props.children).toBe('On-device')
      expect(screen.getByTestId('turn-time-1').props.children).toBe('1.2 s')
    })

    it('reports sub-second replies in milliseconds', async () => {
      renderScreen()
      await startTalking()
      await act(async () => {
        fireEvent.press(screen.getByText('Cloud'))
      })
      await say('Any flights tomorrow?')

      await waitFor(() => expect(screen.getByText('From the cloud.')).toBeTruthy())
      expect(screen.getByTestId('turn-time-1').props.children).toBe('840 ms')
    })

    it('badges each turn with the brain that served it after a mid-conversation switch', async () => {
      renderScreen()
      await startTalking()
      await say('First question')
      await waitFor(() => expect(screen.getByTestId('turn-brain-1')).toBeTruthy())

      await act(async () => {
        fireEvent.press(screen.getByText('Cloud'))
      })
      await say('Second question')
      await waitFor(() => expect(screen.getByTestId('turn-brain-3')).toBeTruthy())

      // The earlier turn keeps its badge — the switch labels turns, not the screen.
      expect(screen.getByTestId('turn-brain-1').props.children).toBe('On-device')
      expect(screen.getByTestId('turn-brain-3').props.children).toBe('Cloud')
    })

    it('drops an empty transcript rather than answering it', async () => {
      renderScreen()
      await startTalking()
      await say('   ')

      expect(onDeviceBrain.reply).not.toHaveBeenCalled()
    })

    it('hands the brain the conversation up to but excluding the new turn', async () => {
      renderScreen()
      await startTalking()
      await say('First question')
      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())
      await say('Second question')

      await waitFor(() => expect(onDeviceBrain.reply).toHaveBeenCalledTimes(2))
      expect(jest.mocked(onDeviceBrain.reply).mock.calls[1][0]).toBe('Second question')
      expect(jest.mocked(onDeviceBrain.reply).mock.calls[1][1]).toEqual([
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'On the device.' },
      ])
    })
  })

  describe('failures', () => {
    it('shows a turn failure in a banner rather than a modal', async () => {
      jest
        .mocked(onDeviceBrain.reply)
        .mockRejectedValue(
          codedError('GENERATE_TIMEOUT', 'The on-device model did not reply in time')
        )
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')

      await waitFor(() =>
        expect(screen.getByText(/on-device model is not responding/i)).toBeTruthy()
      )
      // The turn that failed is still visible; only the answer is missing.
      expect(screen.getByText('How do I get to the harbour?')).toBeTruthy()
    })

    it('offers the other brain when one fails, and switching clears the banner', async () => {
      jest
        .mocked(onDeviceBrain.reply)
        .mockRejectedValue(codedError('CLOUD_UNREACHABLE', 'Network request failed'))
      renderScreen()
      await startTalking()
      await say('Any flights tomorrow?')

      await waitFor(() => expect(screen.getByText(/Use the Cloud brain/)).toBeTruthy())
      await act(async () => {
        fireEvent.press(screen.getByText(/Use the Cloud brain/))
      })

      expect(screen.queryByText(/cannot be reached/i)).toBeNull()
    })

    it('surfaces what the engine reports', async () => {
      renderScreen()

      await act(async () => {
        fireNativeEvent('onError', {
          code: 'INIT_FAILED',
          message: 'Failed to initialize Switchboard SDK',
        })
      })

      expect(screen.getByText(/Switchboard SDK could not start/i)).toBeTruthy()
    })

    it('takes the banner down once a turn works', async () => {
      jest
        .mocked(onDeviceBrain.reply)
        .mockRejectedValueOnce(codedError('GENERATE_FAILED', 'nope'))
        .mockResolvedValueOnce(reply('On the device.', 'on-device', 1234))
      renderScreen()
      await startTalking()
      await say('first')
      await waitFor(() => expect(screen.getByText(/could not answer that turn/i)).toBeTruthy())

      await say('second')

      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())
      expect(screen.queryByText(/could not answer that turn/i)).toBeNull()
    })

    it('can be dismissed', async () => {
      renderScreen()
      await act(async () => {
        fireNativeEvent('onError', { code: 'LISTEN_FAILED', message: 'no mic' })
      })

      await act(async () => {
        fireEvent.press(screen.getByLabelText('Dismiss'))
      })

      expect(screen.queryByText(/microphone could not be started/i)).toBeNull()
    })
  })

  describe('a session that cannot start', () => {
    it('offers Settings when the microphone is denied, and stays closed', async () => {
      jest.mocked(voiceEngine.requestMicrophonePermission).mockResolvedValue(false)
      renderScreen()
      await startTalking()

      expect(screen.getByText(/cannot hear you without microphone access/i)).toBeTruthy()
      expect(screen.getByText('Open Settings')).toBeTruthy()
      expect(screen.getByText('Talk')).toBeTruthy()
      expect(voiceEngine.listen).not.toHaveBeenCalled()
    })

    it('does not arm the session when the microphone fails to open', async () => {
      jest
        .mocked(voiceEngine.listen)
        .mockRejectedValue(codedError('NOT_INITIALIZED', 'Switchboard SDK not initialized'))
      renderScreen()
      await startTalking()

      // Not "End conversation" over an engine that never started.
      expect(screen.getByText('Talk')).toBeTruthy()
      expect(screen.getByText(/has not started yet/i)).toBeTruthy()
    })
  })

  describe('the state indicator', () => {
    it('rests as not listening', () => {
      renderScreen()
      expect(screen.getByText('Not listening')).toBeTruthy()
    })

    it('follows the pipeline through listening and speaking', async () => {
      renderScreen()

      await act(async () => {
        fireNativeEvent('onStateChange', { state: 'listening' })
      })
      expect(screen.getByText('Listening')).toBeTruthy()

      await act(async () => {
        fireNativeEvent('onStateChange', { state: 'speaking' })
      })
      expect(screen.getByText('Speaking')).toBeTruthy()
    })

    it('says which brain is thinking while a reply is in flight', async () => {
      jest.mocked(onDeviceBrain.reply).mockReturnValue(new Promise(() => {}))
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')

      expect(screen.getByText('Thinking')).toBeTruthy()
      expect(screen.getByText('On-device is thinking…')).toBeTruthy()
    })
  })

  describe('interruptions', () => {
    it('marks the reply that was talked over', async () => {
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')
      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())

      await act(async () => {
        fireNativeEvent('onInterrupted')
      })

      expect(screen.getByText('interrupted')).toBeTruthy()
      // Not a turn of its own: the transcript is still the two real messages.
      expect(screen.queryByTestId('turn-brain-3')).toBeNull()
    })

    it('marks nothing when what was talked over was not a reply', async () => {
      // The offline notice is spoken while the last message is still the question,
      // which is not a turn that can be cut off.
      jest.mocked(onDeviceBrain.reply).mockReturnValue(new Promise(() => {}))
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')

      await act(async () => {
        fireNativeEvent('onInterrupted')
      })

      expect(screen.queryByText('interrupted')).toBeNull()
    })
  })

  describe('losing the connection', () => {
    /** Report the connection dropping, the way the OS does. */
    async function goOffline(): Promise<void> {
      await act(async () => {
        network.setNetworkState({ isConnected: false, isInternetReachable: false })
      })
    }

    /** Pick the cloud brain, which is only possible while there is a connection. */
    async function chooseCloud(): Promise<void> {
      await act(async () => {
        fireEvent.press(screen.getByText('Cloud'))
      })
    }

    it('says so out loud and takes the cloud brain away', async () => {
      renderScreen()
      await startTalking()
      await chooseCloud()

      await goOffline()

      expect(voiceEngine.speak).toHaveBeenCalledWith(OFFLINE_NOTICE)
      expect(screen.getByText('Cloud')).toBeDisabled()
      expect(screen.getByText(/No connection/)).toBeTruthy()
    })

    it('cannot be talked back onto the cloud while it lasts', async () => {
      renderScreen()
      await startTalking()
      await goOffline()

      await chooseCloud()
      await say('Any flights tomorrow?')

      await waitFor(() => expect(onDeviceBrain.reply).toHaveBeenCalled())
      expect(cloudBrain.reply).not.toHaveBeenCalled()
    })

    it('answers the question the cloud was still holding', async () => {
      // A request that hangs until it is abandoned, which is what a cloud turn
      // becomes the moment the connection goes.
      jest.mocked(cloudBrain.reply).mockImplementation(
        (_text, _history, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(codedError('CANCELLED', 'The reply was cancelled'))
            )
          })
      )
      renderScreen()
      await startTalking()
      await chooseCloud()
      await say('Any flights tomorrow?')

      await goOffline()

      expect(voiceEngine.speak).toHaveBeenCalledWith(OFFLINE_NOTICE)
      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())
      expect(jest.mocked(onDeviceBrain.reply).mock.calls[0][0]).toBe('Any flights tomorrow?')
      // The question is not asked twice, and an abandoned turn is not a failure.
      expect(screen.getAllByText('Any flights tomorrow?')).toHaveLength(1)
      expect(screen.getByTestId('turn-brain-1').props.children).toBe('On-device')
      expect(screen.queryByText(/cannot be reached/i)).toBeNull()
    })

    it('picks up a question left unanswered with no turn in flight', async () => {
      // The cloud turn can be gone by the time the connectivity change lands, so
      // what to re-ask comes from the transcript rather than from a live turn.
      jest.mocked(cloudBrain.reply).mockRejectedValue(codedError('CANCELLED', 'abandoned'))
      renderScreen()
      await startTalking()
      await chooseCloud()
      await say('Any flights tomorrow?')
      expect(screen.queryByText('From the cloud.')).toBeNull()

      await goOffline()

      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())
      expect(jest.mocked(onDeviceBrain.reply).mock.calls[0][0]).toBe('Any flights tomorrow?')
      expect(screen.getAllByText('Any flights tomorrow?')).toHaveLength(1)
    })

    it('leaves a turn on the device alone', async () => {
      jest.mocked(onDeviceBrain.reply).mockReturnValue(new Promise(() => {}))
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')

      await goOffline()

      // Nothing was taken away, so nothing is said over the reply being generated.
      expect(voiceEngine.speak).not.toHaveBeenCalledWith(OFFLINE_NOTICE)
      expect(onDeviceBrain.reply).toHaveBeenCalledTimes(1)
    })

    it('stays quiet when no conversation is happening', async () => {
      renderScreen()

      await goOffline()

      expect(voiceEngine.speak).not.toHaveBeenCalled()
      expect(screen.getByText('Cloud')).toBeDisabled()
    })

    it('offers no other brain for a failure while there is none', async () => {
      jest.mocked(onDeviceBrain.reply).mockRejectedValue(codedError('GENERATE_FAILED', 'nope'))
      renderScreen()
      await startTalking()
      await goOffline()
      await say('How do I get to the harbour?')

      await waitFor(() => expect(screen.getByText(/could not answer that turn/i)).toBeTruthy())
      expect(screen.queryByText(/Use the Cloud brain/)).toBeNull()
    })

    it('hands the cloud brain back when the connection returns', async () => {
      renderScreen()
      await startTalking()
      await chooseCloud()
      await goOffline()

      await act(async () => {
        network.setNetworkState({ isConnected: true, isInternetReachable: true })
      })
      await say('Any flights tomorrow?')

      // The pick was kept through the outage, so it answers again without a tap.
      await waitFor(() => expect(screen.getByText('From the cloud.')).toBeTruthy())
      expect(screen.getByText(/Switch any time/)).toBeTruthy()
    })
  })

  describe('without the model on the phone', () => {
    it('takes the on-device brain away and says the cloud is answering', () => {
      renderScreen(false)

      expect(screen.getByText('On-device')).toBeDisabled()
      expect(screen.getByText(/No model on this phone/)).toBeTruthy()
    })

    it('answers from the cloud even though on-device is the default pick', async () => {
      renderScreen(false)
      await startTalking()

      await say('Any flights tomorrow?')

      await waitFor(() => expect(cloudBrain.reply).toHaveBeenCalled())
      expect(onDeviceBrain.reply).not.toHaveBeenCalled()
    })

    it('stays quiet about going offline, having nothing left to answer with', async () => {
      // The notice promises an answer on this phone, and without the model there
      // is no brain left to keep that promise.
      renderScreen(false)
      await startTalking()

      await act(async () => {
        network.setNetworkState({ isConnected: false, isInternetReachable: false })
      })

      expect(voiceEngine.speak).not.toHaveBeenCalledWith(OFFLINE_NOTICE)
    })

    it('promises neither brain when there is no connection either', async () => {
      renderScreen(false)

      await act(async () => {
        network.setNetworkState({ isConnected: false, isInternetReachable: false })
      })

      expect(screen.getByText(/neither brain can answer/)).toBeTruthy()
    })
  })

  describe('clearing', () => {
    it('empties the transcript and resets both brains', async () => {
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')
      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())

      await act(async () => {
        fireEvent.press(screen.getByText('Clear'))
      })

      expect(screen.queryByText('How do I get to the harbour?')).toBeNull()
      expect(screen.getByText('Ask about your trip')).toBeTruthy()
      expect(onDeviceBrain.reset).toHaveBeenCalled()
      expect(cloudBrain.reset).toHaveBeenCalled()
    })

    it('stops a reply that is still being read out', async () => {
      renderScreen()
      await startTalking()
      await say('How do I get to the harbour?')
      await waitFor(() => expect(screen.getByText('On the device.')).toBeTruthy())

      await act(async () => {
        fireEvent.press(screen.getByText('Clear'))
      })

      expect(voiceEngine.stopSpeaking).toHaveBeenCalled()
    })
  })
})
