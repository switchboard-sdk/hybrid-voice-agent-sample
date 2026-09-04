/**
 * The agent profiles this app can wear, and which one it is wearing.
 *
 * Everything that belongs to one business rather than to the code lives in an
 * {@link AgentProfile}: the heading, the two system prompts, what a refusal sounds
 * like, and the examples offered before the first turn. White-labelling means
 * adding one below and pointing `EXPO_PUBLIC_AGENT_PROFILE` at its id — no other
 * file changes.
 *
 * **The two prompts differ on purpose.** One prompt for both models is the bug it
 * looks like a saving: the on-device set is written for a 1B model that cannot look
 * anything up, and giving that caution to the cloud model only makes it hedge over
 * answers it knows. Each set says what is true of its own model and nothing else.
 *
 * **The on-device sets are tuned, not generic.** At 1B every line has to be an
 * instruction — a rule that only describes a situation buys nothing — refusal and
 * redirect have to land in one sentence, and each do-not-invent rule carries a
 * worked example, since a bare prohibition does not hold at that size. Copying that
 * shape into a new domain is the starting point; the rules themselves still want a
 * pass on real hardware. See docs/DESIGN.md.
 *
 * Neither set carries a rule about what to turn down. A rule has to guess in
 * advance what a request is, so `OnDeviceBrain` decides from the reply instead, and
 * says one of `refusals`.
 */

import { useSyncExternalStore } from 'react'
import { File, Paths } from 'expo-file-system'

import { SPOKEN_BREVITY, systemPrompt, type AgentProfile } from './brains/types'

// MARK: - Travel

const TRAVEL_PERSONA =
  'You are the voice of a travel assistant app. The traveller speaks to you and hears your reply read aloud.'

const TRAVEL_NO_ACTIONS =
  'You cannot book, buy, reserve, cancel or phone anything, and nobody can call you. Asked to, say the traveller has to do it themselves and say where.'
const TRAVEL_NO_ASSUMED_LOCATION =
  'Never assume which town or country the traveller is in, or what they are doing, unless they told you.'
const TRAVEL_LATEST_MESSAGE =
  'Answer the traveller\'s latest message. Never write "Me:", "You:" or "Assistant:".'

export const TRAVEL_PROFILE: AgentProfile = {
  id: 'travel',
  title: 'Travel Assistant',
  brief: TRAVEL_PERSONA,
  onDevicePrompt: systemPrompt(TRAVEL_PERSONA, [
    SPOKEN_BREVITY,
    'You are offline and cannot look anything up. When an answer needs a fact you cannot check — a time, a price, the weather, an address, or what some particular place has — say you cannot check it offline and suggest who can, in the same sentence.',
    'Never give a figure you cannot check. Not as an estimate, not as a range, not as "around" or "about" or "a few". Saying you cannot check it is always better than a number that sounds right.\n   Asked "How much is a taxi to the harbour?", a good reply is: "I can\'t check fares while offline, but the taxi rank at the terminal will quote you before you set off."',
    TRAVEL_NO_ACTIONS,
    `Asked what a named place or business is like or what it has, say you have not been there and cannot check while offline, then say who can, in the same sentence. ${TRAVEL_NO_ASSUMED_LOCATION}\n   Asked "What is the harbour like?", a good reply is: "I haven't been there and can't check while offline, but a local tourist office will tell you what to expect."`,
    'Give general guidance freely — how people usually get around, what to do when a plan falls through, what to ask for.',
    TRAVEL_LATEST_MESSAGE,
  ]),
  cloudPrompt: systemPrompt(TRAVEL_PERSONA, [
    SPOKEN_BREVITY,
    'Answer from what you know, and answer properly. Asked what something costs or how long it takes, give the usual figure or range and say it is approximate — a traveller who wanted "it depends" would not have asked.',
    'Only send someone away to check when the answer is genuinely live: today\'s price, this week\'s timetable, whether somewhere is open right now. Say what is typical first, then where to confirm it.\n   Asked "How much should I budget per day in Iceland?", a good reply is: "Reckon on around 150 to 250 euros a day for food, fuel and a room, more if you are hiring a car — worth checking current rates before you commit."',
    'Never state a current specific as fact — a fare, an opening time, an address — unless you are sure of it. A range you flag as approximate is fine; a precise number you invented is not.',
    TRAVEL_NO_ACTIONS,
    TRAVEL_NO_ASSUMED_LOCATION,
    'If asked for something that is not travel help, say in your own words that travel is what you are here for and offer the nearest travel question you can answer. Never turn two requests down with the same sentence.',
    TRAVEL_LATEST_MESSAGE,
  ]),
  refusals: [
    'I can only help with travel.',
    'Travel is the only thing I can help with, I am afraid.',
    'That one is outside what I can do — travel is my subject.',
    'I only handle travel questions.',
  ],
  examplePrompts: [
    'How do I get from the airport to the harbour?',
    'My flight was cancelled — what are my options?',
    'What is worth seeing here in two days?',
  ],
}

