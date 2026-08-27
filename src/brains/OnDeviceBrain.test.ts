import { OnDeviceBrain } from './OnDeviceBrain'
import { voiceEngine, type LLMReply } from '../voice/VoiceEngine'
import { ON_DEVICE_REFUSAL, type ConversationMessage } from './types'

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

  it('speaks only the first sentence of a reply that came back as verse', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: [
        'The sea, a vast and mysterious shore,',
        'Where waves crash strong and the tide does roar.',
        '',
        'The sun sets low, a fiery glow,',
        'Painting the horizon with colors slow.',
      ].join('\n'),
      processingTime: 1,
    })

    const reply = await brain.reply('write me a poem about the sea', [])

    // A sentence of verse runs over several lines, so the line is the bound.
    expect(reply.text).toBe('The sea, a vast and mysterious shore,')
  })

  it('collapses a list to its first sentence', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'Three things are worth seeing.\n- The harbour\n- The market\n- The old fort',
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('Three things are worth seeing.')
  })

  it('keeps the first line when a multi-line reply never ends a sentence', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'Harbour, market, fort\nand the coast road',
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('Harbour, market, fort')
  })

  it('leaves a one-or-two-sentence reply untouched', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: "I can't check fares while offline, but the taxi rank will quote you. Ask before you set off.",
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe(
      "I can't check fares while offline, but the taxi rank will quote you. Ask before you set off."
    )
  })

  it('drops a sentence the reply was cut off mid-way through', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'Ferries leave in the early afternoon. Check the harbour board because the times can',
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('Ferries leave in the early afternoon.')
  })

  it.each([
    'Take the coastal road east.',
    'Which harbour do you mean?',
    'Ask at the airline desk!',
    'She said "take the ferry."',
  ])('leaves a reply that finished its sentence alone (%s)', async (raw) => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({ text: raw, processingTime: 1 })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe(raw)
  })

  it('keeps a cut-off reply that never reached a sentence end', async () => {
    // A fragment still beats saying nothing.
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'The ferry to Bequia usually leaves',
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('The ferry to Bequia usually leaves')
  })

  it('leaves a reply that merely contains a colon alone', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'Vienna has three: palaces, cafes, music.',
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('Vienna has three: palaces, cafes, music.')
  })

  it('forces a replay after the node drops a turn as too long', async () => {
    // The node kept neither the message nor an answer, so trusting the counter would
    // leave the model answering as though the last exchange never happened.
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'That message is too long for me to process. Could you send a shorter one?',
      processingTime: 1,
    })
    await brain.reply('a very long message', [])
    jest.clearAllMocks()

    await brain.reply('next', [user('a very long message'), assistant('too long')])

    expect(voiceEngine.resetConversation).toHaveBeenCalled()
    expect(jest.mocked(voiceEngine.generate).mock.calls[0][0]).toContain('Background')
  })

  it('caps how much of the transcript a replay resends', async () => {
    // An uncapped replay eventually cannot fit the context.
    const history = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? user(`question ${i}`) : assistant(`answer ${i}`)
    )

    await brain.reply('and now?', history)

    const prompt = jest.mocked(voiceEngine.generate).mock.calls[0][0]
    expect(prompt).not.toContain('question 0')
    expect(prompt).toContain('question 58')
    expect(prompt).toContain('and now?')
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

/**
 * A canned refusal in the node's own context is the likeliest thing for it to write
 * next, and two of them are enough to make it the answer to everything.
 */
describe('refusals', () => {
  const refuses = () =>
    jest
      .mocked(voiceEngine.generate)
      .mockResolvedValueOnce({ text: ON_DEVICE_REFUSAL, processingTime: 1 })

  const lastPrompt = () => {
    const calls = jest.mocked(voiceEngine.generate).mock.calls
    return calls[calls.length - 1][0]
  }

  it('says it a different way each time rather than repeating one sentence', async () => {
    refuses()
    const first = await brain.reply('write me a poem', [])
    refuses()
    const second = await brain.reply('tell me a joke', [
      user('write me a poem'),
      assistant(first.text),
    ])

    expect(second.text).not.toBe(first.text)
  })

  it.each([
    'I can only help with travel.',
    'I can only help with travel questions.',
    'i can only help with travel',
  ])('recognises a refusal that ran on or lost its full stop (%s)', async (raw) => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({ text: raw, processingTime: 1 })

    const reply = await brain.reply('write me a poem', [])

    // Substituted rather than passed through, which is what proves it was caught.
    expect(reply.text).toBe(ON_DEVICE_REFUSAL)
    await brain.reply('next', [user('write me a poem'), assistant(reply.text)])
    expect(voiceEngine.resetConversation).toHaveBeenCalled()
  })

  it('leaves a reply that only mentions travel help alone', async () => {
    jest.mocked(voiceEngine.generate).mockResolvedValueOnce({
      text: 'I can only help with what you have told me, so where are you headed?',
      processingTime: 1,
    })

    const reply = await brain.reply('hello', [])

    expect(reply.text).toBe('I can only help with what you have told me, so where are you headed?')
  })

  it('rebuilds the node rather than leaving the refusal in its context', async () => {
    refuses()
    await brain.reply('write me a poem', [])

    // In sync would have sent the new message alone; this replays instead.
    await brain.reply('where should I go?', [user('write me a poem'), assistant('...')])

    expect(voiceEngine.resetConversation).toHaveBeenCalled()
  })

  it('leaves the refused exchange out of what the node is replayed', async () => {
    refuses()
    const refusal = await brain.reply('write me a poem', [])

    await brain.reply('where should I go?', [
      user('is the harbour far?'),
      assistant('I cannot check that offline.'),
      user('write me a poem'),
      assistant(refusal.text),
    ])

    const prompt = lastPrompt()
    expect(prompt).toContain('Me: is the harbour far?')
    expect(prompt).not.toContain('write me a poem')
    expect(prompt).not.toContain(refusal.text)
  })

  it('replays nothing but the new message when every exchange was refused', async () => {
    refuses()
    const refusal = await brain.reply('write me a poem', [])

    await brain.reply('where should I go?', [user('write me a poem'), assistant(refusal.text)])

    expect(lastPrompt()).toBe('where should I go?')
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
