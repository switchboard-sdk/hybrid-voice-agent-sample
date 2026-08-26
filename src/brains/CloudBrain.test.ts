import { CloudBrain, type CloudBrainConfig } from './CloudBrain'
import { DEFAULT_SYSTEM_PROMPT, type ConversationMessage } from './types'

const user = (content: string): ConversationMessage => ({ role: 'user', content })
const assistant = (content: string): ConversationMessage => ({ role: 'assistant', content })

/** A completion, shaped the way the endpoint returns one. */
const ok = (text: string): Response =>
  ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        success: true,
        message: 'Success',
        data: { text, model: 'gpt-4o-mini-2024-07-18' },
      }),
  }) as unknown as Response

const httpError = (status: number, message?: string, retryAfter?: string): Response =>
  ({
    ok: false,
    status,
    headers: { get: (name: string) => (name === 'Retry-After' ? (retryAfter ?? null) : null) },
    json: () => Promise.resolve(message ? { success: false, message } : {}),
  }) as unknown as Response

/** An abort, shaped the way fetch reports one. */
const aborted = (): Error => {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

const makeBrain = (fetchImpl: jest.Mock, config: CloudBrainConfig = {}) =>
  new CloudBrain({
    baseUrl: 'https://example.test/chat',
    appId: 'app-test',
    appSecret: 'secret-test',
    fetchImpl,
    ...config,
  })

/** The body of the nth fetch call, decoded. */
const sentBody = (fetchImpl: jest.Mock, call = 0) =>
  JSON.parse(fetchImpl.mock.calls[call][1].body as string)

describe('reply', () => {
  it('returns the reply, the brain that answered and a timing', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('Two nights in Lisbon, then.')))

    const reply = await makeBrain(fetchImpl).reply('where to?', [])

    expect(reply.text).toBe('Two nights in Lisbon, then.')
    expect(reply.brain).toBe('cloud')
    expect(typeof reply.processingTime).toBe('number')
  })

  it('sends the persona and the transcript as messages, roles intact', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('Sure.')))

    await makeBrain(fetchImpl).reply('and after that?', [
      user('two nights in Lisbon'),
      assistant('booked'),
    ])

    const { messages } = sentBody(fetchImpl)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'two nights in Lisbon' },
      { role: 'assistant', content: 'booked' },
      { role: 'user', content: 'and after that?' },
    ])
  })

  it('caps the transcript at what the endpoint forwards, so the persona survives', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('a')))
    const long = Array.from({ length: 60 }, (_, i) => user(`turn ${i}`))

    await makeBrain(fetchImpl).reply('and now?', long)

    const { messages } = sentBody(fetchImpl)
    // system + 10 kept + this turn is the 12 the endpoint keeps, and it is the
    // tail of the history that is kept.
    expect(messages).toHaveLength(12)
    expect(messages[1].content).toBe('turn 50')
  })

  it('authenticates in the body, and asks for nothing the closed schema rejects', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('a')))

    await makeBrain(fetchImpl, { appId: 'app-abc', appSecret: 'secret-abc' }).reply('hi', [])

    const body = sentBody(fetchImpl)
    expect(body.appId).toBe('app-abc')
    expect(body.appSecret).toBe('secret-abc')
    expect(Object.keys(body).sort()).toEqual(['appId', 'appSecret', 'messages'])
  })

  it('says so plainly when there are no credentials, without calling out', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('a')))
    const brain = new CloudBrain({ fetchImpl })

    await expect(brain.reply('hi', [])).rejects.toThrow(/EXPO_PUBLIC_SWITCHBOARD_APP_ID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("surfaces the endpoint's own explanation of a failure", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(httpError(401, 'Invalid app credentials.'))

    await expect(makeBrain(fetchImpl).reply('hi', [])).rejects.toThrow(/Invalid app credentials/)
  })

  it('tells an app with no provider key from any other bad request', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(httpError(400, 'Chat is not configured for this application'))

    await expect(makeBrain(fetchImpl).reply('hi', [])).rejects.toMatchObject({
      code: 'CLOUD_NOT_CONFIGURED',
    })
  })

  it('rejects an empty reply', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('   ')))

    await expect(makeBrain(fetchImpl).reply('hi', [])).rejects.toThrow(/empty/i)
  })
})

/** A request that hangs until its signal is aborted, as a stalled one does. */
const neverReplies = (): jest.Mock =>
  jest.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(aborted()))
      })
  )

describe('retrying', () => {
  // The retry pause is real time the tests should not spend.
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('retries once after a server error, then succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(ok('second time lucky'))

    const pending = makeBrain(fetchImpl).reply('hi', [])
    await jest.advanceTimersByTimeAsync(1_000)

    expect((await pending).text).toBe('second time lucky')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries once after a timeout, then gives up', async () => {
    const fetchImpl = neverReplies()

    const pending = makeBrain(fetchImpl, { timeoutMs: 10 }).reply('hi', [])
    // Claim the rejection now: it lands while the timers are being advanced.
    pending.catch(() => {})
    await jest.advanceTimersByTimeAsync(1_000)

    await expect(pending).rejects.toThrow(/did not reply/i)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a rate limit — the endpoint counts rejected requests too', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(httpError(429, 'Rate limit reached', '12'))

    const pending = makeBrain(fetchImpl).reply('hi', [])
    pending.catch(() => {})
    await jest.advanceTimersByTimeAsync(1_000)

    await expect(pending).rejects.toThrow(/retry in 12s/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry another client error — a bad request will not fix itself', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(httpError(400))

    const pending = makeBrain(fetchImpl).reply('hi', [])
    pending.catch(() => {})
    await jest.advanceTimersByTimeAsync(1_000)

    await expect(pending).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry an empty reply', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('')))

    const pending = makeBrain(fetchImpl).reply('hi', [])
    pending.catch(() => {})
    await jest.advanceTimersByTimeAsync(1_000)

    await expect(pending).rejects.toThrow(/empty/i)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(ok('a')))
    const controller = new AbortController()
    controller.abort()

    await expect(makeBrain(fetchImpl).reply('hi', [], controller.signal)).rejects.toThrow(
      /cancelled/i
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports the caller aborting as a cancellation, and does not retry', async () => {
    const controller = new AbortController()
    // Abort while the request is in flight, the way a barge-in does.
    const fetchImpl = jest.fn(() => {
      controller.abort()
      return Promise.reject(aborted())
    })

    await expect(makeBrain(fetchImpl).reply('hi', [], controller.signal)).rejects.toThrow(
      /cancelled/i
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('passes a signal to fetch so an abandoned request is dropped', async () => {
    const fetchImpl = jest.fn((_url: string, _init: RequestInit) => Promise.resolve(ok('a')))

    await makeBrain(fetchImpl).reply('hi', [])

    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})
