import NativeEdgeSpeech from 'edgespeech-native'
import { NativeModuleRPCClient } from './NativeModuleRPCClient'
import { SwitchboardClient } from './SwitchboardClient'
import type { VoiceState, TranscriptEvent, StateChangeEvent, ErrorEvent } from './types'

/**
 * Payload shape for each public event name. Drives the typing of
 * {@link VoiceEngine.addListener} so consumers get checked callbacks.
 */
export interface EdgeSpeechEventMap {
  onTranscript: TranscriptEvent
  onStateChange: StateChangeEvent
  onError: ErrorEvent
  onSpeechStart: undefined
  onSpeechEnd: undefined
  onInterrupted: undefined
  onTTSComplete: undefined
  onLLMResponse: LLMReply
  onGenerationCancelled: undefined
}

export type EdgeSpeechEventName = keyof EdgeSpeechEventMap

/** A completed on-device generation. */
export interface LLMReply {
  text: string
  /** Milliseconds the node spent on this turn, as reported by the SDK. */
  processingTime: number
}

type Listener = (payload: unknown) => void

/**
 * Extensions the SDK must initialize. ONNX underpins Silero VAD. The key is
 * `Silero`, the name the C++ SileroVADExtension registers — not `SileroVAD`, which
 * the Objective-C extension answers to and this does not use.
 */
const EXTENSIONS = { Onnx: {}, Silero: {}, Whisper: {}, Sherpa: {}, LlamaCpp: {} }

// Empty means there is no on-device model on the phone: the weights are fetched
// on first launch (see `src/model`) and stripped out of the framework, so nothing
// is bundled to fall back on. Without a path the LLM node is left out of the graph
// altogether and generate() says so, rather than the node loading nothing and
// abandoning every turn in silence.
const DEFAULT_LLM_MODEL = ''

const GENERATE_TIMEOUT_MS = 60_000

/**
 * How long to wait for the model's first token. The node abandons a turn silently —
 * no model loaded, or a prompt it could not measure, template, tokenise or decode —
 * and has no error event to send, so a first token is the only proof it is running.
 * Once one arrives the reply keeps the full budget above.
 */
const FIRST_TOKEN_TIMEOUT_MS = 8_000

/**
 * How long a synthesised reply may take before the engine is assumed stuck. Without
 * it, a `finished` event that never arrives leaves the state machine in 'speaking'
 * and the next utterance is read as barge-in. A backstop, not a deadline.
 */
const SPEAK_TIMEOUT_MS = 30_000

/**
 * The two ends of the endpointing budget, and the only defence against a pause
 * mid-sentence being read as the end of a turn — the VAD scores frames of audio and
 * knows nothing of what was said. Together they are what the traveller waits after
 * falling silent, so raising either buys fewer split turns at the cost of a slower
 * reply.
 */
const DEFAULT_VAD_SILENCE_MS = 500
const DEFAULT_TURN_HOLD_MS = 350

/**
 * Ceiling on a transcript waiting for the rest of its sentence, in ms. It waits for
 * the speech that is under way to be transcribed so the two can be joined; if that
 * never arrives — a cough, a door, anything the VAD hears and Whisper does not —
 * this lets through what is already there rather than stranding the turn.
 */
const HELD_TURN_BACKSTOP_MS = 15_000

interface VoiceEngineConfig {
  vadSensitivity: number
  /**
   * Silence that ends an utterance, in ms. The VAD hears silence and nothing else,
   * so this is the whole of what tells a pause to think from the end of a sentence:
   * too short splits a sentence in two, too long makes every reply wait.
   */
  vadSilenceMs: number
  /**
   * Further silence held after the VAD's own, in ms, before Whisper is asked for
   * the utterance. Speech starting again inside the window cancels the call, so the
   * rest of the sentence is decoded along with it rather than separately. 0 asks as
   * soon as the VAD reports the utterance over, and so never joins anything.
   */
  turnHoldMs: number
  sampleRate: number
  bufferSize: number
  ttsVoice: string
  llmModelPath: string
  llmContextSize: number
  llmTemperature: number
  /**
   * Ceiling on one reply, in tokens. 0 means unlimited and is not sent, since a node
   * without the setting logs it as an unknown config key.
   */
  llmMaxTokens: number
  /**
   * Fixed sampling seed, so the same prompt comes back with the same reply. `null`
   * leaves it random, which is what a demo wants; set it to compare two prompts.
   */
  llmSeed: number | null
  llmInstructions: string
}

