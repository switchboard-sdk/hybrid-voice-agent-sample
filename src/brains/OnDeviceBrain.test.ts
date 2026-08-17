import { OnDeviceBrain } from './OnDeviceBrain'
import { voiceEngine, type LLMReply } from '../voice/VoiceEngine'
import type { ConversationMessage } from './types'

jest.mock('../voice/VoiceEngine', () => ({
  __esModule: true,
  voiceEngine: {
    generate: jest.fn(() => Promise.resolve({ text: 'reply', processingTime: 42 })),
    resetConversation: jest.fn(),
    cancelGeneration: jest.fn(),
  },
}))

const user = (content: string): ConversationMessage => ({ role: 'user', content })
const assistant = (content: string): ConversationMessage => ({ role: 'assistant', content })

let brain: OnDeviceBrain

beforeEach(() => {
  jest.clearAllMocks()
  // The sync counter is per brain, so a fresh one starts from a clean node.
  brain = new OnDeviceBrain()
})

describe('reply', () => {
  it('sends only the new message on the first turn', async () => {
    await brain.reply('hello', [])

    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenCalledWith('hello')
  })

  it('reports the reply, the brain that answered and a timing', async () => {
    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('reply')
    expect(reply.brain).toBe('on-device')
    expect(typeof reply.processingTime).toBe('number')
  })

  it('sends only the new message while the node stays in sync', async () => {
    await brain.reply('hello', [])
    await brain.reply('and again', [user('hello'), assistant('reply')])

    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenLastCalledWith('and again')
  })

  it('resets and replays when the transcript has turns the node never saw', async () => {
    // A cloud turn happened: app state grew without the node generating.
    const history = [user('hello'), assistant('answered elsewhere')]

    await brain.reply('follow up', history)

    expect(voiceEngine.resetConversation).toHaveBeenCalled()
    const prompt = jest.mocked(voiceEngine.generate).mock.calls[0][0]
    expect(prompt).toContain('User: hello')
    expect(prompt).toContain('Assistant: answered elsewhere')
    expect(prompt).toContain('User: follow up')
  })

  it('is back in sync after a replay, so the next turn is incremental', async () => {
    const history = [user('hello'), assistant('answered elsewhere')]
    await brain.reply('follow up', history)
    jest.clearAllMocks()

    await brain.reply('next', [...history, user('follow up'), assistant('reply')])

    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenCalledWith('next')
  })

  it('does not advance the sync counter when generation fails', async () => {
    jest.mocked(voiceEngine.generate).mockRejectedValueOnce(new Error('boom'))

    await expect(brain.reply('hello', [])).rejects.toThrow('boom')

    // Still at zero, so the next turn replays rather than assuming the node
    // ingested a prompt it never answered.
    await brain.reply('retry', [user('hello'), assistant('x')])
    expect(voiceEngine.resetConversation).toHaveBeenCalled()
  })

  it('keeps its sync counter to itself', async () => {
    await brain.reply('hello', [])
    const other = new OnDeviceBrain()

    // A second brain has ingested nothing, so the same history is a divergence
    // for it even though the first brain is in sync.
    await other.reply('and again', [user('hello'), assistant('reply')])
    expect(voiceEngine.resetConversation).toHaveBeenCalledTimes(1)
  })
})

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(brain.reply('hello', [], controller.signal)).rejects.toThrow(/cancelled/i)
    expect(voiceEngine.generate).not.toHaveBeenCalled()
  })

  it('abandons the generation and forces the next turn to replay', async () => {
    const controller = new AbortController()
    let rejectGeneration: (error: Error) => void = () => {}
    const stuck = new Promise<LLMReply>((_, reject) => {
      rejectGeneration = reject
    })
    jest.mocked(voiceEngine.generate).mockReturnValueOnce(stuck)
    // The engine rejects the pending generation when told to cancel.
    jest.mocked(voiceEngine.cancelGeneration).mockImplementationOnce(() => {
      rejectGeneration(new Error('GENERATION_CANCELLED'))
    })

    const turn = brain.reply('hello', [], controller.signal)
    controller.abort()

    await expect(turn).rejects.toThrow(/cancelled/i)
    expect(voiceEngine.cancelGeneration).toHaveBeenCalled()

    // The node was left holding a turn the transcript does not account for, so
    // the next one starts over.
    await brain.reply('never mind', [])
    expect(voiceEngine.resetConversation).toHaveBeenCalled()
  })
})

describe('reset', () => {
  it('clears the node and forces the next turn to replay', async () => {
    await brain.reply('hello', [])
    jest.clearAllMocks()

    brain.reset('be brief')
    expect(voiceEngine.resetConversation).toHaveBeenCalledWith('be brief')

    await brain.reply('again', [user('hello'), assistant('reply')])
    expect(voiceEngine.resetConversation).toHaveBeenCalledTimes(2)
  })
})
