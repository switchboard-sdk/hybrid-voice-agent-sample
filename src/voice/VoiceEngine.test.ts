import { voiceEngine } from './VoiceEngine'

// Drive the real transport (SwitchboardClient → NativeModuleRPCClient) against
// the manual native mock, so this exercises JSON-RPC envelope construction,
// response parsing, the state machine, and event dispatch end-to-end in JS.
jest.mock('edgespeech-native')

const native = jest.requireMock(
  'edgespeech-native'
) as typeof import('../../__mocks__/edgespeech-native')

interface RpcCall {
  method: string
  params: any
}

/** All JSON-RPC requests sent to processCommand this test, decoded. */
function sentCalls(): RpcCall[] {
  return native.default.processCommand.mock.calls.map(([cmd]) => JSON.parse(cmd as string))
}

/** Find the callAction request whose actionName matches. */
function findAction(actionName: string): RpcCall | undefined {
  return sentCalls().find((c) => c.method === 'callAction' && c.params?.actionName === actionName)
}

beforeEach(() => {
  native.resetNativeMock()
  voiceEngine._cleanup()
  // Return an engine id for createEngine; null result for everything else.
  native.default.processCommand.mockImplementation((cmd: string) => {
    const { id, method, params } = JSON.parse(cmd)
    if (method === 'callAction' && params?.actionName === 'createEngine') {
      return JSON.stringify({ jsonrpc: '2.0', id, result: 'engine_1' })
    }
    return JSON.stringify({ jsonrpc: '2.0', id, result: null })
  })
})

