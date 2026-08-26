import React from 'react'
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

const CONSOLE_URL = 'https://console.switchboard.audio/register'

/**
 * What a fresh clone sees before it has credentials.
 *
 * `EdgeSpeechProvider` throws without them, and nothing here catches a render
 * throw, so `App.tsx` checks first and shows this instead of a blank screen.
 */
export function SetupScreen(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Add your Switchboard credentials</Text>
        <Text style={styles.body}>
          The voice pipeline needs an app ID and secret before it can start. Put them in the
          project's <Text style={styles.code}>.env</Text>, which{' '}
          <Text style={styles.code}>npm install</Text> copies from{' '}
          <Text style={styles.code}>.env.example</Text>:
        </Text>

        <View style={styles.block}>
          <Text style={styles.blockLine}>EXPO_PUBLIC_SWITCHBOARD_APP_ID=…</Text>
          <Text style={styles.blockLine}>EXPO_PUBLIC_SWITCHBOARD_APP_SECRET=…</Text>
        </View>

        <Text style={styles.body}>
          Then restart the app so the values are compiled into the bundle.
        </Text>

        <TouchableOpacity style={styles.button} onPress={() => Linking.openURL(CONSOLE_URL)}>
          <Text style={styles.buttonText}>Get credentials</Text>
        </TouchableOpacity>

        <Text style={styles.footnote}>
          That is the whole of it. The on-device brain needs no account at all, and the cloud one
          reaches its model through Switchboard with the same two values, so there is no provider
          key to add here.
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
  code: {
    fontFamily: 'Menlo',
    fontSize: 13,
    color: '#333',
  },
  block: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#dee2e6',
    padding: 12,
    gap: 4,
  },
  blockLine: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#333',
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
  footnote: {
    fontSize: 12,
    lineHeight: 18,
    color: '#666',
  },
})
