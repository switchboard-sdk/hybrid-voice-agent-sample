import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import {
  brains,
  canAnswer,
  route,
  type Brain,
  type BrainId,
  type ConversationMessage,
} from '../brains'
import { OFFLINE_NOTICE, useOnline } from '../connectivity'
import { describeError, isCancelled, type ErrorDescription } from '../errors'
import { useEdgeSpeech, type VoiceState } from '../voice'

/** What the transcript itself does not carry: who answered, and how long it took. */
interface TurnMeta {
  brain: BrainId
  label: string
  ms: number
}

/** What the screen shows the user it is doing. */
type Activity = 'idle' | 'listening' | 'thinking' | 'speaking'

const ACTIVITY_COLOR: Record<Activity, string> = {
  idle: '#9aa0a6',
  listening: '#2e7d32',
  thinking: '#ef6c00',
  speaking: '#1565c0',
}

const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: 'Not listening',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
}

/** Badge colour per brain, so which one answered reads at a glance. */
const BRAIN_COLOR: Record<BrainId, string> = {
  'on-device': '#00796b',
  cloud: '#1565c0',
}

/** Only the on-device path reaches `processing`, and a cloud turn is thinking too. */
function activityOf(voiceState: VoiceState, thinking: boolean): Activity {
  if (thinking || voiceState === 'processing') {
    return 'thinking'
  }
  if (voiceState === 'speaking') {
    return 'speaking'
  }
  if (voiceState === 'listening') {
    return 'listening'
  }
  return 'idle'
}

