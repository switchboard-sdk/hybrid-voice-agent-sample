# Hybrid Voice Agent

An iOS voice agent that runs the whole conversation on the device — speech to
text, a small language model, and text to speech — and can hand the "brain" over
to a cloud model when you want it to. Speech recognition and synthesis stay on
the device on both paths, so only the intelligence swaps, and the two share one
transcript.

Built with the [Switchboard SDK](https://switchboard.audio). The on-device voice
pipeline comes from [EdgeSpeech](https://github.com/switchboard-sdk/EdgeSpeech).

> **Status: early.** The on-device speech pipeline runs, both brains sit behind one
> interface, and you can switch between them mid-conversation.

## Architecture

Everything but the cloud brain runs on the phone. Speech recognition and synthesis
are on the device whichever brain answers, so the only thing that ever crosses the
network is the thinking — and only when you ask it to.

```mermaid
flowchart LR
  subgraph phone["On the phone"]
    direction LR
    mic(["Mic"]) --> vad["Silero VAD"]
    vad -- "speechEnded<br/>(held)" --> stt["Whisper STT"]
    stt --> router{"route()"}
    router -- "on-device" --> llm["LlamaCpp.LLM node<br/>Llama 3.2 1B"]
    llm --> tts["Sherpa TTS"]
    tts --> spk(["Speaker"])
  end
  subgraph net["Off the phone"]
    chat["Switchboard /chat"]
  end
  router -- "cloud" --> chat --> tts
  classDef ondevice fill:#e0f2f1,stroke:#00796b,stroke-width:2px,color:#004d40
  classDef cloudy fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#0d47a1
  class llm ondevice
  class chat cloudy
  style phone fill:#fafafa,stroke:#bdbdbd,color:#424242
  style net fill:#f5faff,stroke:#90caf9,color:#0d47a1
```

Both brains are handed the same transcript on every turn and neither keeps its own,
which is what lets the switch happen mid-conversation rather than starting over.

`route()` in [`src/brains/router.ts`](src/brains/router.ts) is the seam: the only
file in the app that names an implementation, and so the only one a fork has to
change. [Swapping the brain](#swapping-the-brain) is what to do there.

## Requirements

- macOS with Xcode 16 or newer
- Node.js 22+
- A real iPhone — the on-device models need one, and Whisper's Metal path does
  not run in the Simulator
- Around 3 GB of free disk space for the frameworks, and around 800 MB free on
  the phone for the language model

## Setup

```bash
git clone https://github.com/switchboard-sdk/hybrid-voice-agent-sample.git
cd hybrid-voice-agent-sample
npm install                 # downloads ~2.3 GB of Switchboard frameworks, takes a while
npm run ios -- --device     # prebuilds the iOS project, then builds and runs it
```

`npm run ios` on its own targets the Simulator, which is useful for UI work but
not for the models — run on a device for anything real.

`npm install` also copies `.env.example` to `.env`. Fill in your Switchboard app
ID and secret there before running — register at
[console.switchboard.audio](https://console.switchboard.audio/register) to get
them.

No model weights are committed here. Install fetches the SDK and extension
frameworks — which carry the speech models — from the public Switchboard bucket
into `modules/edgespeech-native/ios/Frameworks/`, and strips the assets this app
never reads. The default channel is `develop`, a pre-release one, because the app
needs the LLM node's cancel action and reply ceiling and no release carries them
yet. See [Installing the frameworks](docs/DESIGN.md#installing-the-frameworks)
for the variables that control it and what the lock file can and cannot promise.

## The language model

**Built with Llama.** The on-device model is Meta's Llama 3.2 1B Instruct, used
under the [Llama 3.2 Community License](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE),
which asks for that notice wherever it is used. The download screen carries it too.
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) has the full obligation, along
with the share-alike terms on the text-to-speech voice.

The weights are downloaded by the app on first launch rather than shipped inside
it. The first launch shows a screen offering the download and saying what it
costs; it is not started automatically, because 773 MB is not something to spend
on someone's data plan without asking. The fetch runs on a background
`URLSession`, so it survives the app being put away and keeps retrying through a
connection that comes and goes. After that, every launch goes straight to the
conversation with no connection needed.

Two things it does not do. The app being killed mid-download loses the partial
file, so the next launch starts again. And the model sits in Documents, which iOS
includes in the device's backup — `expo-file-system` has no way to mark a file as
excluded, and Documents is the only directory the system will not evict.

Whoever does not want to wait can take **Use the cloud brain instead** and carry
on: speech recognition and synthesis are in the app either way, so only the
thinking moves. The on-device brain is then withdrawn — `route` drops it and the
picker dims it, the same way losing the connection withdraws the cloud. Getting
the model afterwards means relaunching.

| Variable                    | Effect                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_LLM_MODEL_URL` | Where to fetch the model from. Defaults to a public mirror of the build the SDK's LLM extension carries. |

Overriding the URL also stands the size check down, since another GGUF will not
weigh what this one does — a short file is then only caught by the total the
server declares.

## Layout

```
App.tsx                     credentials, then the model, then the conversation
index.ts                    Expo entry point
src/
  voice/                    the on-device pipeline
    VoiceEngine.ts          the audio graph and state machine, in TypeScript
    SwitchboardClient.ts    typed wrapper over the SDK's JSON-RPC interface
    EdgeSpeechProvider.tsx  configuration and lifecycle
    hook.ts                 useEdgeSpeech()
  brains/                   the two interchangeable brains
    types.ts                the Brain interface and the three system prompts
    OnDeviceBrain.ts        the LlamaCpp.LLM node
    CloudBrain.ts           a cloud LLM over HTTP
    router.ts               which brain answers — the file to change
  model/                    the language model's weights
    download.ts             finding it on the phone, and fetching it if it is not
    hook.ts                 useModel()
  screens/                  UI
    ConversationScreen.tsx  the whole app: transcript, state, per-turn badges
    ModelDownloadScreen.tsx the first launch: the download, or a way past it
    SetupScreen.tsx         what a clone with no credentials sees
  connectivity.ts           whether there is a connection, and the spoken notice
  errors.ts                 the only place a failure code becomes a sentence
modules/edgespeech-native/  the only native code: a C++ TurboModule + podspec
app.config.js               layers the signing team from .env onto app.json
frameworks.lock.json        the SDK builds this commit was tested against
scripts/fetch-frameworks.js the framework download, and the asset stripping
scripts/postinstall.js      runs the fetch after npm install
scripts/testflight.js       archive, export and upload a build
docs/DESIGN.md              how the pipeline, prompts and brains work underneath
docs/TESTFLIGHT.md          distributing a build
```

The native layer is deliberately tiny: one JSON-RPC string channel plus an event
stream. The whole audio graph — voice detection, transcription, synthesis,
barge-in — is authored in TypeScript above it, so changing the pipeline never
means touching native code. See [The native layer](docs/DESIGN.md#the-native-layer).

## Swapping the brain

Both answerers implement one interface:

```ts
interface Brain {
  readonly id: BrainId
  readonly label: string
  readonly requiresNetwork: boolean
  readonly requiresModel: boolean
  reply(
    transcript: string,
    history: ConversationMessage[],
    signal?: AbortSignal
  ): Promise<BrainReply>
  reset(instructions?: string): void
}
```

Neither owns the conversation — the transcript is handed in on every turn — so a
reply comes back saying which brain produced it and how long it took, and a switch
mid-conversation carries the context across.

`src/brains/router.ts` is the only file that names the implementations. Everything
else talks to the `Brain` interface and never learns which one it got, so a fork
changes that one file:

```ts
export const brains: readonly Brain[] = [onDeviceBrain, cloudBrain]

export function route(preferred: BrainId): Brain {
  return brains.find((brain) => brain.id === preferred) ?? onDeviceBrain
}
```

Adding a third brain means writing a class that implements `Brain`, constructing it
there, and adding it to `brains` — the picker in the UI is rendered from that list,
so it appears on its own. Routing on something other than the user's choice means
changing `route`, which is handed the selection and can consult whatever it likes
instead.

[The two brains](docs/DESIGN.md#the-two-brains) covers what each implementation
does beyond the interface, and
[Conversation history](docs/DESIGN.md#conversation-history) covers how the
on-device node's own context is kept in step with the transcript.

## Cloud credentials

There are none to add to `.env`. The cloud brain does not call a provider
directly: it posts to Switchboard's `/chat`, which authenticates with the same app
ID and secret that start the SDK and keeps the provider key on the server. No
credential worth stealing is compiled into the bundle — which matters because
`EXPO_PUBLIC_` variables can be extracted from any build that ships.

What does have to be set is a provider key on the app record, which lives in the
console rather than in this repo. Open your app in
[console.switchboard.audio](https://console.switchboard.audio/), find
**Configuration**, and add an OpenAI key to the JSON already shown there:

```json
{ "openAi": { "apiKey": "sk-proj-…" } }
```

The editor replaces the whole config, so merge rather than paste over it. The same
key serves the Realtime client-secret routes, so an app already set up for those
needs nothing further. Until it is saved, a cloud turn fails with _"This app has no
cloud model configured"_ and the on-device brain carries on regardless.

The endpoint decides the rest, and none of it is per-request: which model answers,
a 200-token ceiling, and the last 12 messages of whatever is sent. It is also rate
limited to five requests per 30 seconds per app — one turn is one request — and a
refused turn still counts against the window. So a 429 is not retried:
`CloudBrain` reports how long to wait and offers the on-device brain.

| Variable                         | Effect                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `EXPO_PUBLIC_CLOUD_LLM_BASE_URL` | Where the cloud brain posts. Defaults to `https://api.switchboard.audio/chat`. |

## Known limits

**The model on the phone invents specifics, confidently, and nothing here stops it.**
The prompt forbids exactly that; it breaks the rules anyway. Asked how far something
is it gives a walking time. Asked about a place it has no knowledge of it describes
one, and will put a town several hundred kilometres from where it belongs. Asked
nothing at all — a "thanks" at the end of a conversation — it may decide where the
traveller is standing and what they are about to do.

Rewording the rules does not reach it, and neither does sampling at temperature 0.
A code guard could catch the figures, since a price or a distance is detectable
without understanding it, but not the invented places: refusing every place the
traveller did not name first leaves the brain unable to answer the questions people
actually ask.

So it stands as the honest limit of a 1B model with no retrieval behind it, and the
cloud brain is one tap away for anything that needs a fact. The replies are fluent
and sound authoritative, which is exactly what makes them a problem — worth knowing
before showing this to anyone.

**Recognition is the other one.** `ggml-base.en` is weak on proper nouns, which is
the one class of word a travel assistant hears most: "Budapest" comes back as
"Buddha Pasht" often enough to plan around. Nothing downstream questions a mangled
name, so one misrecognition becomes the premise for the rest of the conversation —
the model answers about the wrong city and never wonders why.

## Development

```bash
npm run lint      # eslint
npm run check     # tsc --noEmit
npm test          # jest
npm run format    # prettier
```

All three checks run on every pull request.

## Further reading

- [docs/DESIGN.md](docs/DESIGN.md) — the native layer, framework install and asset
  stripping, the screen, turn taking, the prompts, both brain implementations,
  going offline, error handling, and conversation history.
- [docs/TESTFLIGHT.md](docs/TESTFLIGHT.md) — signing, `npm run testflight`, and
  what has to exist in App Store Connect first.

## Licence

MIT — see [LICENSE](LICENSE). Third-party components, including the Llama 3.2
attribution requirement and the share-alike licence on the text-to-speech voice,
are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Read that file
before forking.
