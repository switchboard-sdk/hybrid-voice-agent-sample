import { replyOnDevice, resetOnDeviceConversation, _setSyncedMessages } from './onDeviceChat'
import { voiceEngine } from '../voice/VoiceEngine'
import type { ConversationMessage } from './chatService'

jest.mock('../voice/VoiceEngine', () => ({
  __esModule: true,
  voiceEngine: {
    generate: jest.fn(() => Promise.resolve({ text: 'reply', processingTime: 42 })),
    resetConversation: jest.fn(),
  },
}))

const user = (content: string): ConversationMessage => ({ role: 'user', content })
const assistant = (content: string): ConversationMessage => ({ role: 'assistant', content })

beforeEach(() => {
  jest.clearAllMocks()
  _setSyncedMessages(0)
})

describe('replyOnDevice', () => {
  it('sends only the new message on the first turn', async () => {
    await replyOnDevice(user('hello'), [])

    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenCalledWith('hello')
  })

  it('returns the reply text and processing time', async () => {
    const reply = await replyOnDevice(user('hello'), [])
    expect(reply).toEqual({ text: 'reply', processingTime: 42 })
  })

  it('sends only the new message while the node stays in sync', async () => {
    await replyOnDevice(user('hello'), [])
    await replyOnDevice(user('and again'), [user('hello'), assistant('reply')])

    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenLastCalledWith('and again')
  })

  it('resets and replays when the transcript has turns the node never saw', async () => {
    // A cloud turn happened: app state grew without the node generating.
    _setSyncedMessages(0)
    const history = [user('hello'), assistant('answered elsewhere')]

    await replyOnDevice(user('follow up'), history)

    expect(voiceEngine.resetConversation).toHaveBeenCalled()
    const prompt = jest.mocked(voiceEngine.generate).mock.calls[0][0]
    expect(prompt).toContain('User: hello')
    expect(prompt).toContain('Assistant: answered elsewhere')
    expect(prompt).toContain('User: follow up')
  })

  it('is back in sync after a replay, so the next turn is incremental', async () => {
    const history = [user('hello'), assistant('answered elsewhere')]
    await replyOnDevice(user('follow up'), history)
    jest.clearAllMocks()

    await replyOnDevice(user('next'), [...history, user('follow up'), assistant('reply')])

    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenCalledWith('next')
  })

  it('does not advance the sync counter when generation fails', async () => {
    jest.mocked(voiceEngine.generate).mockRejectedValueOnce(new Error('boom'))

    await expect(replyOnDevice(user('hello'), [])).rejects.toThrow('boom')

    // Still at zero, so the next turn replays rather than assuming the node
    // ingested a prompt it never answered.
    await replyOnDevice(user('retry'), [user('hello'), assistant('x')])
    expect(voiceEngine.resetConversation).toHaveBeenCalled()
  })
})

describe('resetOnDeviceConversation', () => {
  it('clears the node and forces the next turn to replay', async () => {
    await replyOnDevice(user('hello'), [])
    jest.clearAllMocks()

    resetOnDeviceConversation('be brief')
    expect(voiceEngine.resetConversation).toHaveBeenCalledWith('be brief')

    await replyOnDevice(user('again'), [user('hello'), assistant('reply')])
    expect(voiceEngine.resetConversation).toHaveBeenCalledTimes(2)
  })
})
