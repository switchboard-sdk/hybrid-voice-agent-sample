import React, { useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { customProfile } from '../profiles'

export interface PromptScreenProps {
  /** The brief to open on — the active profile's, or one typed earlier. */
  initialBrief: string
  /** Save and wear it. Blank text clears a typed profile instead. */
  onSave: (brief: string) => void
  onCancel: () => void
}

/**
 * Where the agent is typed.
 *
 * What the user writes is the brief — what the agent is and who it is talking to.
 * Each brain's rules are added around it, and both assembled prompts are shown
 * below the field, because a prompt the app changed without saying so is worse
 * than a long screen. The on-device one is what shows first: it is the model that
 * needs the rules most and the one whose replies surprise people.
 */
export function PromptScreen({
  initialBrief,
  onSave,
  onCancel,
}: PromptScreenProps): React.JSX.Element {
  const [brief, setBrief] = useState(initialBrief)
  const [showing, setShowing] = useState<'on-device' | 'cloud' | null>(null)

  const trimmed = brief.trim()
  const preview = customProfile(brief)
  const unchanged = trimmed === initialBrief.trim()

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel}>
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>System prompt</Text>
          <TouchableOpacity onPress={() => onSave(brief)} disabled={unchanged}>
            <Text style={[styles.save, unchanged && styles.saveDisabled]}>Save</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.fill} contentContainerStyle={styles.body}>
          <Text style={styles.label}>What is this agent?</Text>
          <TextInput
            style={styles.input}
            value={brief}
            onChangeText={setBrief}
            multiline
            autoFocus
            placeholder="You are the voice of a…"
            placeholderTextColor="#aaa"
            textAlignVertical="top"
            accessibilityLabel="Agent brief"
          />

          <Text style={styles.help}>
            Say what the agent is and who it is speaking to. Rules for a spoken reply are added on
            top — one or two sentences, no lists, and, on the phone, not inventing facts it cannot
            check.
          </Text>

          {trimmed.length === 0 && (
            <Text style={styles.warning}>
              Saving with nothing here goes back to the built-in agent.
            </Text>
          )}

          {preview && (
            <View style={styles.previewBlock}>
              <View style={styles.previewTabs}>
                {(['on-device', 'cloud'] as const).map((which) => (
                  <TouchableOpacity
                    key={which}
                    onPress={() => setShowing(showing === which ? null : which)}>
                    <Text style={[styles.previewTab, showing === which && styles.previewTabOn]}>
                      {which === 'on-device' ? 'On-device prompt' : 'Cloud prompt'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {showing && (
                <Text style={styles.previewText} accessibilityLabel={`${showing} prompt`}>
                  {showing === 'on-device' ? preview.onDevicePrompt : preview.cloudPrompt}
                </Text>
              )}
            </View>
          )}

          <Text style={styles.help}>
            The two prompts differ on purpose: the model on the phone is told it is offline and
            cannot look anything up, and telling a cloud model the same would have it announce that
            on every turn.
          </Text>

          <Text style={styles.warning}>
            A typed brief gets general rules. A profile written in `src/profiles.ts` can name the
            things its own agent must not invent, which is sharper — worth doing for anything you
            ship.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e6e6e6',
  },
  title: { fontSize: 16, fontWeight: '600', color: '#333' },
  cancel: { fontSize: 14, color: '#666' },
  save: { fontSize: 14, fontWeight: '600', color: '#2196F3' },
  saveDisabled: { color: '#bbb' },
  body: { padding: 20, gap: 12 },
  label: { fontSize: 13, fontWeight: '600', color: '#333' },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    lineHeight: 21,
    color: '#222',
    backgroundColor: '#fafafa',
  },
  help: { fontSize: 12, lineHeight: 18, color: '#666' },
  warning: { fontSize: 12, lineHeight: 18, color: '#8d6e63' },
  previewBlock: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 12,
    gap: 8,
  },
  previewTabs: { flexDirection: 'row', gap: 16 },
  previewTab: { fontSize: 12, fontWeight: '600', color: '#2196F3' },
  previewTabOn: { color: '#0d47a1', textDecorationLine: 'underline' },
  previewText: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
    color: '#444',
    backgroundColor: '#f5f5f5',
    borderRadius: 6,
    padding: 10,
  },
})
