import React, { useEffect, useState } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { EdgeSpeechProvider } from './src/voice'
import { ConversationScreen } from './src/screens/ConversationScreen'
import { ModelDownloadScreen } from './src/screens/ModelDownloadScreen'
import { SetupScreen } from './src/screens/SetupScreen'
import { brains } from './src/brains'
import { useModel } from './src/model'
import { restoreTypedBrief, useProfile } from './src/profiles'

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
  const profile = useProfile()
  const [cloudOnly, setCloudOnly] = useState(false)

  // A brief typed in an earlier session, read back once. Reading a file is not
  // something an import should do, so it happens here rather than at module load.
  useEffect(() => {
    restoreTypedBrief()
  }, [])

  // Both brains wear the profile before anything can ask them for a turn. The
  // router constructs them on the profile a build starts on, so this is only for
  // a change made while the app is running.
  useEffect(() => {
    brains.forEach((brain) => brain.applyProfile(profile))
  }, [profile])

  if (model.status !== 'ready' && !cloudOnly) {
    return <ModelDownloadScreen download={model} onSkip={() => setCloudOnly(true)} />
  }

  return (
    <EdgeSpeechProvider
      appId={SWITCHBOARD_APP_ID}
      appSecret={SWITCHBOARD_APP_SECRET}
      vadSensitivity={0.5}
      // What the traveller waits after falling silent, split between the VAD's own
      // hold and the one above it. Both are here rather than buried in the engine
      // because they are tuned against real speech on real hardware, and the two
      // pull against each other: together they are also how long barge-in takes to
      // register, since that fires on a decoded transcript rather than on the VAD.
      vadSilenceMs={500}
      turnHoldMs={350}
      // Below the pipeline's 0.8: the prompt's rules only hold if sampling follows
      // them.
      llmTemperature={0.4}
      // Roughly twice what two spoken sentences need, and the traveller waits for
      // every token of it. Rule 1 is what asks for short; when the model answers with
      // a list instead, `flattenMultilineReply` drops everything past the first
      // sentence — so a ceiling generous enough to hold the rest only buys a longer
      // wait for words nobody hears. The cloud is capped by its endpoint at 200,
      // which costs nothing there because generating is not what the wait is made of.
      llmMaxTokens={80}
      // Undefined leaves the language-model node out of the graph entirely.
      llmModelPath={model.path ?? undefined}
      llmInstructions={profile.onDevicePrompt}>
      {/* Keyed on the profile: a new agent is a new product, not a new topic, so
          the remount is what drops the transcript, the badges and the picked
          brain rather than any teardown code here. */}
      <ConversationScreen
        key={profile.id}
        profile={profile}
        modelReady={model.status === 'ready'}
      />
    </EdgeSpeechProvider>
  )
}
