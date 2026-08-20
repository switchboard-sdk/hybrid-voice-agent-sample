import React from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { EdgeSpeechProvider } from './src/voice'
import { ConversationScreen } from './src/screens/ConversationScreen'
import { SetupScreen } from './src/screens/SetupScreen'
import { DEFAULT_SYSTEM_PROMPT } from './src/brains'

// Credentials from environment variables (see .env.example)
const SWITCHBOARD_APP_ID = process.env.EXPO_PUBLIC_SWITCHBOARD_APP_ID ?? ''
const SWITCHBOARD_APP_SECRET = process.env.EXPO_PUBLIC_SWITCHBOARD_APP_SECRET ?? ''

export default function App(): React.JSX.Element {
  // Gate here rather than letting the provider throw: nothing catches a render
  // throw, so a missing .env would take the whole app down.
  if (!SWITCHBOARD_APP_ID || !SWITCHBOARD_APP_SECRET) {
    return (
      <SafeAreaProvider>
        <SetupScreen />
      </SafeAreaProvider>
    )
  }

  return (
    <SafeAreaProvider>
      <EdgeSpeechProvider
        appId={SWITCHBOARD_APP_ID}
        appSecret={SWITCHBOARD_APP_SECRET}
        vadSensitivity={0.5}
        // Below the pipeline's 0.8: the prompt's rules only hold if sampling follows
        // them.
        llmTemperature={0.4}
        llmInstructions={DEFAULT_SYSTEM_PROMPT}>
        <ConversationScreen />
      </EdgeSpeechProvider>
    </SafeAreaProvider>
  )
}