/**
 * The on-device voice pipeline, authored entirely in TypeScript over the
 * Switchboard JSON-RPC channel: it builds the combined VAD → STT + TTS graph,
 * creates the engine, runs the idle/listening/speaking state machine, handles
 * barge-in, and translates raw SDK events into EdgeSpeech's public events.
 *
 * A single combined engine (microphone + speaker) keeps VoiceProcessingIO (AEC)
 * active during TTS playback, which is what makes barge-in reliable.
 */
class VoiceEngine {
  private client: SwitchboardClient | null = null
  private engineId: string | null = null
  private isInitialized = false
  private isListening = false
  private isSpeaking = false
  private eventsWired = false

  private config: VoiceEngineConfig = {
    vadSensitivity: 0.5,
    vadSilenceMs: DEFAULT_VAD_SILENCE_MS,
    turnHoldMs: DEFAULT_TURN_HOLD_MS,
    sampleRate: 16000,
    bufferSize: 512,
    ttsVoice: 'en_GB',
    llmModelPath: DEFAULT_LLM_MODEL,
    llmContextSize: 4096,
    llmTemperature: 0.8,
    llmMaxTokens: 0,
    llmSeed: null,
    llmInstructions: '',
  }

  private readonly listeners = new Map<EdgeSpeechEventName, Set<Listener>>()

  /** Resolver for the generate() call currently awaiting `responseReceived`. */
  private pendingGeneration: {
    resolve: (reply: LLMReply) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    firstTokenTimer: ReturnType<typeof setTimeout> | null
  } | null = null

  /** Backstop for a synthesis that never reports finishing. */
  private speakTimer: ReturnType<typeof setTimeout> | null = null

  /** Whisper call held back while the sentence may still be going. */
  private transcribeTimer: ReturnType<typeof setTimeout> | null = null

  /** A transcript waiting to see whether the traveller had only paused. */
  private pendingTurn: { text: string; timer: ReturnType<typeof setTimeout> } | null = null

  /**
   * Whether the VAD is hearing speech right now. A transcript arrives well after the
   * silence that ended it — Whisper has to decode first — so by the time one lands
   * the traveller may already be a word into the rest of the sentence.
   */
  private speechActive = false

  // MARK: - Public listener API

