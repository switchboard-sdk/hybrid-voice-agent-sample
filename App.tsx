import React from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { EdgeSpeechProvider } from './src/voice'
import { ConversationScreen } from './src/screens/ConversationScreen'

// Credentials from environment variables (see .env.example)
const SWITCHBOARD_APP_ID = process.env.EXPO_PUBLIC_SWITCHBOARD_APP_ID ?? ''
const SWITCHBOARD_APP_SECRET = process.env.EXPO_PUBLIC_SWITCHBOARD_APP_SECRET ?? ''

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <EdgeSpeechProvider
        appId={SWITCHBOARD_APP_ID}
        appSecret={SWITCHBOARD_APP_SECRET}
        vadSensitivity={0.5}>
        <ConversationScreen />
      </EdgeSpeechProvider>
    </SafeAreaProvider>
  )
}
