import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { brains, route, type BrainId, type ConversationMessage } from '../brains'
import { useEdgeSpeech, type VoiceState } from '../voice'

/** A turn that was abandoned rather than failing. */
const isCancelled = (error: unknown): boolean => (error as { code?: string })?.code === 'CANCELLED'

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

/**
 * The engine's `processing` state is only reached by the on-device path, and a
 * cloud turn is just as much thinking — so the two are folded together here.
 */
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

const EXAMPLE_PROMPTS = [
  'How do I get from the airport to the harbour?',
  'My flight was cancelled — what are my options?',
  'What is worth seeing here in two days?',
]

/**
 * The demo screen: a travel agent you talk to.
 *
 * Every assistant turn is stamped with the brain that answered and the time it
 * took, so switching mid-conversation shows the difference rather than describing
 * it. The transcript stays what was actually said — the badges, the timings and
 * the interrupt markers are annotations held alongside it by index, because both
 * brains read that transcript and neither ever produced a message about itself.
 */
export function ConversationScreen(): React.JSX.Element {
  const {
    transcript,
    onTranscriptComplete,
    onInterrupted,
    voiceState,
    listen,
    stopListening,
    speak,
    stopSpeaking,
    requestMicrophonePermission,
  } = useEdgeSpeech()

  // The mic is live and replies are automatic. One control rather than two: a
  // conversation you have to arm separately is not the demo.
  const [sessionActive, setSessionActive] = useState(false)
  const [preferred, setPreferred] = useState<BrainId>('on-device')
  const [conversationHistory, setConversationHistory] = useState<ConversationMessage[]>([])
  // Tracked here rather than read off voiceState: only the on-device brain drives
  // the engine's 'processing' state, and the indicator has to mean the same thing
  // for both.
  const [thinking, setThinking] = useState(false)
  // Which replies were cut off mid-sentence. An interruption annotates a turn, it
  // is not a turn of its own — and it has to stay out of the transcript, because
  // both brains read that and neither ever generated a message saying so.
  const [interrupted, setInterrupted] = useState<ReadonlySet<number>>(new Set())
  // Who answered each assistant turn, and how long the user waited for it.
  const [turnMeta, setTurnMeta] = useState<ReadonlyMap<number, TurnMeta>>(new Map())

  const brain = route(preferred)
  const activity = activityOf(voiceState, thinking)
  const chatScrollRef = useRef<ScrollView>(null)
  const prevVoiceStateRef = useRef(voiceState)

  // The transcript the brain is handed. Mirrors conversationHistory so a turn
  // that starts before React has re-rendered still sees every earlier message —
  // which now happens routinely, because a turn can be interrupted by the next.
  const historyRef = useRef<ConversationMessage[]>([])

  // The turn in flight, so a new one can abandon it.
  const turnRef = useRef<AbortController | null>(null)

  /** Append and return the index the message landed at, for annotating it. */
  const appendMessage = useCallback((message: ConversationMessage): number => {
    historyRef.current = [...historyRef.current, message]
    setConversationHistory(historyRef.current)
    setTimeout(() => chatScrollRef.current?.scrollToEnd({ animated: true }), 50)
    return historyRef.current.length - 1
  }, [])

  const handleConversationResponse = useCallback(
    async (userText: string, history: ConversationMessage[]) => {
      // The mic stays live while the brain thinks, so the user can talk over the
      // pause. Doing so lands here again and abandons the turn below.
      turnRef.current?.abort()
      const turn = new AbortController()
      turnRef.current = turn
      setThinking(true)

      const startedAt = Date.now()
      try {
        const reply = await brain.reply(userText, history, turn.signal)
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
        // The number on screen is the brain's own, so the two paths compare
        // like for like. The round trip is logged next to it.
        console.log(
          `[turn] ${brain.label} answered in ${reply.processingTime}ms (${waited}ms round trip)`
        )
        await speak(reply.text)
      } catch (error) {
        if (isCancelled(error)) {
          return
        }
        console.error('Chat error:', error)
        Alert.alert('Chat Error', (error as Error).message)
      } finally {
        // Only if this turn is still the current one: an interrupting turn has
        // already claimed the slot and put the indicator back up.
        if (turnRef.current === turn) {
          turnRef.current = null
          setThinking(false)
        }
      }
    },
    [brain, appendMessage, speak]
  )

  // Register interrupted callback
  useEffect(() => {
    onInterrupted(() => {
      // Fired before the transcript of what the user said over it, so the last
      // message is still the reply that was talked over.
      const cutOff = historyRef.current.length - 1
      if (cutOff < 0) {
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

  // Abandon whatever is in flight when the screen goes away.
  useEffect(() => () => turnRef.current?.abort(), [])

  // Back to listening once the agent has finished speaking, so the conversation
  // continues without a tap.
  useEffect(() => {
    if (prevVoiceStateRef.current === 'speaking' && voiceState === 'idle' && sessionActive) {
      listen()
    }
    prevVoiceStateRef.current = voiceState
  }, [voiceState, listen, sessionActive])

  const startSession = async () => {
    const granted = await requestMicrophonePermission()
    if (!granted) {
      Alert.alert('Microphone needed', 'The agent cannot hear you without microphone access.')
      return
    }
    await listen()
    setSessionActive(true)
  }

  const endSession = async () => {
    setSessionActive(false)
    turnRef.current?.abort()
    setThinking(false)
    await stopSpeaking()
    await stopListening()
  }

  const clearConversation = () => {
    turnRef.current?.abort()
    historyRef.current = []
    setConversationHistory([])
    setInterrupted(new Set())
    setTurnMeta(new Map())
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

      <ScrollView
        ref={chatScrollRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}>
        {conversationHistory.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Ask about your trip</Text>
            <Text style={styles.emptyBody}>
              The agent can answer on the phone itself, so it keeps working where there is no
              signal. Ask it something like:
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

        {/* What the recogniser has so far, so listening is visibly working. */}
        {transcript.trim().length > 0 && (
          <View style={[styles.bubble, styles.userBubble, styles.pendingBubble]}>
            <Text style={styles.userRole}>You</Text>
            <Text style={[styles.bubbleText, styles.pendingText]}>{transcript}</Text>
          </View>
        )}

        {thinking && (
          <View style={[styles.bubble, styles.assistantBubble, styles.thinkingBubble]}>
            <Text style={styles.thinkingText}>{brain.label} is thinking…</Text>
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
            const selected = candidate.id === preferred
            return (
              <TouchableOpacity
                key={candidate.id}
                style={[styles.brainOption, selected && styles.brainOptionSelected]}
                onPress={() => setPreferred(candidate.id)}>
                <Text style={[styles.brainOptionText, selected && styles.brainOptionTextSelected]}>
                  {candidate.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
        <Text style={styles.brainPickerHint}>
          Switch any time — both brains read the same conversation.
        </Text>

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
