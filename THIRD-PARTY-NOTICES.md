# Third-party notices

This app is MIT licensed (see [LICENSE](LICENSE)). It builds on the work below.

No model weights are stored in this repository. The Switchboard SDK frameworks —
which carry the speech models — are downloaded at install time by
`scripts/postinstall.js` from the public Switchboard bucket. The language model is
downloaded by the app itself on first launch, from the URL in
`src/model/download.ts`. The obligations listed here attach to the built app, to
those frameworks, and to the model the app fetches.

## Source absorbed into this repository

### EdgeSpeech — MIT

The on-device voice pipeline in `src/voice/` and the native TurboModule in
`modules/edgespeech-native/` come from
[EdgeSpeech](https://github.com/switchboard-sdk/EdgeSpeech), Copyright (c)
Synervoz Communications Inc., used under the MIT licence. The demo screen in
`src/screens/ConversationScreen.tsx` is derived from its example app.

## Models and libraries the app depends on

| Component                     | Licence                     | Obligation                                                                                          |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| **Llama 3.2 1B Instruct**     | Llama 3.2 Community Licence | display "Built with Llama"; ship the licence and notice; prefix derivative model names with "Llama" |
| llama.cpp                     | MIT                         | notice                                                                                              |
| Whisper (base, English)       | MIT                         | notice                                                                                              |
| **en_GB VITS voice (Sherpa)** | CC-BY-SA 4.0                | attribution **and share-alike on the voice model**                                                  |
| sherpa-onnx                   | Apache 2.0                  | notice                                                                                              |
| Silero VAD                    | MIT                         | notice                                                                                              |
| ONNX Runtime                  | MIT                         | notice                                                                                              |

### Built with Llama

This app uses Meta's Llama 3.2 1B Instruct model, licensed under the
[Llama 3.2 Community License](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE).
Any model you derive from it must carry a name prefixed with "Llama".

The weights are fetched at runtime rather than shipped, which changes nothing
about the obligation: the built app still displays "Built with Llama" and carries
this notice. Anyone serving the weights from their own host — see
`EXPO_PUBLIC_LLM_MODEL_URL` — takes on the licence's redistribution terms for that
copy.

### Share-alike on the text-to-speech voice

The en_GB VITS voice is licensed CC-BY-SA 4.0. Share-alike attaches to the voice
model itself, and **anyone forking this repository inherits that obligation**.
Shipping it unmodified alongside MIT app code is fine; redistributing a modified
voice model means releasing it under CC-BY-SA 4.0 as well. A later change swaps
in an Apache-licensed voice.

### Full licence texts

Each downloaded framework ships its own `LICENSE.txt` under
`modules/edgespeech-native/ios/Frameworks/<Package>/ios/`.