// MARK: - Telco

const TELCO_PERSONA =
  'You are the voice of a mobile network support app. The customer speaks to you and hears your reply read aloud.'

const TELCO_NO_ACTIONS =
  'You cannot change a plan, add data, order a SIM, pay a bill or cancel anything, and nobody can call you. Asked to, say the customer has to do it themselves and say where.'
const TELCO_NO_ASSUMED_ACCOUNT =
  'Never assume which plan, phone or network the customer has, or what their bill says, unless they told you.'
const TELCO_LATEST_MESSAGE =
  'Answer the customer\'s latest message. Never write "Me:", "You:" or "Assistant:".'

export const TELCO_PROFILE: AgentProfile = {
  id: 'telco',
  title: 'Mobile Support',
  brief: TELCO_PERSONA,
  onDevicePrompt: systemPrompt(TELCO_PERSONA, [
    SPOKEN_BREVITY,
    'You are offline and cannot look anything up. When an answer needs something you cannot check — their balance, their data left, their bill, coverage where they are, or whether a fault is known — say you cannot check it offline and say who can, in the same sentence.',
    'Never give a figure you cannot check. Not as an estimate, not as a range, not as "around" or "about" or "a few". Saying you cannot check it is always better than a number that sounds right.\n   Asked "How much data do I have left?", a good reply is: "I can\'t check your allowance while offline, but the account page in the app shows it as soon as you have signal."',
    TELCO_NO_ACTIONS,
    `Asked about a specific plan, price, phone or coverage area, say you cannot check the current details offline, then say where they are, in the same sentence. ${TELCO_NO_ASSUMED_ACCOUNT}\n   Asked "Is the unlimited plan worth it?", a good reply is: "I can't check today's plans while offline, but the plans page lists what each one includes so you can compare."`,
    'Give general guidance freely — how to improve a weak signal, what to try when data stops working, what to have ready before contacting support.',
    TELCO_LATEST_MESSAGE,
  ]),
  cloudPrompt: systemPrompt(TELCO_PERSONA, [
    SPOKEN_BREVITY,
    'Answer from what you know, and answer properly. Asked how something works or how long it usually takes, give the usual answer or range and say it is approximate — a customer who wanted "it depends" would not have asked.',
    'Only send someone away to check when the answer is specific to their account or genuinely live: their balance, their data left, this month\'s bill, whether there is an outage right now. Say what is typical first, then where to confirm it.\n   Asked "How long does a number transfer take?", a good reply is: "Usually one working day once you have the transfer code, sometimes a little longer — your provider will confirm the date when you start it."',
    'Never state a current specific as fact — a price, an allowance, an outage, a delivery date — unless you are sure of it. A range you flag as approximate is fine; a precise number you invented is not.',
    TELCO_NO_ACTIONS,
    TELCO_NO_ASSUMED_ACCOUNT,
    'If asked for something that is not mobile or broadband help, say in your own words that connectivity is what you are here for and offer the nearest question you can answer. Never turn two requests down with the same sentence.',
    TELCO_LATEST_MESSAGE,
  ]),
  refusals: [
    'I can only help with mobile and broadband.',
    'Connectivity is the only thing I can help with, I am afraid.',
    'That one is outside what I can do — mobile and broadband are my subject.',
    'I only handle mobile and broadband questions.',
  ],
  examplePrompts: [
    'My data stopped working — what should I try?',
    'Why is my signal weak indoors?',
    'How long does moving my number take?',
  ],
}

// MARK: - Typed by the user

/** The id the typed profile always has, so it replaces itself rather than piling up. */
export const CUSTOM_PROFILE_ID = 'custom'

/**
 * What a typed agent says when it turns something down.
 *
 * A written profile words its own; a typed one has no domain to name, so these say
 * only that the request is outside the brief. Vague is the right register here —
 * inventing a subject the user never mentioned would be worse.
 */
