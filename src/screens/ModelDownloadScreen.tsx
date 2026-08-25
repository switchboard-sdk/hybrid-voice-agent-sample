import React from 'react'
import { ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useOnline } from '../connectivity'
import { EXPECTED_BYTES, type ModelDownload } from '../model'

/** Decimal MB, which is the unit the phone and the model's host both use. */
function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`
}

export interface ModelDownloadScreenProps {
  download: ModelDownload
  /** Carry on without the model, answering from the cloud instead. */
  onSkip: () => void
}

/**
 * What a fresh install sees before the on-device model is on the phone.
 *
 * The model is fetched rather than shipped, so the first launch is the one launch
 * that needs a connection — an irony worth stating plainly rather than hiding
 * behind a spinner. Every launch after this one goes straight to the conversation.
 */
export function ModelDownloadScreen({
  download,
  onSkip,
}: ModelDownloadScreenProps): React.JSX.Element {
  const online = useOnline()
  const { status, received, total, failure, start } = download

  // The server's figure while it is downloading, ours before it starts.
  const size = total ?? EXPECTED_BYTES
  const fraction = size ? Math.min(received / size, 1) : null

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>
          {status === 'downloading' ? 'Downloading the model' : 'Get the on-device model'}
        </Text>

        {status === 'checking' && <Text style={styles.body}>Looking for the model…</Text>}

        {status !== 'checking' && status !== 'downloading' && (
          <Text style={styles.body}>
            The agent answers on this phone, which means the language model has to be on it. It is{' '}
            {EXPECTED_BYTES ? formatSize(EXPECTED_BYTES) : 'a large file'} and downloads once —
            after that the agent works with no connection at all.
          </Text>
        )}

        {status === 'downloading' && (
          <>
            <View style={styles.track}>
              <View
                testID="model-progress"
                style={[styles.fill, { width: `${Math.round((fraction ?? 0) * 100)}%` }]}
              />
            </View>
            <Text style={styles.counter}>
              {fraction !== null
                ? `${formatSize(received)} of ${formatSize(size as number)} · ${Math.round(fraction * 100)}%`
                : formatSize(received)}
            </Text>
            <Text style={styles.body}>
              {online
                ? 'You can leave the app while this runs — the download carries on in the background.'
                : 'No connection. The download picks up again on its own once there is one.'}
            </Text>
          </>
        )}

        {failure && <Text style={styles.failure}>{failure.message}</Text>}

        {(status === 'missing' || status === 'failed') && (
          <TouchableOpacity style={styles.button} onPress={start}>
            <Text style={styles.buttonText}>
              {status === 'failed'
                ? 'Try again'
                : `Download the model${EXPECTED_BYTES ? ` (${formatSize(EXPECTED_BYTES)})` : ''}`}
            </Text>
          </TouchableOpacity>
        )}

        {status !== 'downloading' && status !== 'checking' && (
          <TouchableOpacity onPress={onSkip}>
            <Text style={styles.secondary}>Use the cloud brain instead</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.footnote}>
          Speech recognition and synthesis are already in the app, so the cloud brain only moves
          where the thinking happens. It needs an API key in .env, and a connection for every reply.
        </Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: '#444',
  },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#e0e0e0',
    overflow: 'hidden',
  },
  fill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#6200ee',
  },
  counter: {
    fontFamily: 'Menlo',
    fontSize: 13,
    color: '#333',
  },
  failure: {
    fontSize: 15,
    lineHeight: 22,
    color: '#b3261e',
  },
  button: {
    backgroundColor: '#6200ee',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondary: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6200ee',
    textAlign: 'center',
  },
  footnote: {
    fontSize: 12,
    lineHeight: 18,
    color: '#666',
  },
})
