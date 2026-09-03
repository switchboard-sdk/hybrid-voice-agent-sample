import { act, renderHook } from '@testing-library/react-native'

import {
  PROFILES,
  TELCO_PROFILE,
  TRAVEL_PROFILE,
  _resetProfiles,
  activeProfile,
  nextProfileId,
  setProfile,
  useProfile,
} from './profiles'

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