const GENERIC_REFUSALS = [
  'That is outside what I can help with.',
  'I cannot help with that one, I am afraid.',
  'That one is outside what I was set up for.',
  'I am not able to help with that.',
]

/**
 * The rules a typed brief gets, in place of the ones a written profile spells out
 * for its own domain.
 *
 * Same shape as the sets above and generalised from them — every line an
 * instruction, refuse and redirect in one sentence, a worked example on each
 * do-not-invent rule. They cannot be as sharp as rules written for a known subject,
 * because a general rule cannot name the things this particular agent must not
 * invent. That is the cost of typing a prompt instead of writing a profile, and it
 * is worth saying out loud rather than discovering on a phone.
 */
function genericOnDeviceRules(): readonly string[] {
  return [
    SPOKEN_BREVITY,
    'You are offline and cannot look anything up. When an answer needs a fact you cannot check — a time, a price, a name, an address, or what some particular thing has — say you cannot check it offline and suggest who can, in the same sentence.',
    'Never give a figure you cannot check. Not as an estimate, not as a range, not as "around" or "about" or "a few". Saying you cannot check it is always better than a number that sounds right.\n   Asked "How much does it cost?", a good reply is: "I can\'t check prices while offline, but whoever provides it will quote you before you commit."',
    'You cannot book, buy, order, cancel or phone anything, and nobody can call you. Asked to, say the person has to do it themselves and say where.',
    'Never assume where the person is, what they already have, or what they are doing, unless they told you. Asked about a particular place, product or account, say you cannot check the details offline, then say who can, in the same sentence.',
    'Give general guidance freely — how something usually works, what to try when it does not, what to have ready before asking someone else.',
    'Answer the latest message. Never write "Me:", "You:" or "Assistant:".',
  ]
}

function genericCloudRules(): readonly string[] {
  return [
    SPOKEN_BREVITY,
    'Answer from what you know, and answer properly. Asked what something costs or how long it takes, give the usual figure or range and say it is approximate — someone who wanted "it depends" would not have asked.',
    "Only send someone away to check when the answer is genuinely live or specific to them: today's price, this week's schedule, their own account. Say what is typical first, then where to confirm it.",
    'Never state a current specific as fact — a price, a time, an address — unless you are sure of it. A range you flag as approximate is fine; a precise number you invented is not.',
    'You cannot book, buy, order, cancel or phone anything, and nobody can call you. Asked to, say the person has to do it themselves and say where.',
    'Never assume where the person is, what they already have, or what they are doing, unless they told you.',
    'If asked for something outside what you are here for, say so in your own words and offer the nearest thing you can answer. Never turn two requests down with the same sentence.',
    'Answer the latest message. Never write "Me:", "You:" or "Assistant:".',
  ]
}

/** Build a profile from a typed brief. Empty or blank text has no profile in it. */
export function customProfile(brief: string): AgentProfile | null {
  const trimmed = brief.trim()
  if (!trimmed) {
    return null
  }
  return {
    id: CUSTOM_PROFILE_ID,
    title: 'Custom Agent',
    brief: trimmed,
    onDevicePrompt: systemPrompt(trimmed, genericOnDeviceRules()),
    cloudPrompt: systemPrompt(trimmed, genericCloudRules()),
    refusals: GENERIC_REFUSALS,
    // Nothing to suggest: only the person who typed the brief knows what to ask.
    examplePrompts: [],
  }
}

// MARK: - The registry

/** The profiles written in this file, which every build carries. */
export const PROFILES: readonly AgentProfile[] = [TRAVEL_PROFILE, TELCO_PROFILE]

/**
 * Which profile a build starts on.
 *
 * A white-label build sets `EXPO_PUBLIC_AGENT_PROFILE` and never touches the
 * picker; an unknown id falls back rather than failing, since a brand's build
 * shipping with no agent at all is worse than one wearing the wrong name.
 */
function initialProfile(): AgentProfile {
  const id = process.env.EXPO_PUBLIC_AGENT_PROFILE
  if (!id) {
    return PROFILES[0]
  }
  const found = PROFILES.find((profile) => profile.id === id)
  if (!found) {
    console.warn(
      `[profile] no profile with id "${id}" — using "${PROFILES[0].id}". Known: ${PROFILES.map((p) => p.id).join(', ')}`
    )
    return PROFILES[0]
  }
  return found
}

