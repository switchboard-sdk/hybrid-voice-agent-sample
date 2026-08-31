import {
  CLOUD_SYSTEM_PROMPT,
  brainError,
  cancelledError,
  type Brain,
  type BrainId,
  type BrainReply,
  type ConversationMessage,
} from './types'

// MARK: - Provider seam
//
// Everything down to `parseError` is specific to the API we happen to call.
// Pointing this at another provider means rewriting these functions and the two
// constants — nothing else in this file, and nothing outside it.

/**
 * Switchboard's buffered chat route, which holds the provider key server-side.
 * The app authenticates with the app ID and secret it already has, so nothing
 * worth stealing is compiled into the bundle and the cloud brain works on a
 * fresh clone with no second account.
 *
 * Which model answers is the endpoint's business, not ours — it is not named in
 * the request and can change without this file changing. Override the URL with
 * EXPO_PUBLIC_CLOUD_LLM_BASE_URL to reach the endpoint through a host of your own.
 */
const DEFAULT_BASE_URL = 'https://api.switchboard.audio/chat'

/**
 * How much of the transcript to resend. The endpoint forwards only the last 12
 * messages and silently drops whatever came before — the system prompt first —
 * so this leaves room for the persona and the turn being answered.
 */
const MAX_HISTORY_MESSAGES = 10

/** The pair that identifies the app, sent in the body rather than a header. */
interface Credentials {
  appId: string
  appSecret: string
}

function buildRequest(
  transcript: string,
  history: ConversationMessage[],
  credentials: Credentials,
  instructions: string
): object {
  // The body schema is closed: an unknown field is a 400, not an ignored key.
  // That includes a reply ceiling, which the endpoint applies itself at 200 tokens.
  // The node runs under a tighter one, since on the device the traveller waits for
  // every token generated.
  return {
    ...credentials,
    // A chat API takes the transcript as it is, so no rendering is needed: the
    // roles the app already tracks are the roles the model expects.
    messages: [
      { role: 'system', content: instructions },
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: 'user', content: transcript },
    ],
  }
}

/** Pull the reply text out of a successful response body. */
function parseReply(body: unknown): string {
  const text = (body as { data?: { text?: string } })?.data?.text?.trim()
  if (!text) {
    throw brainError('CLOUD_EMPTY_REPLY', 'The cloud model returned an empty reply')
  }
  return text
}

/** The endpoint's own explanation of a failure, which beats a bare status code. */
function parseError(body: unknown): string | undefined {
  const failure = body as { message?: string; error?: { message?: string } }
  return failure?.message ?? failure?.error?.message
}

// MARK: - Configuration

/** How long to wait for a reply before giving up on an attempt. */
const DEFAULT_TIMEOUT_MS = 15_000

/** Breathing room before the one retry, in case the failure was transient. */
const RETRY_DELAY_MS = 500

export interface CloudBrainConfig {
  baseUrl?: string
  /**
   * Required, and the same pair that starts the SDK — the endpoint takes no
   * credential of its own. Read from the environment in `src/brains/router.ts`.
   */
  appId?: string
  appSecret?: string
  timeoutMs?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * A cloud LLM as a brain.
 *
 * Holds no conversation state — the transcript is handed to it on every turn, so
 * switching to this brain mid-conversation needs nothing reset. What it does own
 * is the awkward part of talking to a network: a timeout, one retry, and giving
 * up promptly when the user interrupts.
 */
export class CloudBrain implements Brain {
  readonly id: BrainId = 'cloud'
  readonly label = 'Cloud'
  readonly requiresNetwork = true
  readonly requiresModel = false

  private readonly baseUrl: string
  private readonly appId?: string
  private readonly appSecret?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private instructions = CLOUD_SYSTEM_PROMPT

  constructor(config: CloudBrainConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.appId = config.appId
    this.appSecret = config.appSecret
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Bound, so a fetch that cares about its receiver is not called as a method
    // of this class.
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis)
  }

  /**
   * Nothing to clear — there is no cached conversation on this side. The system
   * prompt is kept, and defaults to the cloud set rather than the on-device one.
   */
  reset(instructions: string = CLOUD_SYSTEM_PROMPT): void {
    this.instructions = instructions
  }

