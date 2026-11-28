import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusTrap } from '../use-focus-trap'

function Dialog({ name, children }: { name: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  return (
    <div ref={ref} role="dialog" aria-label={name}>
      <button type="button">{name} first</button>
      {children}
      <button type="button">{name} last</button>
    </div>
  )
}

// Mirrors LabelEditor: suggestions are only rendered while the input is focused.
function LabelField() {
  const [focused, setFocused] = useState(false)
  return (
    <>
      <input aria-label="Labels" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      {focused && <button type="button">Suggestion</button>}
      <button type="button">After labels</button>
    </>
  )
}

function tab(shiftKey = false) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey })
}

describe('useFocusTrap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderOpen(ui: React.ReactElement) {
    const result = render(
      <>
        <button type="button">Background</button>
        {ui}
      </>,
    )
    // Let the auto-focus frame run so it does not move focus mid-test.
    act(() => {
      vi.runAllTimers()
    })
    return result
  }

  it('wraps from the last element to the first and back', () => {
    renderOpen(<Dialog name="Event" />)
    screen.getByText('Event last').focus()
    tab()
    expect(screen.getByText('Event first')).toHaveFocus()
    tab(true)
    expect(screen.getByText('Event last')).toHaveFocus()
  })

  it('brings focus back into the dialog when it is on the page body', () => {
    renderOpen(<Dialog name="Event" />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.body).toHaveFocus()

    tab()
    expect(screen.getByText('Event first')).toHaveFocus()

    ;(document.activeElement as HTMLElement).blur()
    tab(true)
    expect(screen.getByText('Event last')).toHaveFocus()
  })

  it('brings focus back from a background element', () => {
    renderOpen(<Dialog name="Event" />)
    screen.getByText('Background').focus()
    tab()
    expect(screen.getByText('Event first')).toHaveFocus()
  })

  it('continues after the label field when Tab lands on a suggestion that disappears', () => {
    renderOpen(
      <Dialog name="Event">
        <LabelField />
      </Dialog>,
    )
    const input = screen.getByLabelText('Labels')
    act(() => input.focus())
    const suggestion = screen.getByText('Suggestion')

    // jsdom has no default Tab action, so do what the browser does: move
    // focus to the next element. The input's blur removes that element and
    // focus falls to the page body.
    tab()
    act(() => suggestion.focus())
    expect(screen.queryByText('Suggestion')).toBeNull()
    expect(document.body).toHaveFocus()

    act(() => {
      vi.runAllTimers()
    })
    expect(screen.getByText('After labels')).toHaveFocus()
  })

  it('leaves Tab to the innermost dialog while one is open over another', () => {
    const { rerender } = renderOpen(<Dialog name="Event" />)
    rerender(
      <>
        <button type="button">Background</button>
        <Dialog name="Event" />
        <Dialog name="Scope" />
      </>,
    )
    act(() => {
      vi.runAllTimers()
    })

    screen.getByText('Scope last').focus()
    tab()
    expect(screen.getByText('Scope first')).toHaveFocus()

    // Once the inner dialog closes, the outer trap takes over again.
    rerender(
      <>
        <button type="button">Background</button>
        <Dialog name="Event" />
      </>,
    )
    ;(document.activeElement as HTMLElement | null)?.blur()
    tab()
    expect(screen.getByText('Event first')).toHaveFocus()
  })
})