describe('VoiceEngine transport', () => {
  it('initialize() surfaces a genuine failure via onError and does NOT throw', async () => {
    const errors: Array<{ code: string; message: string }> = []
    voiceEngine.addListener('onError', (e) => errors.push(e))
    native.default.processCommand.mockImplementation((cmd: string) => {
      const { id, params } = JSON.parse(cmd)
      if (params?.actionName === 'initialize') {
        return JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'bad credentials' },
        })
      }
      return JSON.stringify({ jsonrpc: '2.0', id, result: null })
    })

    expect(() => voiceEngine.initialize('app-id', 'app-secret')).not.toThrow()
    expect(errors).toEqual([{ code: 'INIT_FAILED', message: 'bad credentials' }])
    // Stayed uninitialized, so a later action rejects rather than proceeding.
    await expect(voiceEngine.listen()).rejects.toThrow(/not initialized/i)
  })

  it('initialize() treats "already been initialized" as success (reload case)', async () => {
    const errors: unknown[] = []
    voiceEngine.addListener('onError', (e) => errors.push(e))
    native.default.processCommand.mockImplementation((cmd: string) => {
      const { id, params } = JSON.parse(cmd)
      if (params?.actionName === 'initialize') {
        return JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'SwitchboardSDK has already been initialized.' },
        })
      }
      if (params?.actionName === 'createEngine') {
        return JSON.stringify({ jsonrpc: '2.0', id, result: 'engine_1' })
      }
      return JSON.stringify({ jsonrpc: '2.0', id, result: null })
    })

    expect(() => voiceEngine.initialize('app-id', 'app-secret')).not.toThrow()
    expect(errors).toEqual([]) // not surfaced as an error
    await expect(voiceEngine.listen()).resolves.toBeUndefined() // initialized → proceeds
  })

  it('listen() creates the engine (bare-name nodes), enables AEC, then starts', async () => {
    voiceEngine.initialize('app-id', 'app-secret')
    const states: string[] = []
    voiceEngine.addListener('onStateChange', ({ state }) => states.push(state))

    await voiceEngine.listen()

    expect(findAction('createEngine')).toBeDefined()
    // voiceProcessingEnabled set on the returned engine id
    const setVal = sentCalls().find((c) => c.method === 'setValue')
    expect(setVal!.params).toEqual({
      objectURI: 'engine_1',
      key: 'voiceProcessingEnabled',
      value: true,
    })
    const start = sentCalls().find(
      (c) => c.method === 'callAction' && c.params.actionName === 'start'
    )
    expect(start!.params.objectURI).toBe('engine_1')
    expect(states).toContain('listening')
  })

  it('speak() synthesizes on ttsNode and moves to speaking', async () => {
    voiceEngine.initialize('app-id', 'app-secret')
    const states: string[] = []
    voiceEngine.addListener('onStateChange', ({ state }) => states.push(state))

    await voiceEngine.speak('hello world')

    const synth = findAction('synthesize')
    expect(synth!.params.objectURI).toBe('ttsNode')
    expect(synth!.params.params).toEqual({ text: 'hello world' })
    expect(states[states.length - 1]).toBe('speaking')
  })

  it('emits onTranscript once the hold expires with no more speech', () => {
    jest.useFakeTimers()
    voiceEngine.initialize('app-id', 'app-secret')
    const transcripts: Array<{ text: string; isFinal: boolean }> = []
    voiceEngine.addListener('onTranscript', (e) => transcripts.push(e))

    native.emit(JSON.stringify({ objectURI: 'sttNode', name: 'transcribed', data: { text: 'hi' } }))
    expect(transcripts).toEqual([])

    jest.advanceTimersByTime(350)
    expect(transcripts).toEqual([{ text: 'hi', isFinal: true }])
    jest.useRealTimers()
  })

  it('barge-in: a transcript during TTS stops speaking, interrupts, then transcribes', async () => {
    voiceEngine.initialize('app-id', 'app-secret')
    const events: string[] = []
    voiceEngine.addListener('onInterrupted', () => events.push('interrupted'))
    voiceEngine.addListener('onStateChange', ({ state }) => events.push(`state:${state}`))
    voiceEngine.addListener('onTranscript', ({ text }) => events.push(`transcript:${text}`))
    // The hold is endpointing, not barge-in — this is about the order of the three.
    voiceEngine.configure({ turnHoldMs: 0 })

    await voiceEngine.speak('a long answer')
    // speak() lazily starts the engine (→ listening) then synthesizes (→ speaking);
    // clear those setup events so we assert only the barge-in sequence.
    events.length = 0
    native.default.processCommand.mockClear()

    native.emit(
      JSON.stringify({ objectURI: 'sttNode', name: 'transcribed', data: { text: 'stop' } })
    )

    // TTS was told to stop, and the barge-in sequence fired in order.
    expect(findAction('stop')?.params.objectURI).toBe('ttsNode')
    expect(events).toEqual(['state:listening', 'interrupted', 'transcript:stop'])
  })

  it('configure() clamps vadSensitivity into [0,1] and feeds the graph', async () => {
    voiceEngine.initialize('app-id', 'app-secret')
    voiceEngine.configure({ vadSensitivity: 5 })
    await voiceEngine.listen()

    const create = findAction('createEngine')!
    const vadNode = create.params.params.config.graph.nodes.find((n: any) => n.id === 'vadNode')
    expect(vadNode.config.threshold).toBe(1)
  })

  it('configure() feeds vadSilenceMs to the VAD node', async () => {
    voiceEngine.initialize('app-id', 'app-secret')
    voiceEngine.configure({ vadSilenceMs: 800 })
    await voiceEngine.listen()

    const create = findAction('createEngine')!
    const vadNode = create.params.params.config.graph.nodes.find((n: any) => n.id === 'vadNode')
    expect(vadNode.config.minSilenceDurationMs).toBe(800)
  })

  it('useGPU follows !isSimulator in the built graph', async () => {
    native.default.isSimulator.mockReturnValue(true)
    voiceEngine.initialize('app-id', 'app-secret')
    await voiceEngine.listen()

    const create = findAction('createEngine')!
    const sttNode = create.params.params.config.graph.nodes.find((n: any) => n.id === 'sttNode')
    expect(sttNode.config.useGPU).toBe(false)
  })
})

/**
 * The VAD ends an utterance on silence alone, so a pause to think arrives as its own
 * transcript. These cover the hold that puts the two halves back together.
 */
