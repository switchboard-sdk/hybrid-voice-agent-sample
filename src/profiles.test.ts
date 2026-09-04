import { act, renderHook } from '@testing-library/react-native'

jest.mock('expo-file-system', () => require('../__mocks__/fileSystem'))

import * as fs from '../__mocks__/fileSystem'
import {
  CUSTOM_PROFILE_ID,
  PROFILES,
  TELCO_PROFILE,
  TRAVEL_PROFILE,
  _resetProfiles,
  activeProfile,
  availableProfiles,
  customProfile,
  nextProfileId,
  restoreTypedBrief,
  setProfile,
  setTypedBrief,
  typedBrief,
  useProfile,
} from './profiles'

const BRIEF_FILE = 'agent-brief.txt'
const BRIEF = 'You are the voice of a bicycle repair shop. The rider hears your reply read aloud.'

beforeEach(() => {
  fs.resetFileSystemMock()
})

afterEach(() => {
  delete process.env.EXPO_PUBLIC_AGENT_PROFILE
  _resetProfiles()
})

describe('the registry', () => {
  it('gives every profile a unique id', () => {
    const ids = PROFILES.map((profile) => profile.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every profile the parts the app reads', () => {
    PROFILES.forEach((profile) => {
      expect(profile.title.length).toBeGreaterThan(0)
      expect(profile.onDevicePrompt.length).toBeGreaterThan(0)
      expect(profile.cloudPrompt.length).toBeGreaterThan(0)
      // `OnDeviceBrain` indexes into these and treats the first as canonical, so an
      // empty list would make every refusal `undefined` and spoken as such.
      expect(profile.refusals.length).toBeGreaterThan(1)
      expect(profile.examplePrompts.length).toBeGreaterThan(0)
    })
  })

  /**
   * The bug this locks: one prompt for both models had the cloud brain announcing
   * it was offline on every turn, because the on-device set opens by saying so.
   */
  it('never gives the on-device caution to a cloud model', () => {
    PROFILES.forEach((profile) => {
      expect(profile.onDevicePrompt).toMatch(/offline/i)
      expect(profile.cloudPrompt).not.toMatch(/offline/i)
      expect(profile.onDevicePrompt).not.toBe(profile.cloudPrompt)
    })
  })

  /**
   * A refusal is said in code rather than asked for in the prompt, so a wording
   * left over from another domain would contradict the prompt it shipped with.
   */
  it('keeps each profile refusals inside its own domain', () => {
    TRAVEL_PROFILE.refusals.forEach((refusal) => expect(refusal).toMatch(/travel/i))
    TELCO_PROFILE.refusals.forEach((refusal) => expect(refusal).not.toMatch(/travel/i))
  })

  it('numbers the rules of both prompts from 1', () => {
    PROFILES.forEach((profile) => {
      expect(profile.onDevicePrompt).toContain('\n1. ')
      expect(profile.cloudPrompt).toContain('\n1. ')
    })
  })
})

describe('which profile a build wears', () => {
  it('starts on the first profile when nothing is set', () => {
    expect(activeProfile()).toBe(PROFILES[0])
  })

  it('starts on the one EXPO_PUBLIC_AGENT_PROFILE names', () => {
    process.env.EXPO_PUBLIC_AGENT_PROFILE = TELCO_PROFILE.id
    _resetProfiles()

    expect(activeProfile()).toBe(TELCO_PROFILE)
  })

  // A brand's build shipping with no agent at all is worse than one wearing the
  // wrong name, so an unknown id warns and falls back.
  it('falls back and says so when the id is unknown', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.EXPO_PUBLIC_AGENT_PROFILE = 'nope'
    _resetProfiles()

    expect(activeProfile()).toBe(PROFILES[0])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nope'))
    warn.mockRestore()
  })
})

describe('switching', () => {
  it('cycles through every profile and comes back round', () => {
    const seen = PROFILES.map(() => {
      const id = activeProfile().id
      setProfile(nextProfileId())
      return id
    })

    expect(seen).toEqual(PROFILES.map((profile) => profile.id))
    expect(activeProfile()).toBe(PROFILES[0])
  })

  it('ignores an id no profile has', () => {
    setProfile('nope')

    expect(activeProfile()).toBe(PROFILES[0])
  })

  it('re-renders a reader when the profile changes', () => {
    const { result } = renderHook(() => useProfile())
    expect(result.current).toBe(PROFILES[0])

    act(() => setProfile(TELCO_PROFILE.id))

    expect(result.current).toBe(TELCO_PROFILE)
  })

  // Ownership sits in the module rather than in a component because the component
  // rendering the picker is one of the things a profile change tears down.
  it('keeps the profile when its only reader unmounts', () => {
    const first = renderHook(() => useProfile())
    act(() => setProfile(TELCO_PROFILE.id))
    first.unmount()

    const second = renderHook(() => useProfile())

    expect(second.result.current).toBe(TELCO_PROFILE)
  })
})