/**
 * The active profile, owned here rather than by a component.
 *
 * Changing it resets the whole app, so the component that renders the picker is
 * itself one of the things being torn down. Ownership therefore sits in the module
 * and React reads it — the same reason `src/connectivity.ts` keeps its subscription
 * outside the tree.
 */
let active = initialProfile()
let typed: AgentProfile | null = null
const subscribers = new Set<() => void>()

// Compared by identity rather than by id: re-typing a brief produces a new object
// with the same `custom` id, and that is a change the app has to see.
function publish(next: AgentProfile): void {
  if (next === active) {
    return
  }
  console.log('[profile]', active.id, '->', next.id)
  active = next
  subscribers.forEach((notify) => notify())
}

/** The active profile, for callers outside React. */
export function activeProfile(): AgentProfile {
  return active
}

/** Every profile that can be picked right now — the written ones, plus a typed one. */
export function availableProfiles(): readonly AgentProfile[] {
  return typed ? [...PROFILES, typed] : PROFILES
}

/** The brief the user last typed, for pre-filling the editor. */
export function typedBrief(): string | null {
  return typed?.brief ?? null
}

/**
 * Wear a different profile.
 *
 * Applying it to the brains is the caller's job — `App.tsx` does it in an effect
 * keyed on the profile, which keeps this module free of any knowledge of them and
 * avoids an import cycle through the router.
 */
export function setProfile(id: string): void {
  const next = availableProfiles().find((profile) => profile.id === id)
  if (!next) {
    return
  }
  publish(next)
}

/**
 * Take a brief the user typed, build a profile from it, and wear it.
 *
 * Blank text clears the typed profile instead, since a prompt of nothing is not a
 * profile. Saving is fire-and-forget: the profile is live either way, and a failed
 * write costs the next launch rather than this one.
 */
export function setTypedBrief(brief: string): void {
  const next = customProfile(brief)
  typed = next
  if (!next) {
    deleteBriefFile()
    if (active.id === CUSTOM_PROFILE_ID) {
      publish(PROFILES[0])
      return
    }
    subscribers.forEach((notify) => notify())
    return
  }
  saveBriefFile(next.brief)
  publish(next)
}

/** The profile after this one, so the picker can cycle without a menu. */
export function nextProfileId(): string {
  const all = availableProfiles()
  const at = all.findIndex((profile) => profile.id === active.id)
  return all[(at + 1) % all.length].id
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** Tracks the active profile. */
export function useProfile(): AgentProfile {
  return useSyncExternalStore(
    subscribe,
    () => active,
    () => active
  )
}

// MARK: - Remembering the typed brief

/**
 * Where the typed brief is kept between launches.
 *
 * Documents, like the model, because it is the one directory iOS will not evict.
 * A brief is a few hundred bytes, so the backup this lands in costs nothing.
 */
const BRIEF_FILE = 'agent-brief.txt'

function briefFile(): File {
  return new File(Paths.document, BRIEF_FILE)
}

function saveBriefFile(brief: string): void {
  try {
    briefFile().write(brief)
  } catch (error) {
    console.warn('[profile] could not save the typed brief:', error)
  }
}

function deleteBriefFile(): void {
  try {
    const file = briefFile()
    if (file.exists) {
      file.delete()
    }
  } catch (error) {
    console.warn('[profile] could not delete the typed brief:', error)
  }
}

/**
 * Read back a brief typed in an earlier session, and wear it.
 *
 * Called once from `App.tsx`. It does not run at module load: reading a file is
 * the kind of side effect an import should not have, and the app is perfectly
 * usable on a written profile if this never lands.
 */
export function restoreTypedBrief(): void {
  let saved: string
  try {
    const file = briefFile()
    if (!file.exists) {
      return
    }
    saved = file.textSync()
  } catch (error) {
    console.warn('[profile] could not read the typed brief:', error)
    return
  }

  const restored = customProfile(saved)
  if (!restored) {
    return
  }
  typed = restored
  // The saved brief is what the user last chose, so it is what they get back —
  // unless this build is pinned to a written profile by the environment.
  if (!process.env.EXPO_PUBLIC_AGENT_PROFILE) {
    publish(restored)
  } else {
    subscribers.forEach((notify) => notify())
  }
}

/**
 * Go back to the profile a fresh build starts on. For tests only.
 * @internal
 */
export function _resetProfiles(): void {
  active = initialProfile()
  typed = null
  subscribers.clear()
}