describe('holding a transcript before it becomes a turn', () => {
  const transcribed = (text: string) =>
    native.emit(JSON.stringify({ objectURI: 'sttNode', name: 'transcribed', data: { text } }))
  const speechStarted = () =>
    native.emit(JSON.stringify({ objectURI: 'vadNode', name: 'speechStarted' }))

  /** Collect the turns that reach a listener, and start the engine. */
  function turns(): string[] {
    const seen: string[] = []
    voiceEngine.initialize('app-id', 'app-secret')
    voiceEngine.addListener('onTranscript', ({ text }) => seen.push(text))
    return seen
  }

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('joins speech that resumes inside the hold into one turn', () => {
    const seen = turns()

    transcribed('What was the best thing')
    jest.advanceTimersByTime(200)
    speechStarted()
    jest.advanceTimersByTime(600)
    transcribed('to visit in Budapest?')
    jest.advanceTimersByTime(350)

    expect(seen).toEqual(['What was the best thing to visit in Budapest?'])
  })

  it('keeps an opening word that decoded on its own', () => {
    const seen = turns()

    transcribed('What')
    speechStarted()
    transcribed('was the best thing to visit in Budapest?')
    jest.advanceTimersByTime(350)

    expect(seen).toEqual(['What was the best thing to visit in Budapest?'])
  })

  it('starts a second turn when the next utterance lands after the hold', () => {
    const seen = turns()

    transcribed('Where should I eat?')
    jest.advanceTimersByTime(350)
    transcribed('And what about tomorrow?')
    jest.advanceTimersByTime(350)

    expect(seen).toEqual(['Where should I eat?', 'And what about tomorrow?'])
  })

  it('commits held words when the speech that paused the hold never decodes', () => {
    const seen = turns()

    transcribed('Where should I eat?')
    speechStarted()
    jest.advanceTimersByTime(15_000)

    expect(seen).toEqual(['Where should I eat?'])
  })

  it('passes an empty transcript through rather than waiting on it', () => {
    const seen = turns()

    transcribed('')

    expect(seen).toEqual([''])
  })

  it('commits immediately at turnHoldMs 0', () => {
    const seen = turns()
    voiceEngine.configure({ turnHoldMs: 0 })

    transcribed('Where should I eat?')

    expect(seen).toEqual(['Where should I eat?'])
  })

  it('drops a held transcript when the session ends', async () => {
    const seen = turns()
    await voiceEngine.listen()

    transcribed('Where should I eat?')
    await voiceEngine.stopListening()
    jest.advanceTimersByTime(15_000)

    expect(seen).toEqual([])
  })
})

/** Stands in for the model the app downloads on first launch. */
const MODEL_PATH = '/var/mobile/Documents/Llama-3.2-1B-Instruct-Q4_0.gguf'

