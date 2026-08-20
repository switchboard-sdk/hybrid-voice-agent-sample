import { brains, cloudBrain, onDeviceBrain, route } from './router'
import type { BrainId } from './types'

// The router constructs an OnDeviceBrain, which reaches the voice engine, and
// TurboModuleRegistry.getEnforcing throws under Jest.
jest.mock('../voice/VoiceEngine', () => ({
  __esModule: true,
  voiceEngine: {
    generate: jest.fn(() => Promise.resolve({ text: 'reply', processingTime: 1 })),
    resetConversation: jest.fn(),
    cancelGeneration: jest.fn(),
  },
}))

describe('route', () => {
  it('returns the brain the user picked', () => {
    expect(route('on-device')).toBe(onDeviceBrain)
    expect(route('cloud')).toBe(cloudBrain)
  })

  it('falls back to on-device for an id it does not know', () => {
    // A stale persisted preference, or a brain a fork removed. Answering on the
    // device is always possible, so it is the safe default.
    expect(route('nonsense' as BrainId)).toBe(onDeviceBrain)
  })

  it('withdraws a brain that needs a connection when there is none', () => {
    expect(route('cloud', false)).toBe(onDeviceBrain)
  })

  it('leaves a local pick alone when there is no connection', () => {
    expect(route('on-device', false)).toBe(onDeviceBrain)
  })
})

describe('brains', () => {
  it('offers every brain exactly once', () => {
    const ids = brains.map((brain) => brain.id)

    expect(ids).toEqual(['on-device', 'cloud'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is routable end to end — every listed brain can be selected', () => {
    // Guards the picker: it renders from this list, so an entry route() cannot
    // resolve would be a dead button.
    brains.forEach((brain) => expect(route(brain.id)).toBe(brain))
  })

  it('gives every brain a label to show', () => {
    brains.forEach((brain) => expect(brain.label.trim()).not.toHaveLength(0))
  })

  it('keeps a brain that answers with no connection', () => {
    // Offline routing has somewhere to go only while this holds.
    expect(brains.some((brain) => !brain.requiresNetwork)).toBe(true)
  })
})