describe('a brief the user typed', () => {
  it('builds both prompts around it, and opens both with it', () => {
    const built = customProfile(BRIEF)

    expect(built).not.toBeNull()
    expect(built!.brief).toBe(BRIEF)
    expect(built!.onDevicePrompt.startsWith(BRIEF)).toBe(true)
    expect(built!.cloudPrompt.startsWith(BRIEF)).toBe(true)
  })

  // The rules are the point of composing rather than using the text verbatim: at
  // 1B, a brief with no brevity rule comes back as a listicle nobody hears.
  it('adds the spoken-reply rules the brief does not carry', () => {
    const built = customProfile(BRIEF)!

    expect(built.onDevicePrompt).toContain('one or two short sentences')
    expect(built.cloudPrompt).toContain('one or two short sentences')
    expect(built.onDevicePrompt).toContain('\n1. ')
  })

  /** The bug that would return if the typed text went verbatim to both brains. */
  it('tells only the on-device model that it is offline', () => {
    const built = customProfile(BRIEF)!

    expect(built.onDevicePrompt).toMatch(/offline/i)
    expect(built.cloudPrompt).not.toMatch(/offline/i)
  })

  it('refuses without naming a subject it was never given', () => {
    const built = customProfile(BRIEF)!

    expect(built.refusals.length).toBeGreaterThan(1)
    built.refusals.forEach((refusal) => {
      expect(refusal).not.toMatch(/travel|mobile|bicycle/i)
    })
  })

  it('is not a profile when the text is blank', () => {
    expect(customProfile('')).toBeNull()
    expect(customProfile('   \n  ')).toBeNull()
  })
})

describe('typing a brief', () => {
  it('wears it, offers it in the picker, and remembers it', () => {
    setTypedBrief(BRIEF)

    expect(activeProfile().id).toBe(CUSTOM_PROFILE_ID)
    expect(activeProfile().brief).toBe(BRIEF)
    expect(availableProfiles()).toHaveLength(PROFILES.length + 1)
    expect(fs.fakeFileText(BRIEF_FILE)).toBe(BRIEF)
  })

  it('replaces the previous typed brief rather than stacking another', () => {
    setTypedBrief(BRIEF)
    setTypedBrief('You are the voice of a bakery.')

    expect(availableProfiles()).toHaveLength(PROFILES.length + 1)
    expect(activeProfile().brief).toBe('You are the voice of a bakery.')
  })

  it('re-renders a reader even though the id has not changed', () => {
    setTypedBrief(BRIEF)
    const { result } = renderHook(() => useProfile())

    act(() => setTypedBrief('You are the voice of a bakery.'))

    expect(result.current.brief).toBe('You are the voice of a bakery.')
  })

  it('goes back to a built-in agent when saved blank, and forgets the file', () => {
    setTypedBrief(BRIEF)

    setTypedBrief('  ')

    expect(activeProfile()).toBe(PROFILES[0])
    expect(availableProfiles()).toHaveLength(PROFILES.length)
    expect(typedBrief()).toBeNull()
    expect(fs.fakeFileText(BRIEF_FILE)).toBeUndefined()
  })

  it('trims what it was given', () => {
    setTypedBrief(`  ${BRIEF}\n `)

    expect(activeProfile().brief).toBe(BRIEF)
  })
})

describe('restoring a brief from an earlier session', () => {
  it('wears what was saved', () => {
    fs.writeFakeText(BRIEF_FILE, BRIEF)

    restoreTypedBrief()

    expect(activeProfile().id).toBe(CUSTOM_PROFILE_ID)
    expect(typedBrief()).toBe(BRIEF)
  })

  it('does nothing when there is no file', () => {
    restoreTypedBrief()

    expect(activeProfile()).toBe(PROFILES[0])
    expect(typedBrief()).toBeNull()
  })

  // A white-label build is pinned by the environment, so a brief someone typed on
  // that device must not quietly replace the agent the build was made to be.
  it('offers but does not wear a saved brief when the build names a profile', () => {
    process.env.EXPO_PUBLIC_AGENT_PROFILE = TELCO_PROFILE.id
    _resetProfiles()
    fs.writeFakeText(BRIEF_FILE, BRIEF)

    restoreTypedBrief()

    expect(activeProfile()).toBe(TELCO_PROFILE)
    expect(availableProfiles()).toHaveLength(PROFILES.length + 1)
  })

  it('ignores a file with nothing usable in it', () => {
    fs.writeFakeText(BRIEF_FILE, '   ')

    restoreTypedBrief()

    expect(activeProfile()).toBe(PROFILES[0])
    expect(typedBrief()).toBeNull()
  })
})