  async reply(
    transcript: string,
    history: ConversationMessage[],
    signal?: AbortSignal
  ): Promise<BrainReply> {
    if (signal?.aborted) {
      throw cancelledError()
    }
    if (!this.appId || !this.appSecret) {
      // Defensive: `App.tsx` shows `SetupScreen` instead of the conversation
      // when either is missing, so nothing should reach this with neither.
      throw brainError(
        'CLOUD_NO_CREDENTIALS',
        'No Switchboard credentials. Set EXPO_PUBLIC_SWITCHBOARD_APP_ID and EXPO_PUBLIC_SWITCHBOARD_APP_SECRET in .env, or use the on-device brain.'
      )
    }

    const credentials = { appId: this.appId, appSecret: this.appSecret }
    const body = buildRequest(transcript, history, credentials, this.instructions)
    const startedAt = Date.now()

    try {
      return await this.attempt(body, startedAt, signal)
    } catch (error) {
      // One retry, then give up. A second attempt rides out a dropped
      // connection; a third would leave the user waiting past the point of
      // caring, and a spoken reply that late is worse than an error.
      const failure = error as Error
      if (!isRetryable(failure)) {
        throw failure
      }
      console.log(`[Cloud] ${failure.message} — retrying once`)
      await delay(RETRY_DELAY_MS, signal)
      return this.attempt(body, startedAt, signal)
    }
  }

  /** One request, timed from `startedAt` so a retry reports the full wait. */
  private async attempt(
    body: object,
    startedAt: number,
    signal?: AbortSignal
  ): Promise<BrainReply> {
    const text = parseReply(await this.post(body, signal))
    const processingTime = Date.now() - startedAt
    console.log(`[Cloud] reply in ${processingTime}ms:`, text)
    return { text, brain: this.id, processingTime }
  }

  /** One attempt, with its own timeout on top of the caller's cancellation. */
  private async post(body: object, signal?: AbortSignal): Promise<unknown> {
    // Composed by hand rather than with AbortSignal.any, which Hermes does not
    // reliably have.
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      // fetch rejects the same way for a dropped connection and for an abort, so
      // the signals are what tell them apart.
      if (signal?.aborted) {
        throw cancelledError()
      }
      if (controller.signal.aborted) {
        throw brainError(
          'CLOUD_TIMEOUT',
          `The cloud model did not reply within ${this.timeoutMs}ms`
        )
      }
      throw brainError('CLOUD_UNREACHABLE', (error as Error).message)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    const parsed = await response.json().catch(() => undefined)
    if (response.ok) {
      return parsed
    }

    const detail = parseError(parsed) ?? `HTTP ${response.status}`
    if (response.status === 429) {
      const wait = response.headers.get('Retry-After') ?? '30'
      throw brainError('CLOUD_HTTP_429', `Cloud API rate limited, retry in ${wait}s`)
    }
    // The endpoint answers a request for an app with no provider key configured
    // with a plain sentence rather than a code of its own, and it is the failure
    // a fork with its own app hits first, so it gets its own advice.
    if (response.status === 400 && /not configured/i.test(detail)) {
      throw brainError('CLOUD_NOT_CONFIGURED', detail)
    }
    throw brainError(`CLOUD_HTTP_${response.status}`, `Cloud API error: ${detail}`)
  }
}

/**
 * Worth a second attempt: the request never landed, or the far side said it was
 * busy. A 4xx is our fault — bad credentials or a malformed body — and repeating
 * it just doubles the wait. A 429 is worse than pointless: the endpoint counts
 * rejected requests too, so retrying inside the window extends it.
 */
function isRetryable(error: Error): boolean {
  const code = (error as { code?: string }).code ?? ''
  if (code === 'CLOUD_TIMEOUT' || code === 'CLOUD_UNREACHABLE') {
    return true
  }
  return Number(code.replace('CLOUD_HTTP_', '')) >= 500
}

/** Sleep, unless the user interrupts first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(cancelledError())
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort)
  })
}
