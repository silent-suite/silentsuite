import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Mock the three collection panels so the sheet is tested in isolation.
vi.mock('../CalendarListPanel', () => ({
  CalendarListPanel: () => <div data-testid="cal-panel">calendar</div>,
}))
vi.mock('../TaskListPanel', () => {
  const { useState } = require('react') as typeof import('react')
  return {
    TaskListPanel: () => {
      const [menuOpen, setMenuOpen] = useState(false)
      return (
        <div data-testid="task-panel">
          tasks
          <input aria-label="Rename task list" />
          <button type="button" onClick={() => setMenuOpen(true)}>Open row menu</button>
          {menuOpen ? (
            <div role="menu">
              <button type="button" role="menuitem">Rename</button>
            </div>
          ) : null}
        </div>
      )
    },
  }
})
vi.mock('../ContactListPanel', () => ({
  ContactListPanel: () => <div data-testid="contact-panel">contacts</div>,
}))
vi.mock('../NotebookListPanel', () => ({
  NotebookListPanel: () => <div data-testid="note-panel">notes</div>,
}))

import { MobileCollectionSheet } from '../MobileCollectionSheet'

describe('MobileCollectionSheet', () => {
  it('renders the calendar panel when open with type "calendar"', () => {
    render(<MobileCollectionSheet type="calendar" open onClose={() => {}} />)
    expect(screen.getByTestId('cal-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('contact-panel')).not.toBeInTheDocument()
  })

  it('renders the task panel when open with type "tasks"', () => {
    render(<MobileCollectionSheet type="tasks" open onClose={() => {}} />)
    expect(screen.getByTestId('task-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('cal-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('contact-panel')).not.toBeInTheDocument()
  })

  it('renders the contact panel when open with type "contacts"', () => {
    render(<MobileCollectionSheet type="contacts" open onClose={() => {}} />)
    expect(screen.getByTestId('contact-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('cal-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('note-panel')).not.toBeInTheDocument()
  })

  it('renders the notebook panel when open with type "notes"', () => {
    render(<MobileCollectionSheet type="notes" open onClose={() => {}} />)
    expect(screen.getByTestId('note-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('cal-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('contact-panel')).not.toBeInTheDocument()
  })

  it('renders the Collections header and close button when open', () => {
    render(<MobileCollectionSheet type="calendar" open onClose={() => {}} />)
    expect(screen.getByText('Collections')).toBeInTheDocument()
    expect(screen.getByLabelText('Close collections')).toBeInTheDocument()
  })

  it('renders into the body above the bottom nav and pads for the safe area', () => {
    const { container } = render(<MobileCollectionSheet type="notes" open onClose={() => {}} />)
    const sheet = screen.getByRole('dialog', { name: 'Collections' })
    const backdrop = sheet.previousElementSibling!
    // The page's main element is a stacking context, so the sheet must leave it
    // (portal) and outrank the z-50 bottom nav to be visible and tappable.
    expect(container.contains(sheet)).toBe(false)
    expect(sheet.parentElement).toBe(document.body)
    expect(sheet.className).toContain('z-[60]')
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop.className).toContain('z-[60]')
    expect(sheet.className).toContain('pb-[env(safe-area-inset-bottom)]')
    // vh is the baseline; dvh only where the engine supports it, so older engines still get a height cap.
    expect(sheet.className).toContain('max-h-[80vh]')
    expect(sheet.className).toContain('supports-[height:1dvh]:max-h-[80dvh]')
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    render(<MobileCollectionSheet type="calendar" open onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close collections'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <MobileCollectionSheet type="calendar" open={false} onClose={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('MobileCollectionSheet keyboard ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0))
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function Harness({ startOpen = false }: { startOpen?: boolean }) {
    const [open, setOpen] = useState(startOpen)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open collections</button>
        <MobileCollectionSheet type="tasks" open={open} onClose={() => setOpen(false)} />
      </>
    )
  }

  it('focuses Close collections when opened from a focused opener, and restores that opener on close', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open collections' })
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close collections' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Close collections' }))
    await waitFor(() => expect(opener).toHaveFocus())

    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close collections' })).toHaveFocus())
  })

  it('closes on Escape from a sheet control, but not from an input or an open menu', async () => {
    render(<Harness startOpen />)
    screen.getByRole('button', { name: 'Close collections' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Collections' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Open collections' }))
    screen.getByLabelText('Rename task list').focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Collections' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open row menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Collections' })).toBeInTheDocument()
  })

  it('wraps Tab inside the sheet and pulls outside focus back in', async () => {
    render(<Harness startOpen />)
    const close = screen.getByRole('button', { name: 'Close collections' })
    const last = screen.getByRole('button', { name: 'Open row menu' })

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()

    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()
  })

  it('keeps a focused rename field when only the close callback identity changes', async () => {
    const firstClose = vi.fn()
    const latestClose = vi.fn()
    const view = render(<MobileCollectionSheet type="tasks" open onClose={firstClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close collections' })).toHaveFocus())

    const rename = screen.getByLabelText('Rename task list')
    rename.focus()
    expect(rename).toHaveFocus()

    view.rerender(<MobileCollectionSheet type="tasks" open onClose={latestClose} />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(rename).toHaveFocus()

    screen.getByRole('button', { name: 'Close collections' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(latestClose).toHaveBeenCalledTimes(1)
    expect(firstClose).not.toHaveBeenCalled()
  })
})

// #295: the sheet moves focus to Close collections on the frame after it opens. If the user (or a
// nested confirmation's restore) has already put focus on a control inside the sheet by then, that
// late first-frame focus must not take it away.
describe('MobileCollectionSheet initial focus timing', () => {
  // Frames the sheet requests are held here instead of running, so the test decides when the
  // sheet's own first-frame callback runs.
  let pendingFrames: Map<number, FrameRequestCallback>
  let nextFrame: number

  beforeEach(() => {
    pendingFrames = new Map()
    nextFrame = 1
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const handle = nextFrame++
      pendingFrames.set(handle, callback)
      return handle
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      pendingFrames.delete(handle)
    })
  })

  afterEach(() => {
    pendingFrames.clear()
    vi.unstubAllGlobals()
  })

  it('keeps focus on a sheet field the user reached before the first frame runs', () => {
    render(<MobileCollectionSheet type="tasks" open onClose={() => {}} />)

    // Opening the sheet requested its initial-focus frame; it has not run yet.
    expect(pendingFrames.size).toBe(1)
    expect(screen.getByRole('button', { name: 'Close collections' })).not.toHaveFocus()

    const rename = screen.getByLabelText('Rename task list')
    rename.focus()
    expect(rename).toHaveFocus()

    // Now the sheet's own first-frame callback runs.
    const frames = [...pendingFrames.values()]
    pendingFrames.clear()
    act(() => {
      for (const frame of frames) frame(performance.now())
    })

    expect(rename).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Close collections' })).not.toHaveFocus()
  })
})
