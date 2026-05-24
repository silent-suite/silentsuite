import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const updateCollectionMeta = vi.fn()

const mockCalendarListState = {
  calendars: [
    { id: 'cal-1', name: 'Work Calendar', color: '#10b981', visible: true },
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
  })

  it('renders calendar color input and persists changes through collection metadata', () => {
    render(<CalendarListPanel />)

    const colorInput = screen.getByLabelText('Change Work Calendar color')
    expect(colorInput).toHaveAttribute('type', 'color')

    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('calendar', 'cal-1', { color: '#ff0000' })
  })
})
