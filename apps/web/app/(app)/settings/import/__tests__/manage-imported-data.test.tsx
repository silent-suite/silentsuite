import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// "Manage imported data" offers Delete only on collections this user
// administers: deleting a shared one would remove it for its owner and every
// member. Etebase access: 0 read-only, 1 admin, 2 read/write.

const { lists, selectorStore } = vi.hoisted(() => {
  const lists = {
    calendars: [
      { id: 'cal-own', name: 'Own calendar', color: '#111111', visible: true, accessLevel: 1 },
      { id: 'cal-shared', name: 'Shared calendar', color: '#222222', visible: true, accessLevel: 2 },
    ],
    taskLists: [
      { id: 'tasks-own', name: 'Own tasks', color: '#333333', visible: true, accessLevel: 1 },
      { id: 'tasks-shared', name: 'Shared tasks', color: '#444444', visible: true, accessLevel: 2 },
    ],
    contactLists: [
      { id: 'contacts-own', name: 'Own contacts', color: '#555555', visible: true, accessLevel: 1 },
      { id: 'contacts-shared', name: 'Shared contacts', color: '#666666', visible: true, accessLevel: 0 },
    ],
  }

  function selectorStore<T extends object>(state: T) {
    return <R,>(selector: (s: T) => R) => selector(state)
  }
  return { lists, selectorStore }
})

vi.mock('@/app/components/import/CalendarImport', () => ({ default: () => null }))
vi.mock('@/app/components/import/TaskImport', () => ({ default: () => null }))
vi.mock('@/app/components/import/ContactImport', () => ({ default: () => null }))
vi.mock('@/app/stores/use-calendar-list-store', () => ({ useCalendarListStore: selectorStore({ calendars: lists.calendars }) }))
vi.mock('@/app/stores/use-calendar-store', () => ({ useCalendarStore: selectorStore({ events: [] }) }))
vi.mock('@/app/stores/use-task-list-store', () => ({ useTaskListStore: selectorStore({ lists: lists.taskLists }) }))
vi.mock('@/app/stores/use-task-store', () => ({ useTaskStore: selectorStore({ tasks: [] }) }))
vi.mock('@/app/stores/use-contact-list-store', () => ({ useContactListStore: selectorStore({ lists: lists.contactLists }) }))
vi.mock('@/app/stores/use-contact-store', () => ({ useContactStore: selectorStore({ contacts: [] }) }))
vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: selectorStore({ deleteCollection: vi.fn(), deleteItemsInCollection: vi.fn() }),
}))

import ImportPage from '../page'

describe('Manage imported data', () => {
  it('offers Delete only on collections this user administers', () => {
    render(<ImportPage />)

    expect(screen.getAllByRole('button', { name: /^Delete calendar$/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Delete task list$/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Delete address book$/ })).toHaveLength(1)
    for (const name of ['Own calendar', 'Own tasks', 'Own contacts']) {
      const row = screen.getByText(name).closest('div.rounded-md') as HTMLElement
      expect(row.textContent).toMatch(/Delete (calendar|task list|address book)/)
    }
    for (const name of ['Shared calendar', 'Shared tasks', 'Shared contacts']) {
      const row = screen.getByText(name).closest('div.rounded-md') as HTMLElement
      expect(row.textContent).not.toMatch(/Delete (calendar|task list|address book)/)
    }
  })
})
