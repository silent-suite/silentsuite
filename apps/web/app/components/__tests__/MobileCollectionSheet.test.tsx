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
  })

  it('renders the Collections header and close button when open', () => {
    render(<MobileCollectionSheet type="calendar" open onClose={() => {}} />)
    expect(screen.getByText('Collections')).toBeInTheDocument()
    expect(screen.getByLabelText('Close collections')).toBeInTheDocument()
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
