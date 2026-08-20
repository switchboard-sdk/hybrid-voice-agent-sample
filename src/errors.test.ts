import { codeOf, describeError, isCancelled } from './errors'
import { brainError, cancelledError } from './brains/types'

describe('codeOf', () => {
  it('reads the code a layer tagged its error with', () => {
    expect(codeOf(brainError('CLOUD_TIMEOUT', 'too slow'))).toBe('CLOUD_TIMEOUT')
  })

  it('is undefined for an untagged error', () => {
    expect(codeOf(new Error('plain'))).toBeUndefined()
    expect(codeOf(undefined)).toBeUndefined()
  })
})

describe('isCancelled', () => {
  it('recognises both layers’ cancellations', () => {
    expect(isCancelled(cancelledError())).toBe(true)
    expect(isCancelled(brainError('GENERATION_CANCELLED', 'dropped'))).toBe(true)
  })

  it('does not mistake a failure for a cancellation', () => {
    expect(isCancelled(brainError('CLOUD_TIMEOUT', 'too slow'))).toBe(false)
    expect(isCancelled(new Error('plain'))).toBe(false)
  })
})

describe('describeError', () => {
  it('offers Settings for a denied microphone, the only recovery iOS has', () => {
    const { message, action } = describeError(brainError('PERMISSION_DENIED', 'denied'))
    expect(message).toContain('microphone access')
    expect(action).toBe('open-settings')
  })

  it('points a failing on-device model at the cloud brain', () => {
    expect(describeError(brainError('GENERATE_TIMEOUT', 'no reply')).action).toBe('switch-brain')
    expect(describeError(brainError('MODEL_NOT_RESPONDING', 'no token')).action).toBe(
      'switch-brain'
    )
  })

  it('points a failing cloud model at the on-device brain', () => {
    const { message, action } = describeError(
      brainError('CLOUD_UNREACHABLE', 'Network request failed')
    )
    expect(message).toContain('no connection')
    expect(action).toBe('switch-brain')
  })

  it('keeps the API-key message that already says what to do', () => {
    expect(describeError(brainError('CLOUD_NO_API_KEY', 'whatever')).message).toContain(
      'EXPO_PUBLIC_CLOUD_LLM_API_KEY'
    )
  })

  it('says a spoken reply survived in the transcript', () => {
    const { message, action } = describeError(brainError('SPEAK_FAILED', 'no audio'))
    expect(message).toContain('transcript')
    expect(action).toBeUndefined()
  })

  describe('cloud HTTP statuses', () => {
    it('separates a rejected key from a rate limit from an outage', () => {
      expect(describeError(brainError('CLOUD_HTTP_401', '')).message).toContain(
        'rejected the API key'
      )
      expect(describeError(brainError('CLOUD_HTTP_429', '')).message).toContain('rate limited')
      expect(describeError(brainError('CLOUD_HTTP_503', '')).message).toContain('having trouble')
    })

    it('names the status for anything else, since there is nothing to suggest', () => {
      const { message, action } = describeError(brainError('CLOUD_HTTP_400', ''))
      expect(message).toContain('HTTP 400')
      expect(action).toBeUndefined()
    })
  })

  describe('what it does not recognise', () => {
    it('keeps the message of an unknown code rather than inventing one', () => {
      // The message is the only thing left to debug with once it is on screen.
      expect(
        describeError(brainError('SOMETHING_NEW', 'the node did a strange thing')).message
      ).toBe('the node did a strange thing')
    })

    it('keeps the message of an untagged error', () => {
      expect(describeError(new Error('Network request failed')).message).toBe(
        'Network request failed'
      )
    })

    it('falls back to something rather than an empty banner', () => {
      expect(describeError(new Error('')).message).toBe('Something went wrong.')
      expect(describeError(undefined).message).toBe('Something went wrong.')
    })
  })
})