  addListener<K extends EdgeSpeechEventName>(
    event: K,
    listener: (payload: EdgeSpeechEventMap[K]) => void
  ): { remove: () => void } {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener)
    return {
      remove: () => {
        this.listeners.get(event)?.delete(listener as Listener)
      },
    }
  }

  // MARK: - Lifecycle

  initialize(appId: string, appSecret: string): void {
    if (this.isInitialized) {
      return
    }
    const client = this.ensureClient()
    this.wireEvents()

    const res = client.callAction('switchboard', 'initialize', {
      appID: appId,
      appSecret,
      extensions: EXTENSIONS,
    })
    if (res.error) {
      const message = res.error.message ?? ''
      // The native SDK is a process-global singleton that survives JS bundle
      // reloads (Fast Refresh / dev reopen); a repeat initialize then reports
      // "already been initialized". Treat that as success so the app doesn't
      // red-box on reload.
      // NOTE (stopgap): matching on the error text is brittle — a stable error
      // code or an SDK init-state query would be more robust.
      if (/already.*initialized/i.test(message)) {
        this.isInitialized = true
        return
      }
      // Surface genuine failures via onError and stay uninitialized (a later
      // listen()/speak() then rejects NOT_INITIALIZED). Don't throw:
      // EdgeSpeechProvider calls initialize() inside an effect, so throwing would
      // red-box the app instead of firing onError — matches the original module.
      this.emitError('INIT_FAILED', message)
      return
    }
    this.isInitialized = true
  }

  configure(config: Record<string, unknown>): void {
    if (typeof config.vadSensitivity === 'number') {
      this.config.vadSensitivity = Math.max(0, Math.min(1, config.vadSensitivity))
    }
    if (typeof config.vadSilenceMs === 'number') {
      this.config.vadSilenceMs = Math.max(0, config.vadSilenceMs)
    }
    if (typeof config.turnHoldMs === 'number') {
      this.config.turnHoldMs = Math.max(0, config.turnHoldMs)
    }
    if (typeof config.sampleRate === 'number') {
      this.config.sampleRate = config.sampleRate
    }
    if (typeof config.bufferSize === 'number') {
      this.config.bufferSize = config.bufferSize
    }
    if (typeof config.ttsVoice === 'string') {
      this.config.ttsVoice = config.ttsVoice
    }
    if (typeof config.llmModelPath === 'string') {
      this.config.llmModelPath = config.llmModelPath
    }
    if (typeof config.llmContextSize === 'number') {
      this.config.llmContextSize = config.llmContextSize
    }
    if (typeof config.llmTemperature === 'number') {
      this.config.llmTemperature = config.llmTemperature
    }
    if (typeof config.llmMaxTokens === 'number') {
      this.config.llmMaxTokens = config.llmMaxTokens
    }
    if (typeof config.llmSeed === 'number') {
      this.config.llmSeed = config.llmSeed
    }
    if (typeof config.llmInstructions === 'string') {
      this.config.llmInstructions = config.llmInstructions
    }
  }

  // MARK: - On-device language model

  /** Prompt the on-device model and resolve with its reply. */
  async generate(text: string): Promise<LLMReply> {
    if (!this.isInitialized) {
      throw this.makeError(
        'NOT_INITIALIZED',
        'Switchboard SDK not initialized. Call initialize() first.'
      )
    }
    if (!text.trim()) {
      throw this.makeError('EMPTY_PROMPT', 'Prompt text cannot be empty')
    }
    if (!this.config.llmModelPath) {
      throw this.makeError(
        'MODEL_NOT_AVAILABLE',
        'There is no on-device model on this phone, so the graph has no language-model node.'
      )
    }
    if (!this.engineId) {
      this.createEngine()
    }
    if (this.pendingGeneration) {
      throw this.makeError('GENERATION_IN_PROGRESS', 'A reply is already being generated')
    }

    this.setState('processing')

    return new Promise<LLMReply>((resolve, reject) => {
      // A failed generation is silent, so without this the slot never clears.
      const timer = setTimeout(() => {
        this.settleGeneration()
        reject(this.makeError('GENERATE_TIMEOUT', 'The on-device model did not reply in time'))
      }, GENERATE_TIMEOUT_MS)

      // Cancel on the way out, so a late reply cannot land on an abandoned turn.
      const firstTokenTimer = setTimeout(() => {
        this.settleGeneration()
        this.ensureClient().callAction('llmNode', 'cancel', {})
        reject(
          this.makeError(
            'MODEL_NOT_RESPONDING',
            'The on-device model produced nothing. It may have failed to load.'
          )
        )
      }, FIRST_TOKEN_TIMEOUT_MS)

      this.pendingGeneration = { resolve, reject, timer, firstTokenTimer }

      const res = this.ensureClient().callAction('llmNode', 'prompt', { text })
      if (res.error) {
        this.settleGeneration()
        reject(this.makeError('GENERATE_FAILED', res.error.message))
      }
    })
  }

  /**
   * Stop the in-flight generation, if any, so a new one can start.
   *
   * The node stops within a token and keeps the conversation, dropping only the
   * reply it was building — so no resynchronising is needed afterwards. Safe to
   * call when nothing is pending.
   *
   * Rejects the caller straight away rather than waiting for the node to confirm:
   * whoever cancelled has already moved on. If the reply happened to land in the
   * same moment, the cancel is a no-op on the node and it keeps a reply this app
   * never showed — a turn of drift in the model's context, nothing more.
   */
  cancelGeneration(): void {
    const pending = this.pendingGeneration
    if (!pending) {
      return
    }
    const res = this.ensureClient().callAction('llmNode', 'cancel', {})
    if (res.error) {
      // Not fatal: the caller is freed either way. But the node then finishes the
      // reply it was asked to drop and keeps it, so say so rather than let the
      // conversation quietly drift.
      console.warn('[LLM] the node refused to cancel:', res.error.message)
    }
    this.settleGeneration()
    pending.reject(this.makeError('GENERATION_CANCELLED', 'The reply was cancelled'))
  }

  /** Clear the in-flight generation and return to a resting state. */
  private settleGeneration(): void {
    const pending = this.pendingGeneration
    if (!pending) {
      // A reply that arrived after its caller gave up. Leave the state machine
      // alone: a later turn may be speaking by now, and putting it back to
      // 'listening' would be false on screen.
      return
    }
    clearTimeout(pending.timer)
    if (pending.firstTokenTimer) {
      clearTimeout(pending.firstTokenTimer)
    }
    this.pendingGeneration = null
    this.setState(this.isListening ? 'listening' : 'idle')
  }

  /** Called on the first token: only the full-reply budget applies from here. */
  private clearFirstTokenTimer(): void {
    const pending = this.pendingGeneration
    if (!pending?.firstTokenTimer) {
      return
    }
    clearTimeout(pending.firstTokenTimer)
    pending.firstTokenTimer = null
  }

  /** Start the backstop for a synthesis that never reports finishing. */
  private armSpeakWatchdog(): void {
    this.clearSpeakWatchdog()
    this.speakTimer = setTimeout(() => {
      this.speakTimer = null
      if (!this.isSpeaking) {
        return
      }
      this.isSpeaking = false
      this.setState(this.isListening ? 'listening' : 'idle')
      this.emitError('TTS_TIMEOUT', 'The synthesised reply never finished playing')
    }, SPEAK_TIMEOUT_MS)
  }

  private clearSpeakWatchdog(): void {
    if (this.speakTimer) {
      clearTimeout(this.speakTimer)
      this.speakTimer = null
    }
  }

  /**
   * Clear the node's conversation and set the system prompt.
   *
   * Writing `instructions` makes the node abandon whatever it is generating, so
   * settle the caller first — otherwise it waits out the full timeout for a reply
   * that is never coming.
   */
  resetConversation(instructions?: string): void {
    if (instructions !== undefined) {
      this.config.llmInstructions = instructions
    }
    // No node to write to without a model, and the instructions are kept above so
    // a later graph is built with them.
    if (!this.engineId || !this.config.llmModelPath) {
      return
    }
    this.cancelGeneration()
    this.ensureClient().setValue('llmNode', 'instructions', this.config.llmInstructions)
  }

  // MARK: - Control

  async listen(): Promise<void> {
    if (!this.isInitialized) {
      throw this.makeError(
        'NOT_INITIALIZED',
        'Switchboard SDK not initialized. Call initialize() first.'
      )
    }
    if (!this.engineId) {
      this.createEngine()
    }
    if (this.isListening) {
      return
    }
    const res = this.ensureClient().callAction(this.engineId!, 'start', {})
    if (res.error) {
      throw this.makeError('LISTEN_FAILED', res.error.message)
    }
    this.isListening = true
    this.setState('listening')
  }

  async stopListening(): Promise<void> {
    if (!this.engineId || !this.isListening) {
      return
    }
    const res = this.ensureClient().callAction(this.engineId, 'stop', {})
    if (res.error) {
      throw this.makeError('STOP_LISTENING_FAILED', res.error.message)
    }
    this.isListening = false
    this.isSpeaking = false
    this.speechActive = false
    this.clearPendingTurn()
    this.clearTranscribeTimer()
    this.setState('idle')
  }

  async speak(text: string): Promise<void> {
    if (!this.isInitialized) {
      throw this.makeError(
        'NOT_INITIALIZED',
        'Switchboard SDK not initialized. Call initialize() first.'
      )
    }
    if (!text) {
      return
    }
    if (!this.engineId) {
      this.createEngine()
    }
    // Starting the engine also activates the mic + AEC needed for barge-in.
    if (!this.isListening) {
      const startRes = this.ensureClient().callAction(this.engineId!, 'start', {})
      if (startRes.error) {
        throw this.makeError('LISTEN_FAILED', startRes.error.message)
      }
      this.isListening = true
      this.setState('listening')
    }

    const res = this.ensureClient().callAction('ttsNode', 'synthesize', { text })
    if (res.error) {
      throw this.makeError('SPEAK_FAILED', res.error.message)
    }
    this.isSpeaking = true
    this.armSpeakWatchdog()
    this.setState('speaking')
  }

  async stopSpeaking(): Promise<void> {
    if (!this.isSpeaking) {
      return
    }
    // Clear isSpeaking before stopping so the 'finished' handler (which guards on
    // isSpeaking) does not fire onTTSComplete after an explicit cancellation.
    this.isSpeaking = false
    this.clearSpeakWatchdog()
    this.ensureClient().callAction('ttsNode', 'stop', {})
    this.setState(this.isListening ? 'listening' : 'idle')
  }

  async requestMicrophonePermission(): Promise<boolean> {
    const granted = await NativeEdgeSpeech.requestMicrophonePermission()
    if (!granted) {
      // Match the original module: reject on denial. The useEdgeSpeech hook
      // catches this and surfaces the message as `error`.
      throw this.makeError('PERMISSION_DENIED', 'Microphone permission was denied')
    }
    return granted
  }

  // MARK: - Engine management

  private createEngine(): void {
    const client = this.ensureClient()
    if (this.engineId) {
      this.destroyEngine()
    }

    const res = client.callAction('switchboard', 'createEngine', this.buildGraphConfig())
    if (res.error || typeof res.result !== 'string') {
      const message = res.error?.message ?? 'Unknown error'
      throw this.makeError('ENGINE_CREATION_FAILED', `Failed to create audio engine: ${message}`)
    }
    this.engineId = res.result

    // Enable VoiceProcessingIO (AEC). Must be set after creation via setValue —
    // with one combined engine this keeps AEC active during TTS playback and
    // prevents self-triggered barge-in.
    client.setValue(this.engineId, 'voiceProcessingEnabled', true)
  }

  private destroyEngine(): void {
    if (!this.engineId) {
      return
    }
    this.ensureClient().callAction(this.engineId, 'stop', {})
    this.engineId = null
    this.isListening = false
    this.isSpeaking = false

    const pending = this.pendingGeneration
    if (pending) {
      clearTimeout(pending.timer)
      if (pending.firstTokenTimer) {
        clearTimeout(pending.firstTokenTimer)
      }
      this.pendingGeneration = null
      pending.reject(
        this.makeError('ENGINE_STOPPED', 'The audio engine was torn down while generating')
      )
    }
  }

  /**
   * Build the combined graph config (VAD → STT + TTS in one graph):
   *   inputNode → multiChannelToMono → busSplitter → vadNode (SileroVAD.VAD)
   *                                                 → sttNode (Whisper.STT)
   *   ttsNode (Sherpa.TTS) → monoToMultiChannel → outputNode
   *
   * There is deliberately no data connection from `vadNode.speechEnded` to
   * `sttNode.transcribe`. Transcription is driven from `dispatch` instead, so the
   * call can be held back while the sentence may still be going — see
   * {@link scheduleTranscribe}.
   */
  private buildGraphConfig(): object {
    // Whisper's Metal GPU path crashes in the iOS Simulator, so gate on it.
    const useGPU = !NativeEdgeSpeech.isSimulator()

    return {
      type: 'Realtime',
      config: {
        microphoneEnabled: true,
        speakerEnabled: true,
        graph: {
          config: {
            sampleRate: this.config.sampleRate,
            bufferSize: this.config.bufferSize,
          },
          nodes: [
            { id: 'multiChannelToMonoNode', type: 'MultiChannelToMono' },
            { id: 'busSplitterNode', type: 'BusSplitter' },
            {
              id: 'vadNode',
              type: 'Silero.VAD',
              config: {
                frameSize: 512,
                threshold: this.config.vadSensitivity,
                minSilenceDurationMs: this.config.vadSilenceMs,
              },
            },
            {
              id: 'sttNode',
              type: 'Whisper.STT',
              config: { initializeModel: true, useGPU },
            },
            { id: 'ttsNode', type: 'Sherpa.TTS' },
            { id: 'monoToMultiChannelNode', type: 'MonoToMultiChannel' },
            // No audio in or out — driven entirely through actions and events. Left
            // out when there is no model on the phone: the node would construct,
            // fail to load anything, and then abandon every turn without a word.
            // Speech in and out is unaffected, so the cloud brain still works.
            ...(this.config.llmModelPath
              ? [
                  {
                    id: 'llmNode',
                    type: 'LlamaCpp.LLM',
                    config: {
                      initializeModel: true,
                      modelPath: this.config.llmModelPath,
                      contextSize: this.config.llmContextSize,
                      temperature: this.config.llmTemperature,
                      ...(this.config.llmMaxTokens > 0 && { maxTokens: this.config.llmMaxTokens }),
                      ...(this.config.llmSeed !== null && { seed: this.config.llmSeed }),
                      ...(this.config.llmInstructions && { prompt: this.config.llmInstructions }),
                    },
                  },
                ]
              : []),
          ],
          connections: [
            { sourceNode: 'inputNode', destinationNode: 'multiChannelToMonoNode' },
            { sourceNode: 'multiChannelToMonoNode', destinationNode: 'busSplitterNode' },
            { sourceNode: 'busSplitterNode', destinationNode: 'vadNode' },
            { sourceNode: 'busSplitterNode', destinationNode: 'sttNode' },
            { sourceNode: 'ttsNode', destinationNode: 'monoToMultiChannelNode' },
            { sourceNode: 'monoToMultiChannelNode', destinationNode: 'outputNode' },
          ],
        },
      },
    }
  }

  // MARK: - Events

  private ensureClient(): SwitchboardClient {
    if (!this.client) {
      this.client = new SwitchboardClient(new NativeModuleRPCClient())
    }
    return this.client
  }

  /** Subscribe once to the SDK's event stream and route it through dispatch(). */
  private wireEvents(): void {
    if (this.eventsWired) {
      return
    }
    const client = this.ensureClient()
    client.setEventReceivedCallback((raw) => this.dispatch(raw))
    // Wildcard listener: matches every object/event, including nodes created
    // later by createEngine.
    client.addEventListener('*', '*')
    this.eventsWired = true
  }

  /** Classify a raw SDK event JSON string and emit the matching public event. */
  private dispatch(raw: string): void {
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const e = parsed?.params ?? parsed
    const objectURI: string = e?.objectURI ?? ''
    const name: string = e?.name ?? e?.eventName ?? ''
    const node = objectURI.split(/[/.]/).pop() ?? objectURI

    if (node === 'sttNode' && name === 'transcribed') {
      const text = this.extractText(e)
      if (text == null) {
        return
      }
      if (this.isSpeaking) {
        // Barge-in: Whisper decoded real speech while TTS was playing. Gating on
        // a decoded transcript (not raw VAD) avoids false triggers from TTS
        // audio bleed-through.
        this.isSpeaking = false
        this.clearSpeakWatchdog()
        this.ensureClient().callAction('ttsNode', 'stop', {})
        this.setState('listening')
        this.emit('onInterrupted', undefined)
      }
      this.holdTranscript(text)
    } else if (node === 'vadNode' && name === 'speechStarted') {
      this.speechActive = true
      // The sentence goes on, so whatever is buffered is not a turn yet. The next
      // speechEnded asks for all of it in one call.
      this.clearTranscribeTimer()
      this.emit('onSpeechStart', undefined)
    } else if (node === 'vadNode' && name === 'speechEnded') {
      this.speechActive = false
      this.scheduleTranscribe()
      this.emit('onSpeechEnd', undefined)
    } else if (node === 'ttsNode' && name === 'finished') {
      if (!this.isSpeaking) {
        return
      }
      this.isSpeaking = false
      this.clearSpeakWatchdog()
      this.setState('listening')
      this.emit('onTTSComplete', undefined)
    } else if (node === 'llmNode' && name === 'generationCancelled') {
      // Confirmation that the node dropped the reply and kept the conversation.
      // Deliberately does not touch pendingGeneration: cancelGeneration() already
      // settled that, and a new generation may have started since.
      this.emit('onGenerationCancelled', undefined)
    } else if (node === 'llmNode' && name === 'tokenReceived') {
      // Liveness only — the reply is spoken whole rather than streamed. The first
      // token is what tells a slow model apart from one that took the turn and
      // dropped it, which the node cannot report any other way.
      this.clearFirstTokenTimer()
    } else if (node === 'llmNode' && name === 'responseReceived') {
      const text = (this.extractText(e) ?? '').trim()
      const processingTime = Number(e?.data?.processingTime ?? 0)
      const pending = this.pendingGeneration
      if (!pending) {
        // A reply for a turn nobody is waiting on: the cancel lost the race, so the
        // node kept a reply this app never showed and its context is a turn ahead of
        // the transcript. OnDeviceBrain's counter cannot see that from its side.
        console.warn('[LLM] a reply arrived for an abandoned turn — the node context has drifted')
      }
      this.settleGeneration()
      pending?.resolve({ text, processingTime })
      this.emit('onLLMResponse', { text, processingTime })
    }
    // ttsNode 'synthesisStarted' is ignored, and llmNode 'tokenReceived' is read
    // for liveness only — we wait for the full reply before speaking it.
  }

  private extractText(e: any): string | null {
    const data = e?.data
    if (data && typeof data === 'object' && typeof data.text === 'string') {
      return data.text
    }
    if (typeof data === 'string') {
      return data
    }
    if (typeof e?.text === 'string') {
      return e.text
    }
    return null
  }

  // MARK: - Turn holding

  /**
   * Ask Whisper for everything it has heard since the last time it was asked, after
   * `turnHoldMs` in which speech starting again cancels the call.
   *
   * The VAD ends an utterance on silence alone, so a pause to think ends one exactly
   * as the end of a sentence does. Because the call consumes the audio it reads, a
   * fragment too short to decode would take its own words with it — so the call
   * waits, and the audio stays in Whisper's window for the rest of the sentence to
   * carry along.
   */
  private scheduleTranscribe(): void {
    this.clearTranscribeTimer()
    if (this.config.turnHoldMs <= 0) {
      this.transcribe()
      return
    }
    this.transcribeTimer = setTimeout(() => {
      this.transcribeTimer = null
      this.transcribe()
    }, this.config.turnHoldMs)
  }

  private transcribe(): void {
    if (!this.engineId) {
      return
    }
    this.ensureClient().callAction('sttNode', 'transcribe', {})
  }

  private clearTranscribeTimer(): void {
    if (!this.transcribeTimer) {
      return
    }
    clearTimeout(this.transcribeTimer)
    this.transcribeTimer = null
  }

  /**
   * Let a transcript through as a turn, unless the traveller is mid-sentence again.
   *
   * The hold above covers a pause short enough to be caught before Whisper is asked.
   * A longer one is only visible afterwards: decoding takes long enough that speech
   * can resume while it runs, and then the words already decoded are the first half
   * of a sentence whose second half is still being spoken. Those wait for it, under
   * the backstop.
   */
  private holdTranscript(text: string): void {
    const held = this.pendingTurn
    if (held) {
      clearTimeout(held.timer)
      this.pendingTurn = null
    }
    const combined = [held?.text, text].filter(Boolean).join(' ')
    if (!this.speechActive || !combined) {
      this.emit('onTranscript', { text: combined, isFinal: true })
      return
    }
    this.pendingTurn = {
      text: combined,
      timer: setTimeout(() => this.commitTurn(), HELD_TURN_BACKSTOP_MS),
    }
  }

  /** Let the held transcript through as one turn. */
  private commitTurn(): void {
    const held = this.pendingTurn
    if (!held) {
      return
    }
    clearTimeout(held.timer)
    this.pendingTurn = null
    this.emit('onTranscript', { text: held.text, isFinal: true })
  }

  /** Drop a held transcript without it becoming a turn. */
  private clearPendingTurn(): void {
    if (!this.pendingTurn) {
      return
    }
    clearTimeout(this.pendingTurn.timer)
    this.pendingTurn = null
  }

  private setState(state: VoiceState): void {
    this.emit('onStateChange', { state })
  }

  private emit<K extends EdgeSpeechEventName>(event: K, payload: EdgeSpeechEventMap[K]): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload))
  }

  private emitError(code: string, message: string): void {
    this.listeners.get('onError')?.forEach((listener) => listener({ code, message }))
  }

  /**
   * Build an Error (carrying a machine `code`) to reject a failing action with.
   * The useEdgeSpeech hook catches the rejection and surfaces the message as
   * `error`. Mirrors the original module, which rejected action promises and did
   * not additionally emit onError for action failures.
   */
  private makeError(code: string, message: string): Error {
    const error = new Error(message)
    ;(error as { code?: string }).code = code
    return error
  }

  /**
   * Reset all in-memory state and listeners. For tests only.
   * @internal
   */
  _cleanup(): void {
    this.listeners.clear()
    this.client = null
    this.engineId = null
    this.isInitialized = false
    this.isListening = false
    this.isSpeaking = false
    this.eventsWired = false
    this.clearSpeakWatchdog()
    this.pendingGeneration = null
    this.clearPendingTurn()
    this.speechActive = false
    this.clearTranscribeTimer()
    this.config = {
      vadSensitivity: 0.5,
      vadSilenceMs: DEFAULT_VAD_SILENCE_MS,
      turnHoldMs: DEFAULT_TURN_HOLD_MS,
      sampleRate: 16000,
      bufferSize: 512,
      ttsVoice: 'en_GB',
      llmModelPath: DEFAULT_LLM_MODEL,
      llmContextSize: 4096,
      llmTemperature: 0.8,
      llmMaxTokens: 0,
      llmSeed: null,
      llmInstructions: '',
    }
  }
}

/** Process-wide singleton — the whole library talks to one engine. */
export const voiceEngine = new VoiceEngine()
