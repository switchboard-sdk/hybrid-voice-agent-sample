import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native'

import { ConversationScreen } from './ConversationScreen'
import { EdgeSpeechProvider } from '../voice'
import { voiceEngine } from '../voice/VoiceEngine'
import { cloudBrain, onDeviceBrain, type BrainReply } from '../brains'

// Capture addListener callbacks by event name so tests can simulate the pipeline.
const eventListeners: Record<string, Array<(data?: unknown) => void>> = {}

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

const renderScreen = () =>
  render(
    <EdgeSpeechProvider appId="test-id" appSecret="test-secret">
      <ConversationScreen />
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

describe('ConversationScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
  })
})
