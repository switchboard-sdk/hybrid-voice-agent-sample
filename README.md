# Hybrid Voice Agent

An iOS voice agent that runs the whole conversation on the device — speech to
text, a small language model, and text to speech — and can hand the "brain" over
to a cloud model when you want it to. Speech recognition and synthesis stay on
the device on both paths, so only the intelligence swaps, and the two share one
transcript.

Built with the [Switchboard SDK](https://switchboard.audio). The on-device voice
pipeline comes from [EdgeSpeech](https://github.com/switchboard-sdk/EdgeSpeech).

> **Status: early.** The on-device speech pipeline runs, both brains sit behind one
> interface, and you can switch between them mid-conversation. The screen is the
> travel-agent demo, on a deliberately minimal persona prompt that is not tuned yet.
> The model is bundled rather than downloaded on first launch.

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
    router.ts               which brain answers — the file to change
  screens/                  UI
    ConversationScreen.tsx  the whole app: transcript, state, per-turn badges
modules/edgespeech-native/  the only native code: a C++ TurboModule + podspec
scripts/postinstall.js      framework download
```

The native layer is deliberately tiny: one JSON-RPC string channel plus an event
stream. The entire audio graph — voice activity detection, transcription,
synthesis, barge-in — is authored in TypeScript above it, so changing the
pipeline never means touching native code.

## The screen

One screen, and one control: **Talk** opens the mic and every reply comes back
spoken. The transcript is the whole surface.

Each assistant turn carries the brain that answered it and the time that brain
took — `AI · On-device · 1.2 s` — coloured per brain, so switching mid-conversation
shows the difference rather than claiming it. The number is the brain's own
measurement so the two paths compare like for like; the round trip, which adds
only app overhead, goes to the console alongside it as `[turn]`. That plus the
`[LLM]` and `[Cloud]` lines each brain logs is the whole of the telemetry — there
is no analytics dependency.

The voice is never presented as a person: the header says so, and every reply is
labelled `AI`.

Badges, timings and interrupt markers are held alongside the transcript by index
rather than in it. Both brains read that transcript, and neither ever produced a
message about itself.

## The persona

Both brains are given the same system prompt, `DEFAULT_SYSTEM_PROMPT` in
`src/brains/types.ts`, so a turn reads the same whichever one served it. It is
written for the smaller of the two, because what the 1B on-device model can follow
a cloud model can follow as well: numbered one-line rules rather than a paragraph,
and **every rule phrased as something to do**.

That last part is the whole lesson of tuning it. A draft that stated the situation —
"you have no internet, no booking system and no live data" — got a quoted taxi fare,
a weather report produced in airplane mode, and an invented hospital, while the same
draft's length rule, an instruction, held on every turn. A small model acts on
actions and ignores descriptions. The rules that follow from that: refusing and
redirecting are one sentence rather than two rules, the ban on invented specifics is
general rather than a list of examples to slip between, and nothing may describe a
named place — the worst answer of that pass asserted what the harbour office has on
staff, and "the harbour office" came from the prompt's own list of who to ask.

Length is prompt-only on the on-device path. `CloudBrain` caps a reply at 200
tokens; the `LlamaCpp.LLM` node takes `instructions`, `temperature`, `contextSize`
and `seed` and has no equivalent, so the wording is what keeps a reply speakable.
The temperature is also lower than the pipeline's default, in `App.tsx`: rules only
hold if the sampling is conservative enough to follow them.

### What the prompt does not fix

Three device passes got fabrication to zero, and left two habits behind.

The model sometimes **recites a rule instead of following it**: asked how long a
rebooking takes, it answered "I can only help with travel" — rule 7's sentence,
aimed at a travel question. Asked what is worth seeing, it announced that it can
offer general guidance rather than offering any. Both are honest and useless. The
wording that produced them is also what stopped the invented fares and clinics, so
it stays until something better is measured rather than guessed.

And a direct **"write me a poem" still produces verse**, three times out of three,
whatever the prompt says. A request in the user's turn outranks a rule in the system
prompt on a model this size. That is why the guard in `OnDeviceBrain` exists: the
prompt asks, the code decides.

Neither applies to the cloud brain, which follows the same prompt without either
habit.

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
out in the prompt text — which makes it look like a transcript, and a 1B model will
carry on writing one rather than answering. So the replay fences the history off as
background and ends on an instruction, and a reply that still opens with a role
label has it stripped before it reaches the transcript or the speaker.

It also flattens a reply that arrives as verse or a list to its first sentence.
The prompt forbids both, and tells the model to decline the requests that provoke
them, but a direct "write me a poem" outranks the system prompt on a model this
size — it answered with thirteen lines twice, and the speaker read every one. A
reply that obeys the prompt has no line breaks in it, so nothing legitimate is lost.

It also drops a trailing half-sentence. A reply can be cut off rather than finished
— the node's `maxTokens` ceiling stops wherever the count runs out — and half a
sentence read aloud sounds like a fault rather than a short answer. A reply that
never reached a sentence end is kept whole: a fragment still beats saying nothing.

`CloudBrain` calls OpenAI's chat completions API, which takes the transcript as it
is — the roles the app already tracks are the roles the model expects. On top of
that it handles what a network needs: a 15-second timeout, one retry on a timeout,
a dropped connection, a 429 or a 5xx, and prompt cancellation when the user
interrupts. The provider-specific parts are `buildRequest`, `parseReply` and
`parseError` at the top of `CloudBrain.ts` — those three functions and two
constants are the whole of what changes to point it somewhere else.

The transcript holds only what was actually said. An interruption is recorded
against the reply it cut off rather than added as a turn of its own — a message
reading `[interrupted]` would be a turn neither brain ever produced, and it would
put the on-device node permanently one message behind.

**Cancelling a turn** stops the work on both paths. The cloud request is aborted;
the on-device node stops within a token and drops the reply it was building,
keeping the conversation. Either way the transcript is left holding what the user
said with no answer to it, which is a state the next turn continues from normally
— so interrupting costs nothing beyond the reply you chose not to hear.

### Swapping the brain

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

The switch works mid-conversation. Both brains are handed the same transcript on
every turn, so the cloud picks up where the device left off and vice versa — the
on-device node just pays one re-prefill at the moment of the switch, for the
reasons in [Conversation history](#conversation-history).

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
