# Hybrid Voice Agent

An iOS voice agent that runs the whole conversation on the device — speech to
text, a small language model, and text to speech — and can hand the "brain" over
to a cloud model when you want it to. Speech recognition and synthesis stay on
the device on both paths, so only the intelligence swaps, and the two share one
transcript.

Built with the [Switchboard SDK](https://switchboard.audio). The on-device voice
pipeline comes from [EdgeSpeech](https://github.com/switchboard-sdk/EdgeSpeech).

> **Status: skeleton.** The on-device speech pipeline runs today, and both brains
> sit behind one interface. The router and the toggle that switches between them
> are still to come — for now the brain is chosen by one import in
> `src/screens/ConversationScreen.tsx`.

## Requirements

- macOS with Xcode 16 or newer
- Node.js 22+
- A real iPhone — the on-device models need one, and Whisper's Metal path does
  not run in the Simulator
- Around 3 GB of free disk space for the frameworks

## Setup

```bash
git clone <repo-url>
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
frameworks — which carry the speech and language models — from the public
Switchboard bucket into `modules/edgespeech-native/ios/Frameworks/`.

The fetch itself lives in `scripts/fetch-frameworks.js`, which `postinstall`
delegates to and you can run on its own with `npm run frameworks`. Each framework
is stamped with the bucket object's ETag once it lands, so a re-run fetches only
what is missing or has changed. That matters while we track `develop`, which is a
moving channel: when the release pipeline rebuilds it, a re-run picks the new
build up on its own.

The install script also honours a few build-time variables:

| Variable                  | Effect                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| `SWITCHBOARD_SDK_CHANNEL` | Bucket path to pull from. Defaults to `develop`.                  |
| `SWITCHBOARD_SDK_VERSION` | SDK version in the archive names. Defaults to `3.2.5`.            |
| `SKIP_FRAMEWORK_DOWNLOAD` | Skip the download entirely. Used by CI's lint/typecheck/test job. |

## Layout

```
App.tsx                     providers + screen
index.ts                    Expo entry point
src/
  voice/                    the on-device pipeline
    VoiceEngine.ts          the audio graph and state machine, in TypeScript
    SwitchboardClient.ts    typed wrapper over the SDK's JSON-RPC interface
    EdgeSpeechProvider.tsx  configuration and lifecycle
    hook.ts                 useEdgeSpeech()
  brains/                   the two interchangeable brains
    types.ts                the Brain interface and the shared system prompt
    OnDeviceBrain.ts        the LlamaCpp.LLM node
    CloudBrain.ts           a cloud LLM over HTTP
  screens/                  UI
modules/edgespeech-native/  the only native code: a C++ TurboModule + podspec
scripts/postinstall.js      framework download
```

The native layer is deliberately tiny: one JSON-RPC string channel plus an event
stream. The entire audio graph — voice activity detection, transcription,
synthesis, barge-in — is authored in TypeScript above it, so changing the
pipeline never means touching native code.

## The two brains

Speech recognition and synthesis are always on the device. The only thing that
swaps is what answers, and both answerers implement the same interface:

```ts
interface Brain {
  readonly id: BrainId
  readonly label: string
  reply(
    transcript: string,
    history: ConversationMessage[],
    signal?: AbortSignal
  ): Promise<BrainReply>
  reset(instructions?: string): void
}
```

Neither owns the conversation — the transcript is handed in on every turn — so
swapping brains mid-conversation carries the context across rather than starting
over. A reply comes back saying which brain produced it and how long it took, so
a turn can be labelled with both.

`OnDeviceBrain` wraps the `LlamaCpp.LLM` node. Because that node takes a single
string rather than a list of turns, a replayed conversation has its roles spelled
out in the prompt text.

`CloudBrain` calls OpenAI's chat completions API, which takes the transcript as it
is — the roles the app already tracks are the roles the model expects. On top of
that it handles what a network needs: a 15-second timeout, one retry on a timeout,
a dropped connection, a 429 or a 5xx, and prompt cancellation when the user
interrupts. The provider-specific parts are `buildRequest`, `parseReply` and
`parseError` at the top of `CloudBrain.ts` — those three functions and two
constants are the whole of what changes to point it somewhere else.

**Cancelling a turn** stops the work on both paths. The cloud request is aborted;
the on-device node stops within a token and drops the reply it was building,
keeping the conversation. Either way the transcript is left holding what the user
said with no answer to it, which is a state the next turn continues from normally
— so interrupting costs nothing beyond the reply you chose not to hear.

### Cloud credentials

The cloud brain needs an [OpenAI API key](https://platform.openai.com/api-keys) in
`EXPO_PUBLIC_CLOUD_LLM_API_KEY`. Two optional companions:
`EXPO_PUBLIC_CLOUD_LLM_MODEL` (defaults to `gpt-4o-mini`) and
`EXPO_PUBLIC_CLOUD_LLM_BASE_URL`. The on-device brain needs none of them, and runs
with no account at all — selecting the cloud brain without a key fails with a
message saying exactly that.

`EXPO_PUBLIC_` variables are compiled into the JS bundle by Expo, exactly like the
Switchboard credentials above. **A key put there is not a secret: it can be
extracted from any build that ships.** That is fine for a key of your own on your
own device. It is not fine for a shared or billable key, and not fine for anything
distributed — including TestFlight.

For those, put a proxy you control between the app and the provider, keep the key
server-side, and point `EXPO_PUBLIC_CLOUD_LLM_BASE_URL` at the proxy. Nothing in
the app changes: it already sends the same chat-completions request, and the key it
sends is then whatever the proxy expects rather than the real one.

## Conversation history

**App state is the source of truth.** The `LlamaCpp.LLM` node also keeps its own
rolling context, evicting the oldest exchanges when the context fills, but that
context is opaque — it cannot be read, and there is no way to append a past turn
without the model generating a reply to it. The only reset it offers is writing
the `instructions` property, which clears the history deliberately.

So the two are kept in step by tracking how many messages the node has ingested:

- **In sync** — the usual case — a turn sends only the new user message, so the
  node keeps its cache warm and the reply comes back fast.
- **Diverged** — the node and the transcript disagree, because a cloud reply
  landed or the brain was switched mid-conversation — the node is reset and the
  conversation is replayed as a single prompt.

That costs one re-prefill at the moment of a switch and nothing during a normal
exchange. It is also what lets a switch keep context: both brains read and write
the same transcript, so flipping mid-conversation continues rather than restarts.

## Development

```bash
npm run lint      # eslint
npm run check     # tsc --noEmit
npm test          # jest
npm run format    # prettier
```

All three checks run on every pull request.

## Licence

MIT — see [LICENSE](LICENSE). Third-party components, including the Llama 3.2
attribution requirement and the share-alike licence on the text-to-speech voice,
are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Read that file
before forking.