describe('on-device language model', () => {
  // Without this there is no model on the phone, which the last two tests here
  // cover — every other one assumes the download has happened.
  beforeEach(() => {
    voiceEngine.configure({ llmModelPath: MODEL_PATH })
  })

  it('registers the LlamaCpp extension on initialize', () => {
    voiceEngine.initialize('id', 'secret')

    const init = sentCalls().find((c) => c.params?.actionName === 'initialize')
    expect(init!.params.params.extensions).toHaveProperty('LlamaCpp')
  })

  it('adds an llmNode to the graph with no audio connections', async () => {
    voiceEngine.initialize('id', 'secret')
    await voiceEngine.listen()

    const graph = findAction('createEngine')!.params.params.config.graph
    const llm = graph.nodes.find((n: any) => n.id === 'llmNode')
    expect(llm.type).toBe('LlamaCpp.LLM')
    expect(llm.config.modelPath).toBe(MODEL_PATH)
    expect(graph.connections.some((c: any) => JSON.stringify(c).includes('llmNode'))).toBe(false)
  })

  it('leaves the reply ceiling and the seed out of the graph unless they are set', async () => {
    // An older node logs an unknown config key as an error, and a fixed seed would
    // make a demo answer the same way every time.
    voiceEngine.initialize('id', 'secret')
    await voiceEngine.listen()

    const graph = findAction('createEngine')!.params.params.config.graph
    const llm = graph.nodes.find((n: any) => n.id === 'llmNode')
    expect(llm.config).not.toHaveProperty('maxTokens')
    expect(llm.config).not.toHaveProperty('seed')
  })

  it('passes a configured reply ceiling and seed to the node', async () => {
    voiceEngine.initialize('id', 'secret')
    voiceEngine.configure({ llmMaxTokens: 120, llmSeed: 7 })
    await voiceEngine.listen()

    const graph = findAction('createEngine')!.params.params.config.graph
    const llm = graph.nodes.find((n: any) => n.id === 'llmNode')
    expect(llm.config.maxTokens).toBe(120)
    expect(llm.config.seed).toBe(7)
  })

  it('generate() prompts the node and resolves on responseReceived', async () => {
    voiceEngine.initialize('id', 'secret')
    const pending = voiceEngine.generate('how are you?')

    const prompt = findAction('prompt')
    expect(prompt!.params.objectURI).toBe('llmNode')
    expect(prompt!.params.params.text).toBe('how are you?')

    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: '  Doing well.  ', processingTime: 1234 },
      })
    )

    await expect(pending).resolves.toEqual({ text: 'Doing well.', processingTime: 1234 })
  })

  it('reports processing state while generating', async () => {
    voiceEngine.initialize('id', 'secret')
    const states: string[] = []
    voiceEngine.addListener('onStateChange', ({ state }) => states.push(state))

    const pending = voiceEngine.generate('hello')
    expect(states).toContain('processing')

    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: 'hi', processingTime: 1 },
      })
    )
    await pending
  })

  it('rejects an empty prompt', async () => {
    voiceEngine.initialize('id', 'secret')
    await expect(voiceEngine.generate('   ')).rejects.toThrow(/empty/i)
  })

  it('rejects a second generation while one is in flight', async () => {
    voiceEngine.initialize('id', 'secret')
    const first = voiceEngine.generate('one')

    await expect(voiceEngine.generate('two')).rejects.toThrow(/already being generated/i)

    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: 'done', processingTime: 1 },
      })
    )
    await first
  })

  it('resetConversation writes the instructions property', async () => {
    voiceEngine.initialize('id', 'secret')
    await voiceEngine.listen()

    voiceEngine.resetConversation('be terse')

    const set = sentCalls().find((c) => c.method === 'setValue' && c.params?.key === 'instructions')
    expect(set!.params.objectURI).toBe('llmNode')
    expect(set!.params.value).toBe('be terse')
  })
  it('cancelGeneration() tells the node to stop and rejects the pending reply', async () => {
    voiceEngine.initialize('id', 'secret')
    const pending = voiceEngine.generate('hello')

    voiceEngine.cancelGeneration()

    expect(findAction('cancel')?.params.objectURI).toBe('llmNode')
    await expect(pending).rejects.toThrow(/cancelled/i)
  })

  it('frees the slot, so the next turn is not blocked', async () => {
    voiceEngine.initialize('id', 'secret')
    const pending = voiceEngine.generate('hello')
    pending.catch(() => {})
    voiceEngine.cancelGeneration()

    const next = voiceEngine.generate('again')
    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: 'current', processingTime: 2 },
      })
    )

    await expect(next).resolves.toMatchObject({ text: 'current' })
  })

  it('emits onGenerationCancelled when the node confirms it dropped the reply', () => {
    voiceEngine.initialize('id', 'secret')
    let confirmations = 0
    voiceEngine.addListener('onGenerationCancelled', () => (confirmations += 1))

    native.emit(JSON.stringify({ objectURI: 'llmNode', name: 'generationCancelled' }))

    expect(confirmations).toBe(1)
  })

  it('a late confirmation does not disturb a generation that has already started', async () => {
    voiceEngine.initialize('id', 'secret')
    const pending = voiceEngine.generate('hello')
    pending.catch(() => {})
    voiceEngine.cancelGeneration()

    const next = voiceEngine.generate('again')
    // The node's confirmation for the cancelled turn arrives after the new prompt.
    native.emit(JSON.stringify({ objectURI: 'llmNode', name: 'generationCancelled' }))
    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: 'current', processingTime: 1 },
      })
    )

    await expect(next).resolves.toMatchObject({ text: 'current' })
  })

  it('resetConversation settles a pending reply instead of leaving it hanging', async () => {
    voiceEngine.initialize('id', 'secret')
    await voiceEngine.listen()
    const pending = voiceEngine.generate('hello')

    // Writing instructions makes the node abandon the generation, so the caller
    // must not be left waiting out the timeout for a reply that never comes.
    voiceEngine.resetConversation('be brief')

    await expect(pending).rejects.toThrow(/cancelled/i)
  })

  it('cancelGeneration() is a no-op when nothing is generating', () => {
    voiceEngine.initialize('id', 'secret')

    expect(() => voiceEngine.cancelGeneration()).not.toThrow()
    expect(findAction('cancel')).toBeUndefined()
  })

  it('gives up in seconds when not even a first token arrives', async () => {
    // Nothing distinguishes an abandoned turn from a slow one except silence.
    jest.useFakeTimers()
    voiceEngine.initialize('id', 'secret')

    const pending = voiceEngine.generate('hello')
    pending.catch(() => {})
    jest.advanceTimersByTime(8_000)
    await expect(pending).rejects.toThrow(/produced nothing/i)

    jest.useRealTimers()
    const next = voiceEngine.generate('again')
    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: 'ok', processingTime: 1 },
      })
    )
    await expect(next).resolves.toMatchObject({ text: 'ok' })
  })

  it('asks the node to cancel the turn it gave up on', () => {
    jest.useFakeTimers()
    voiceEngine.initialize('id', 'secret')

    const pending = voiceEngine.generate('hello')
    pending.catch(() => {})
    jest.advanceTimersByTime(8_000)

    expect(findAction('cancel')).toBeDefined()
    jest.useRealTimers()
  })

  it('a first token buys the reply the full budget', async () => {
    jest.useFakeTimers()
    voiceEngine.initialize('id', 'secret')

    const pending = voiceEngine.generate('write me something long')
    pending.catch(() => {})
    native.emit(
      JSON.stringify({ objectURI: 'llmNode', name: 'tokenReceived', data: { text: 'The' } })
    )

    // Well past the first-token watchdog, nowhere near the full timeout.
    jest.advanceTimersByTime(30_000)
    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: 'a long reply', processingTime: 30_000 },
      })
    )

    await expect(pending).resolves.toMatchObject({ text: 'a long reply' })
    jest.useRealTimers()
  })

  it('still times out a generation that starts and never ends', async () => {
    jest.useFakeTimers()
    voiceEngine.initialize('id', 'secret')

    const pending = voiceEngine.generate('hello')
    pending.catch(() => {})
    native.emit(
      JSON.stringify({ objectURI: 'llmNode', name: 'tokenReceived', data: { text: 'The' } })
    )
    jest.advanceTimersByTime(60_000)

    await expect(pending).rejects.toThrow(/did not reply in time/i)
    jest.useRealTimers()
  })

  it('a reply that arrives after its caller gave up leaves the state machine alone', async () => {
    // A later turn may be speaking by now, and putting it back to 'listening'
    // would be a lie on screen.
    jest.useFakeTimers()
    voiceEngine.initialize('id', 'secret')
    const pending = voiceEngine.generate('hello')
    pending.catch(() => {})
    jest.advanceTimersByTime(8_000)
    await expect(pending).rejects.toThrow(/produced nothing/i)
    jest.useRealTimers()

    const states: string[] = []
    voiceEngine.addListener('onStateChange', ({ state }) => states.push(state))
    native.emit(
      JSON.stringify({
        objectURI: 'llmNode',
        name: 'responseReceived',
        data: { text: 'too late', processingTime: 1 },
      })
    )

    expect(states).toEqual([])
  })

  it('leaves the node out of the graph when there is no model on the phone', async () => {
    // The node would construct, load nothing, and then abandon every turn without
    // an error event. Speech in and out is untouched, so the cloud brain still works.
    voiceEngine.configure({ llmModelPath: '' })
    voiceEngine.initialize('id', 'secret')
    await voiceEngine.listen()

    const graph = findAction('createEngine')!.params.params.config.graph
    expect(graph.nodes.some((n: any) => n.id === 'llmNode')).toBe(false)
    expect(graph.nodes.some((n: any) => n.id === 'sttNode')).toBe(true)
    expect(graph.nodes.some((n: any) => n.id === 'ttsNode')).toBe(true)
  })

  it('generate() says there is no model rather than prompting a node that is not there', async () => {
    voiceEngine.configure({ llmModelPath: '' })
    voiceEngine.initialize('id', 'secret')

    await expect(voiceEngine.generate('hello')).rejects.toMatchObject({
      code: 'MODEL_NOT_AVAILABLE',
    })
    expect(findAction('prompt')).toBeUndefined()
  })
})

describe('speech synthesis', () => {
  it('gives up on a synthesis that never reports finishing', async () => {
    jest.useFakeTimers()
    voiceEngine.initialize('id', 'secret')
    await voiceEngine.listen()

    const errors: string[] = []
    voiceEngine.addListener('onError', ({ code }) => errors.push(code))
    const states: string[] = []
    voiceEngine.addListener('onStateChange', ({ state }) => states.push(state))

    await voiceEngine.speak('hello')
    jest.advanceTimersByTime(30_000)

    expect(errors).toContain('TTS_TIMEOUT')
    // Not stuck in 'speaking', where the next utterance reads as barge-in.
    expect(states[states.length - 1]).toBe('listening')
    jest.useRealTimers()
  })

  it('does not fire once the synthesis has finished', async () => {
    jest.useFakeTimers()
    voiceEngine.initialize('id', 'secret')
    await voiceEngine.listen()

    const errors: string[] = []
    voiceEngine.addListener('onError', ({ code }) => errors.push(code))

    await voiceEngine.speak('hello')
    native.emit(JSON.stringify({ objectURI: 'ttsNode', name: 'finished' }))
    jest.advanceTimersByTime(30_000)

    expect(errors).toEqual([])
    jest.useRealTimers()
  })
})