/** Seconds once a reply is slow enough for seconds to be the readable unit. */
function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)} s`
  }
  return `${ms} ms`
}

/** The one line under the picker: what is narrowing the choice, or that nothing is. */
function pickerHint(online: boolean, modelReady: boolean): string {
  if (!modelReady) {
    return 'No model on this phone — answering from the cloud.'
  }
  if (!online) {
    return 'No connection — answering on this phone.'
  }
  return 'Switch any time — both brains read the same conversation.'
}

const EXAMPLE_PROMPTS = [
  'How do I get from the airport to the harbour?',
  'My flight was cancelled — what are my options?',
  'What is worth seeing here in two days?',
]

export interface ConversationScreenProps {
  /** Whether the model's weights are on the phone — see `src/model`. */
  modelReady: boolean
}

/**
 * The demo screen: a travel agent you talk to.
 *
 * The transcript holds only what was said. Badges, timings and interrupt markers
 * are annotations kept alongside it by index, since both brains read the transcript
 * and neither produced a message about itself.
 */
export function ConversationScreen({ modelReady }: ConversationScreenProps): React.JSX.Element {
  const {
    transcript,
    onTranscriptComplete,
    onInterrupted,
    voiceState,
    error,
    errorCode,
    clearError,
    listen,
    stopListening,
    speak,
    stopSpeaking,
    requestMicrophonePermission,
  } = useEdgeSpeech()

  // The mic is live and replies are automatic — one control, not two.
  const [sessionActive, setSessionActive] = useState(false)
  const [preferred, setPreferred] = useState<BrainId>('on-device')
  const [conversationHistory, setConversationHistory] = useState<ConversationMessage[]>([])
  // Tracked here rather than read off voiceState: only the on-device brain drives
  // 'processing', and the indicator has to mean the same thing for both.
  const [thinking, setThinking] = useState(false)
  // Which replies were cut off mid-sentence. An interruption annotates a turn
  // rather than being one, so it stays out of the transcript both brains read.
  const [interrupted, setInterrupted] = useState<ReadonlySet<number>>(new Set())
  // Who answered each assistant turn, and how long the user waited for it.
  const [turnMeta, setTurnMeta] = useState<ReadonlyMap<number, TurnMeta>>(new Map())
  // Whatever last went wrong, and what can be offered about it.
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  // Seconds the current turn has been thinking. The cloud path can spend two
  // timeouts and a retry on one turn, which needs to be legible while it happens.
  const [thinkingSeconds, setThinkingSeconds] = useState(0)

  const online = useOnline()
  // The brain the user picked, and the one that will answer. They differ only when
  // the pick needs a connection there is not.
  const picked = route(preferred, { online: true, modelReady })
  const brain = route(preferred, { online, modelReady })
  // What the banner offers when a brain fails: no connection is when the on-device
  // path earns its place, and a missing model is when the cloud does. Nothing is
  // offered when only one brain can answer at all.
  const otherBrain = brains.find(
    (candidate) => candidate.id !== brain.id && canAnswer(candidate, { online, modelReady })
  )
  const activity = activityOf(voiceState, thinking)
  const chatScrollRef = useRef<ScrollView>(null)
  const prevVoiceStateRef = useRef(voiceState)
  const wasOnlineRef = useRef(online)

  // The transcript the brain is handed. Mirrors conversationHistory so a turn that
  // starts before React re-renders still sees every prior message.
  const historyRef = useRef<ConversationMessage[]>([])

  // The turn in flight, so a new one can abandon it. The brain comes along because
  // losing the connection has to tell a doomed cloud turn from a local one.
  const turnRef = useRef<{ controller: AbortController; brain: Brain } | null>(null)

  /** Append and return the index the message landed at, for annotating it. */
  const appendMessage = useCallback((message: ConversationMessage): number => {
    historyRef.current = [...historyRef.current, message]
    setConversationHistory(historyRef.current)
    setTimeout(() => chatScrollRef.current?.scrollToEnd({ animated: true }), 50)
    return historyRef.current.length - 1
  }, [])

  const handleConversationResponse = useCallback(
    async (userText: string, history: ConversationMessage[]) => {
      // The mic stays live while the brain thinks, so talking over the pause lands
      // here again and abandons the turn below.
      turnRef.current?.controller.abort()
      const turn = new AbortController()
      turnRef.current = { controller: turn, brain }
      setThinking(true)

      const startedAt = Date.now()
      try {
        const reply = await brain.reply(userText, history, turn.signal)
        setFailure(null)
        clearError()
        const waited = Date.now() - startedAt
        setThinking(false)
        const index = appendMessage({ role: 'assistant', content: reply.text })
        setTurnMeta((prev) =>
          new Map(prev).set(index, {
            brain: reply.brain,
            label: brain.label,
            ms: reply.processingTime,
          })
        )
        // The screen shows the brain's own number, so the paths compare like for like.
        console.log(
          `[turn] ${brain.label} answered in ${reply.processingTime}ms (${waited}ms round trip)`
        )
        await speak(reply.text)
      } catch (turnError) {
        if (isCancelled(turnError)) {
          return
        }
        console.log('[turn] failed:', turnError)
        setFailure(describeError(turnError))
      } finally {
        // Only if this turn is still the current one: an interrupting turn has
        // already claimed the slot.
        if (turnRef.current?.controller === turn) {
          turnRef.current = null
          setThinking(false)
        }
      }
    },
    [brain, appendMessage, speak, clearError]
  )

  // Register interrupted callback
  useEffect(() => {
    onInterrupted(() => {
      // Fires before the transcript of what was said over it, so the last message is
      // still the reply that was interrupted — unless what was talked over was the
      // offline notice, which is nobody's turn and annotates nothing.
      const cutOff = historyRef.current.length - 1
      if (historyRef.current[cutOff]?.role !== 'assistant') {
        return
      }
      setInterrupted((prev) => new Set(prev).add(cutOff))
    })
  }, [onInterrupted])

  // Register final-transcript callback
  useEffect(() => {
    onTranscriptComplete((text: string) => {
      if (!sessionActive) {
        return
      }
      // Whisper returns empty transcripts for non-speech. Dropping them keeps
      // blank turns out of the history the model is replayed.
      const content = text.trim()
      if (!content) {
        return
      }

      // Read before appending: the brain gets the conversation up to but
      // excluding this turn.
      const history = historyRef.current
      appendMessage({ role: 'user', content })
      handleConversationResponse(content, history)
    })
  }, [onTranscriptComplete, sessionActive, handleConversationResponse, appendMessage])

  // Engine failures — init, listen, speak, permission — reach the banner too.
  useEffect(() => {
    if (!error) {
      return
    }
    setFailure(describeError({ code: errorCode ?? undefined, message: error }))
  }, [error, errorCode])

  // Count up while a turn is in flight, and reset once it is not.
  useEffect(() => {
    if (!thinking) {
      setThinkingSeconds(0)
      return
    }
    const started = Date.now()
    const tick = setInterval(() => {
      setThinkingSeconds(Math.round((Date.now() - started) / 1000))
    }, 1000)
    return () => clearInterval(tick)
  }, [thinking])

  // Abandon whatever is in flight when the screen goes away.
  useEffect(() => () => turnRef.current?.controller.abort(), [])

  // Losing the connection mid-conversation. `route` has already withdrawn the cloud
  // brain by the time this runs, so the notice is spoken and the question the cloud
  // was about to fail is asked again on the device — the wait the notice warns about.
  //
  // Two things it stays quiet for: no conversation, since an announcement into a
  // closed mic is the app talking to itself, and a pick that never needed the
  // network, which loses nothing worth talking over a reply for.
  useEffect(() => {
    const wasOnline = wasOnlineRef.current
    wasOnlineRef.current = online
    // Nothing to announce when the pick never needed the network, and nothing to
    // promise without the model: going offline then leaves no brain that can answer.
    if (online || !wasOnline || !sessionActive || !picked.requiresNetwork || !modelReady) {
      return
    }

    // Abandon a cloud turn rather than waiting for a request that cannot arrive.
    const inFlight = turnRef.current
    if (inFlight?.brain.requiresNetwork) {
      inFlight.controller.abort()
    }

    // What to pick up is a question in the transcript with no answer under it, not
    // whatever turn happened to be in flight: the request may have already died on
    // the way down, or never started because the words were still being transcribed.
    const history = historyRef.current
    const asked = history[history.length - 1]
    const unanswered =
      asked?.role === 'user' ? { text: asked.content, history: history.slice(0, -1) } : null
    // The cloud's complaint about a connection that is gone is being answered by
    // going on-device, so it is not news.
    setFailure(null)
    clearError()

    speak(OFFLINE_NOTICE)
    if (unanswered) {
      handleConversationResponse(unanswered.text, unanswered.history)
    }
  }, [online, sessionActive, picked, modelReady, speak, clearError, handleConversationResponse])

  // The engine returns to 'listening' itself after TTS. This is the backstop for the
  // paths that land on 'idle' instead, so the conversation continues without a tap.
  useEffect(() => {
    if (prevVoiceStateRef.current === 'speaking' && voiceState === 'idle' && sessionActive) {
      listen()
    }
    prevVoiceStateRef.current = voiceState
  }, [voiceState, listen, sessionActive])

  const startSession = async () => {
    const granted = await requestMicrophonePermission()
    if (!granted) {
      setFailure(describeError({ code: 'PERMISSION_DENIED' }))
      return
    }
    // Only arm the session if the microphone opened, so the control cannot offer
    // to end a conversation that is not happening.
    const listening = await listen()
    if (!listening) {
      return
    }
    setFailure(null)
    clearError()
    setSessionActive(true)
  }

  const endSession = async () => {
    setSessionActive(false)
    turnRef.current?.controller.abort()
    setThinking(false)
    await stopSpeaking()
    await stopListening()
  }

  const switchBrain = () => {
    if (!otherBrain) {
      return
    }
    setPreferred(otherBrain.id)
    setFailure(null)
    clearError()
  }

  const clearConversation = () => {
    turnRef.current?.controller.abort()
    historyRef.current = []
    setConversationHistory([])
    setInterrupted(new Set())
    setTurnMeta(new Map())
    setFailure(null)
    clearError()
    brains.forEach((candidate) => candidate.reset())
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Travel Assistant</Text>
          <View style={styles.aiChip}>
            <Text style={styles.aiChipText}>◆ AI VOICE</Text>
          </View>
        </View>
        <View style={styles.headerRow}>
          <Text style={styles.subtitle}>A synthetic voice — not a person</Text>
          {conversationHistory.length > 0 && (
            <TouchableOpacity onPress={clearConversation}>
              <Text style={styles.clearButton}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {failure && (
        <View style={styles.banner}>
          <View style={styles.bannerTextColumn}>
            <Text style={styles.bannerText}>{failure.message}</Text>
            {failure.action === 'open-settings' && (
              <TouchableOpacity onPress={() => Linking.openSettings()}>
                <Text style={styles.bannerAction}>Open Settings</Text>
              </TouchableOpacity>
            )}
            {failure.action === 'switch-brain' && otherBrain && (
              <TouchableOpacity onPress={switchBrain}>
                <Text style={styles.bannerAction}>Use the {otherBrain.label} brain</Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            accessibilityLabel="Dismiss"
            onPress={() => {
              setFailure(null)
              clearError()
            }}>
            <Text style={styles.bannerDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        ref={chatScrollRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}>
        {conversationHistory.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Ask about your trip</Text>
            <Text style={styles.emptyBody}>
              {modelReady
                ? 'The agent can answer on the phone itself, so it keeps working where there is no signal. Ask it something like:'
                : 'The model is not on this phone, so replies come from the cloud for now. Ask it something like:'}
            </Text>
            {EXAMPLE_PROMPTS.map((prompt) => (
              <Text key={prompt} style={styles.emptyPrompt}>
                “{prompt}”
              </Text>
            ))}
          </View>
        )}

        {conversationHistory.map((msg, index) => {
          const meta = turnMeta.get(index)
          const wasInterrupted = interrupted.has(index)
          if (msg.role === 'user') {
            return (
              <View key={index} style={[styles.bubble, styles.userBubble]}>
                <Text style={styles.userRole}>You</Text>
                <Text style={styles.bubbleText}>{msg.content}</Text>
                {wasInterrupted && <Text style={styles.interruptedNote}>interrupted</Text>}
              </View>
            )
          }
          return (
            <View
              key={index}
              style={[
                styles.bubble,
                styles.assistantBubble,
                meta && { borderLeftColor: BRAIN_COLOR[meta.brain] },
              ]}>
              <View style={styles.metaRow}>
                <Text style={styles.metaAi}>AI</Text>
                {meta && (
                  <>
                    <Text style={styles.metaSeparator}>·</Text>
                    <Text
                      testID={`turn-brain-${index}`}
                      style={[styles.metaBrain, { color: BRAIN_COLOR[meta.brain] }]}>
                      {meta.label}
                    </Text>
                    <Text style={styles.metaSeparator}>·</Text>
                    <Text testID={`turn-time-${index}`} style={styles.metaTime}>
                      {formatDuration(meta.ms)}
                    </Text>
                  </>
                )}
              </View>
              <Text style={styles.bubbleText}>{msg.content}</Text>
              {wasInterrupted && <Text style={styles.interruptedNote}>interrupted</Text>}
            </View>
          )
        })}

        {/* What the recogniser has so far. */}
        {transcript.trim().length > 0 && (
          <View style={[styles.bubble, styles.userBubble, styles.pendingBubble]}>
            <Text style={styles.userRole}>You</Text>
            <Text style={[styles.bubbleText, styles.pendingText]}>{transcript}</Text>
          </View>
        )}

        {thinking && (
          <View style={[styles.bubble, styles.assistantBubble, styles.thinkingBubble]}>
            <Text style={styles.thinkingText}>
              {brain.label} is thinking…
              {thinkingSeconds > 2 ? ` ${thinkingSeconds}s` : ''}
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: ACTIVITY_COLOR[activity] }]} />
          <Text style={styles.statusText}>{ACTIVITY_LABEL[activity]}</Text>
        </View>

        {/* Brain picker. Rendered from the router's list, so a third brain
            appears here without touching this screen. */}
        <View style={styles.brainPicker}>
          {brains.map((candidate) => {
            // The brain that will answer, not the one that was picked: no connection
            // withdraws the cloud, no model withdraws the other, and the picker has
            // to say so either way.
            const selected = candidate.id === brain.id
            const unavailable = !canAnswer(candidate, { online, modelReady })
            return (
              <TouchableOpacity
                key={candidate.id}
                style={[
                  styles.brainOption,
                  selected && styles.brainOptionSelected,
                  unavailable && styles.brainOptionUnavailable,
                ]}
                disabled={unavailable}
                onPress={() => setPreferred(candidate.id)}>
                <Text style={[styles.brainOptionText, selected && styles.brainOptionTextSelected]}>
                  {candidate.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
        <Text style={styles.brainPickerHint}>{pickerHint(online, modelReady)}</Text>

        <TouchableOpacity
          style={[styles.talkButton, sessionActive && styles.talkButtonActive]}
          accessibilityRole="button"
          onPress={sessionActive ? endSession : startSession}>
          <Text style={styles.talkButtonText}>{sessionActive ? 'End conversation' : 'Talk'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e6e6e6',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333',
  },
  aiChip: {
    borderWidth: 1,
    borderColor: '#7e57c2',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  aiChipText: {
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: '#5e35b1',
  },
  subtitle: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  clearButton: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2196F3',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginHorizontal: 20,
    marginTop: 12,
    padding: 12,
    backgroundColor: '#fdecea',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#c62828',
  },
  bannerTextColumn: {
    flex: 1,
    gap: 6,
  },
  bannerText: {
    fontSize: 13,
    lineHeight: 19,
    color: '#8e1b16',
  },
  bannerAction: {
    fontSize: 13,
    fontWeight: '600',
    color: '#c62828',
  },
  bannerDismiss: {
    fontSize: 15,
    fontWeight: '600',
    color: '#8e1b16',
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    padding: 20,
    gap: 10,
  },
  empty: {
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  emptyBody: {
    fontSize: 13,
    color: '#666',
    lineHeight: 19,
  },
  emptyPrompt: {
    fontSize: 13,
    fontStyle: 'italic',
    color: '#444',
  },
  bubble: {
    padding: 12,
    borderRadius: 12,
    maxWidth: '88%',
  },
  userBubble: {
    backgroundColor: '#e3f2fd',
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: '#fff',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: '#cfd8dc',
  },
  pendingBubble: {
    opacity: 0.6,
  },
  pendingText: {
    fontStyle: 'italic',
  },
  thinkingBubble: {
    borderLeftColor: '#ef6c00',
  },
  thinkingText: {
    fontSize: 14,
    fontStyle: 'italic',
    color: '#e65100',
  },
  userRole: {
    fontSize: 10,
    fontWeight: '600',
    color: '#666',
    marginBottom: 3,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 4,
  },
  metaAi: {
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: '#5e35b1',
  },
  metaSeparator: {
    fontSize: 10,
    color: '#b0bec5',
  },
  metaBrain: {
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '600',
  },
  metaTime: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#666',
  },
  bubbleText: {
    fontSize: 15,
    color: '#333',
    lineHeight: 21,
  },
  interruptedNote: {
    fontSize: 11,
    fontStyle: 'italic',
    color: '#ad1457',
    marginTop: 5,
  },
  footer: {
    padding: 20,
    paddingTop: 12,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e6e6e6',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  brainPicker: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#dee2e6',
    borderRadius: 8,
    overflow: 'hidden',
  },
  brainOption: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
  },
  brainOptionSelected: {
    backgroundColor: '#2196F3',
  },
  brainOptionUnavailable: {
    opacity: 0.4,
  },
  brainOptionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  brainOptionTextSelected: {
    color: '#fff',
  },
  brainPickerHint: {
    fontSize: 11,
    color: '#666',
    marginTop: 6,
    marginBottom: 14,
    textAlign: 'center',
  },
  talkButton: {
    backgroundColor: '#6200ee',
    paddingVertical: 15,
    borderRadius: 10,
    alignItems: 'center',
  },
  talkButtonActive: {
    backgroundColor: '#d32f2f',
  },
  talkButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
})
