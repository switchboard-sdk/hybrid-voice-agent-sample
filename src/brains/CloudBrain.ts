import {
  DEFAULT_SYSTEM_PROMPT,
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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * Small and quick, which is what matters when the reply is about to be spoken.
 * Override with EXPO_PUBLIC_CLOUD_LLM_MODEL.
 */
const DEFAULT_MODEL = 'gpt-4o-mini'

/**
 * How much of the transcript to send. The context here is large enough for the
 * whole thing, so this is a spending limit rather than a technical one — a long
 * session would otherwise resend an ever-growing conversation every turn.
 */
const MAX_HISTORY_MESSAGES = 40

/** Enough for a couple of spoken sentences, and a ceiling on a runaway reply. */
const MAX_REPLY_TOKENS = 200

function buildRequest(
  transcript: string,
  history: ConversationMessage[],
  model: string,
  instructions: string
): object {
  return {
    model,
    // A chat API takes the transcript as it is, so no rendering is needed: the
    // roles the app already tracks are the roles the model expects.
    messages: [
      { role: 'system', content: instructions },
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: 'user', content: transcript },
    ],
    max_completion_tokens: MAX_REPLY_TOKENS,
  }
}

/** Pull the reply text out of a successful response body. */
function parseReply(body: unknown): string {
  const choice = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]
  const text = choice?.message?.content?.trim()
  if (!text) {
    throw brainError('CLOUD_EMPTY_REPLY', 'The cloud model returned an empty reply')
  }
  return text
}

/** The provider's own explanation of a failure, which beats a bare status code. */
function parseError(body: unknown): string | undefined {
  return (body as { error?: { message?: string } })?.error?.message
}

// MARK: - Configuration

/** How long to wait for a reply before giving up on an attempt. */
const DEFAULT_TIMEOUT_MS = 15_000

/** Breathing room before the one retry, in case the failure was transient. */
const RETRY_DELAY_MS = 500

export interface CloudBrainConfig {
  baseUrl?: string
  /**
   * Required. Sent as a bearer token. Read from the environment in
   * `src/brains/index.ts` — see the README on why that is demo-grade.
   */
  apiKey?: string
  model?: string
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

  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private instructions = DEFAULT_SYSTEM_PROMPT

  constructor(config: CloudBrainConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.apiKey = config.apiKey
    this.model = config.model ?? DEFAULT_MODEL
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Bound, so a fetch that cares about its receiver is not called as a method
    // of this class.
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis)
  }

  /**
   * Nothing to clear — there is no cached conversation on this side. The system
   * prompt is kept so both brains answer in the same voice.
   */
  reset(instructions: string = DEFAULT_SYSTEM_PROMPT): void {
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
    if (!this.apiKey) {
      // Said plainly, because a missing key is the likeliest reason this brain
      // does not work on a fresh clone.
      throw brainError(
        'CLOUD_NO_API_KEY',
        'No cloud API key. Set EXPO_PUBLIC_CLOUD_LLM_API_KEY in .env, or use the on-device brain.'
      )
    }

    const body = buildRequest(transcript, history, this.model, this.instructions)
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
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
    if (!response.ok) {
      const detail = parseError(parsed) ?? `HTTP ${response.status}`
      throw brainError(`CLOUD_HTTP_${response.status}`, `Cloud API error: ${detail}`)
    }
    return parsed
  }
}

/**
 * Worth a second attempt: the request never landed, or the far side said it was
 * busy. A 4xx other than 429 is our fault — a rejected key or a malformed body —
 * and repeating it just doubles the wait.
 */
function isRetryable(error: Error): boolean {
  const code = (error as { code?: string }).code ?? ''
  if (code === 'CLOUD_TIMEOUT' || code === 'CLOUD_UNREACHABLE') {
    return true
  }
  const status = Number(code.replace('CLOUD_HTTP_', ''))
  return status === 429 || status >= 500
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
