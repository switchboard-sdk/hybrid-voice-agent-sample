import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react-native'

import { PromptScreen } from './PromptScreen'
import { TRAVEL_PROFILE } from '../profiles'

const BRIEF = 'You are the voice of a bicycle repair shop.'

const renderEditor = (initialBrief = TRAVEL_PROFILE.brief) => {
  const onSave = jest.fn()
  const onCancel = jest.fn()
  render(<PromptScreen initialBrief={initialBrief} onSave={onSave} onCancel={onCancel} />)
  return { onSave, onCancel, field: screen.getByLabelText('Agent brief') }
}

describe('PromptScreen', () => {
  it('opens on the brief it was given', () => {
    const { field } = renderEditor()

    expect(field.props.value).toBe(TRAVEL_PROFILE.brief)
  })

  it('hands back what was typed', () => {
    const { onSave, field } = renderEditor()

    fireEvent.changeText(field, BRIEF)
    fireEvent.press(screen.getByText('Save'))

    expect(onSave).toHaveBeenCalledWith(BRIEF)
  })

  it('discards the edit on cancel', () => {
    const { onSave, onCancel, field } = renderEditor()

    fireEvent.changeText(field, BRIEF)
    fireEvent.press(screen.getByText('Cancel'))

    expect(onCancel).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not offer to save an edit that changed nothing', () => {
    const { onSave } = renderEditor()

    fireEvent.press(screen.getByText('Save'))

    expect(onSave).not.toHaveBeenCalled()
  })

  // The app composes each prompt rather than sending the text verbatim, so it has
  // to be possible to read exactly what the model will get.
  it('shows the assembled prompt for either brain, on request', () => {
    const { field } = renderEditor()
    fireEvent.changeText(field, BRIEF)

    expect(screen.queryByLabelText('on-device prompt')).toBeNull()
    fireEvent.press(screen.getByText('On-device prompt'))

    const shown = screen.getByLabelText('on-device prompt').props.children
    expect(shown.startsWith(BRIEF)).toBe(true)
    expect(shown).toContain('one or two short sentences')
    expect(shown).toMatch(/offline/i)

    fireEvent.press(screen.getByText('Cloud prompt'))
    expect(screen.getByLabelText('cloud prompt').props.children).not.toMatch(/offline/i)
  })

  it('says what saving nothing will do', () => {
    const { field } = renderEditor()

    fireEvent.changeText(field, '   ')

    expect(screen.getByText(/goes back to the built-in agent/)).toBeTruthy()
  })
})
