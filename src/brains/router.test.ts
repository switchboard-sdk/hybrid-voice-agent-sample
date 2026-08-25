import { brains, canAnswer, cloudBrain, onDeviceBrain, route } from './router'
import type { BrainId } from './types'

const OFFLINE = { online: false, modelReady: true }
const NO_MODEL = { online: true, modelReady: false }

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
    // device is the safe default whenever the model is there.
    expect(route('nonsense' as BrainId)).toBe(onDeviceBrain)
  })

  it('withdraws a brain that needs a connection when there is none', () => {
    expect(route('cloud', OFFLINE)).toBe(onDeviceBrain)
  })

  it('leaves a local pick alone when there is no connection', () => {
    expect(route('on-device', OFFLINE)).toBe(onDeviceBrain)
  })

  it('withdraws the brain that needs the model when it is not on the phone', () => {
    // A fresh install that skipped the download: speech still works, so the cloud
    // answers rather than the app refusing to run.
    expect(route('on-device', NO_MODEL)).toBe(cloudBrain)
  })

  it('leaves a cloud pick alone when there is no model', () => {
    expect(route('cloud', NO_MODEL)).toBe(cloudBrain)
  })

  it('still returns a brain when nothing can answer', () => {
    // No model and no connection. The turn fails with a message saying which of
    // the two is missing, which beats the screen having no brain to name.
    expect(route('cloud', { online: false, modelReady: false })).toBe(onDeviceBrain)
  })
})

describe('canAnswer', () => {
  it('withdraws on what each brain needs, not on which brain it is', () => {
    expect(canAnswer(cloudBrain, OFFLINE)).toBe(false)
    expect(canAnswer(onDeviceBrain, OFFLINE)).toBe(true)
    expect(canAnswer(cloudBrain, NO_MODEL)).toBe(true)
    expect(canAnswer(onDeviceBrain, NO_MODEL)).toBe(false)
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

  it('keeps a brain that answers with no model on the phone', () => {
    // Same for the download screen's way past a model that never arrived.
    expect(brains.some((brain) => !brain.requiresModel)).toBe(true)
  })
})
