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
    expect(prompt).toContain('Me: hello')
    expect(prompt).toContain('You: answered elsewhere')
    expect(prompt).toContain('My new message is: follow up')
  })

  it('ends the replay on an instruction, not another transcript line', async () => {
    // A prompt that ends mid-transcript invites the model to write the next line
    // rather than answer.
    await brain.reply('follow up', [user('hello'), assistant('hi')])

    const prompt = jest.mocked(voiceEngine.generate).mock.calls[0][0]
    expect(prompt.trimEnd().split('\n').pop()).toMatch(/^Reply to my new message/)
  })

  it.each(['Me: sure', 'You: sure', 'Assistant: sure', '  user:  sure'])(
    'drops a transcript label the model wrote instead of answering (%s)',
    async (raw) => {
      jest.mocked(voiceEngine.generate).mockResolvedValueOnce({ text: raw, processingTime: 1 })

      const reply = await brain.reply('hello', [])

      expect(reply.text).toBe('sure')
    }
  )

  it('leaves a reply that merely contains a colon alone', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'Vienna has three: palaces, cafes, music.',
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('Vienna has three: palaces, cafes, music.')
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

describe('switching brains mid-conversation', () => {
  it('replays the turns the cloud answered, then goes back to incremental', async () => {
    await brain.reply('what should I see in Vienna?', [])
    jest.clearAllMocks()

    // Two cloud turns happened: the transcript grew without the node generating.
    const afterCloud = [
      user('what should I see in Vienna?'),
      assistant('The Schönbrunn Palace.'),
      user('and after that?'),
      assistant('The Hofburg.'),
    ]

    await brain.reply('remind me where we started', afterCloud)

    expect(voiceEngine.resetConversation).toHaveBeenCalled()
    const prompt = jest.mocked(voiceEngine.generate).mock.calls[0][0]
    expect(prompt).toContain('You: The Schönbrunn Palace.')
    expect(prompt).toContain('You: The Hofburg.')

    // Caught up, so the turn after the switch costs nothing extra.
    jest.clearAllMocks()
    await brain.reply('anything else?', [
      ...afterCloud,
      user('remind me where we started'),
      assistant('reply'),
    ])
    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenCalledWith('anything else?')
  })
})

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(brain.reply('hello', [], controller.signal)).rejects.toThrow(/cancelled/i)
    expect(voiceEngine.generate).not.toHaveBeenCalled()
  })

  it('abandons the generation and keeps the next turn incremental', async () => {
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

    // The node kept the conversation and the user's message, dropping only the
    // reply — which is what the transcript holds too, so nothing needs replaying.
    await brain.reply('never mind', [user('hello')])
    expect(voiceEngine.resetConversation).not.toHaveBeenCalled()
    expect(voiceEngine.generate).toHaveBeenLastCalledWith('never mind')
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
