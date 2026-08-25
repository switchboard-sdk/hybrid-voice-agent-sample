import React, { useState } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { EdgeSpeechProvider } from './src/voice'
import { ConversationScreen } from './src/screens/ConversationScreen'
import { ModelDownloadScreen } from './src/screens/ModelDownloadScreen'
import { SetupScreen } from './src/screens/SetupScreen'
import { DEFAULT_SYSTEM_PROMPT } from './src/brains'
import { useModel } from './src/model'

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
      <VoiceAgent />
    </SafeAreaProvider>
  )
}

/**
 * The model first, then the conversation.
 *
 * The weights are fetched rather than shipped, so a fresh install has nothing for
 * the on-device brain to load yet. Whoever does not want to wait for the download
 * can carry on without it and be answered from the cloud — speech recognition and
 * synthesis are in the app either way. Getting the model after that means
 * relaunching, which is the honest cost of keeping this one screen deep.
 */
function VoiceAgent(): React.JSX.Element {
  const model = useModel()
  const [cloudOnly, setCloudOnly] = useState(false)

  if (model.status !== 'ready' && !cloudOnly) {
    return <ModelDownloadScreen download={model} onSkip={() => setCloudOnly(true)} />
  }

  return (
    <EdgeSpeechProvider
      appId={SWITCHBOARD_APP_ID}
      appSecret={SWITCHBOARD_APP_SECRET}
      vadSensitivity={0.5}
      // Below the pipeline's 0.8: the prompt's rules only hold if sampling follows
      // them.
      llmTemperature={0.4}
      // The same ceiling CloudBrain puts on a cloud reply, so neither path can run
      // away. A backstop rather than a brevity control: it stops wherever the count
      // runs out and OnDeviceBrain trims the fragment. Rule 1 is what asks for short.
      llmMaxTokens={200}
      // Undefined leaves the language-model node out of the graph entirely.
      llmModelPath={model.path ?? undefined}
      llmInstructions={DEFAULT_SYSTEM_PROMPT}>
      <ConversationScreen modelReady={model.status === 'ready'} />
    </EdgeSpeechProvider>
  )
}
