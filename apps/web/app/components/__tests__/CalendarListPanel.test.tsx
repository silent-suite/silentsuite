import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const updateCollectionMeta = vi.fn()

const mockCalendarListState = {
  calendars: [
    { id: 'cal-1', name: 'Work Calendar', color: '#10b981', visible: true },
    { id: 'cal-2', name: 'New Calendar', color: '#3b82f6', visible: false },
  ],
  defaultCalendarId: 'cal-1',
  toggleVisibility: vi.fn(),
  setDefaultCalendar: vi.fn(),
  getNextColor: vi.fn(() => '#3b82f6'),
}

const mockEtebaseState = {
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  updateCollectionMeta,
}

vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: () => mockCalendarListState,
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: <T,>(selector: (s: typeof mockEtebaseState) => T) => selector(mockEtebaseState),
}))

import { CalendarListPanel } from '../CalendarListPanel'

describe('CalendarListPanel', () => {
  beforeEach(() => {
    updateCollectionMeta.mockClear()
    mockCalendarListState.toggleVisibility.mockClear()
    mockCalendarListState.setDefaultCalendar.mockClear()
  })

  it('persists calendar color changes through collection metadata', () => {
    render(<CalendarListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Calendar actions'))
    const colorInput = screen.getByLabelText('Change Work Calendar color')
    expect(colorInput).toHaveAttribute('type', 'color')

    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('calendar', 'cal-1', { color: '#ff0000' })
  })

  it('renames calendars through collection metadata', () => {
    render(<CalendarListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Calendar actions'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByLabelText('Rename Work Calendar')

    fireEvent.change(input, { target: { value: 'Client Calendar' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateCollectionMeta).toHaveBeenCalledWith('calendar', 'cal-1', { name: 'Client Calendar' })
  })

  it('sets hidden calendars as default and makes them visible', () => {
    render(<CalendarListPanel />)

    fireEvent.click(screen.getByLabelText('Open New Calendar actions'))
    fireEvent.click(screen.getByText('Set as default'))

    expect(mockCalendarListState.toggleVisibility).toHaveBeenCalledWith('cal-2')
    expect(mockCalendarListState.setDefaultCalendar).toHaveBeenCalledWith('cal-2')
  })
})
