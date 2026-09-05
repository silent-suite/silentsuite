import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// Mock the three collection panels so the sheet is tested in isolation.
vi.mock('../CalendarListPanel', () => ({
  CalendarListPanel: () => <div data-testid="cal-panel">calendar</div>,
}))
vi.mock('../TaskListPanel', () => ({
  TaskListPanel: () => <div data-testid="task-panel">tasks</div>,
}))
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
