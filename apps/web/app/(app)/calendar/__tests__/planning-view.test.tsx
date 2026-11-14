import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Task } from '@silentsuite/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CalendarPage from '../calendar-workspace'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'
import { usePreferencesSyncStore } from '@/app/stores/use-preferences-sync-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import type { SlotClickEvent } from '../components/CalendarGrid'

const grid = vi.hoisted(() => ({ props: undefined as undefined | {
  onSlotClick?: (slot: SlotClickEvent) => void
  externalDragType?: string
  onExternalDrop?: (start: Date, dataTransfer: DataTransfer) => void
} }))
const plan = vi.hoisted(() => ({ planTask: vi.fn() }))

vi.mock('../components/CalendarGrid', () => ({
  CalendarGrid: (props: typeof grid.props & { displayView?: string }) => {
    if (!props?.displayView) grid.props = props
    return <div data-testid={props?.displayView ? 'mobile-grid' : 'desktop-grid'} />
  },
}))
vi.mock('../lib/plan-task', async (original) => ({ ...(await original<object>()), planTask: plan.planTask }))
vi.mock('../components/CalendarViewSwitcher', () => ({ CalendarViewSwitcher: () => null }))
vi.mock('../components/AgendaView', () => ({ AgendaView: () => null }))
vi.mock('../components/EventDialog', () => ({ EventDialog: ({ mode }: { mode: string }) => <div data-testid={`event-dialog-${mode}`} /> }))
vi.mock('../components/FloatingAddButton', () => ({ FloatingAddButton: () => null }))
vi.mock('@/app/components/PullToRefresh', () => ({ PullToRefresh: () => null }))
vi.mock('@/app/components/MobileCollectionSheet', () => ({ MobileCollectionSheet: () => null }))
vi.mock('@/app/lib/sync-timing', () => ({ logCalendarPaintTiming: vi.fn() }))
vi.mock('@/app/stores/use-auth-store', () => {
  const state = { canWrite: () => true, user: { email: 'a@example.test' } }
  const useAuthStore = (selector: (s: typeof state) => unknown) => selector(state)
  useAuthStore.getState = () => state
  return { useAuthStore }
})

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task', uid: 'task', title: 'Task', description: '', due_date: null, priority: 'medium', completed: false,
    status: 'needs-action', categories: [], listId: 'list-a', created_at: new Date(), updated_at: new Date(), ...overrides,
  }
}

beforeEach(() => {
  grid.props = undefined
  plan.planTask.mockReset().mockResolvedValue({ kind: 'done', message: 'Added' })
  localStorage.clear()
  usePreferencesSyncStore.setState({ status: 'ready' })
  useEtebaseStore.setState({ accountFingerprint: 'account-a', domainLoadState: { ...useEtebaseStore.getState().domainLoadState, calendar: 'loaded' } })
  useExperimentalStore.setState({ hydrated: true, planningAccounts: [], planningDispositions: {} })
  useCalendarStore.setState({ events: [], currentView: 'week', currentDate: new Date('2026-11-16T12:00:00Z'), searchQuery: '' })
  useCalendarListStore.setState({ calendars: [{ id: 'cal-a', name: 'Personal', color: '#10b981', visible: true, accessLevel: 2 }], defaultCalendarId: 'cal-a' })
  useTaskListStore.setState({ lists: [
    { id: 'list-a', name: 'Mine', color: '#000', visible: true, accessLevel: 2 },
    { id: 'list-hidden', name: 'Hidden', color: '#000', visible: false, accessLevel: 2 },
    { id: 'list-shared', name: 'Shared', color: '#000', visible: true, accessLevel: 0 },
  ] })
  useTaskStore.setState({ tasks: [
    task({ id: 'open', title: 'Open task' }),
    task({ id: 'done', title: 'Done task', completed: true, status: 'completed' }),
    task({ id: 'scheduled', title: 'Scheduled task', categories: ['Scheduled'] }),
    task({ id: 'hidden', title: 'Hidden-list task', listId: 'list-hidden' }),
    task({ id: 'shared', title: 'Shared task', listId: 'list-shared' }),
    task({ id: 'repeat', title: 'Repeating task', unknownProperties: ['RRULE:FREQ=DAILY'] }),
  ] })
})

describe('Planning view', () => {
  it('has no Plan button and accepts no drops while the experiment is off', () => {
    renderWithIntl(<CalendarPage />)
    expect(screen.queryByRole('button', { name: 'Plan' })).not.toBeInTheDocument()
    expect(grid.props?.onExternalDrop).toBeUndefined()
  })

  it('lists plannable open tasks beside the week grid and places dropped or armed tasks', async () => {
    useExperimentalStore.setState({ planningAccounts: ['account-a'], planningDispositions: { 'account-a': 'complete' } })
    renderWithIntl(<CalendarPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    const panel = screen.getByRole('complementary', { name: 'Tasks to plan' })
    expect(within(panel).getByText('Open task')).toBeInTheDocument()
    for (const hidden of ['Done task', 'Scheduled task', 'Hidden-list task']) expect(within(panel).queryByText(hidden)).not.toBeInTheDocument()
    expect(within(panel).getByText('This task list is read-only.')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Place Repeating task' })).toBeDisabled()
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Show tasks labelled/ }))
    expect(within(panel).getByText('Scheduled task')).toBeInTheDocument()

    const start = new Date('2026-11-16T09:30:00Z')
    act(() => grid.props!.onExternalDrop!(start, { getData: () => 'open' } as unknown as DataTransfer))
    await waitFor(() => expect(plan.planTask).toHaveBeenCalledWith('open', start, 'cal-a', 'complete'))

    fireEvent.click(within(panel).getByRole('button', { name: 'Place Open task' }))
    const slot = { startDate: new Date('2026-11-17T14:00:00Z'), endDate: new Date('2026-11-17T15:00:00Z'), allDay: false, position: { x: 0, y: 0 } }
    act(() => grid.props!.onSlotClick!(slot))
    await waitFor(() => expect(plan.planTask).toHaveBeenLastCalledWith('open', slot.startDate, 'cal-a', 'complete'))
    // An armed placement replaces the new-event dialog; the next click opens it again.
    expect(screen.queryByTestId('event-dialog-create')).not.toBeInTheDocument()
    act(() => grid.props!.onSlotClick!(slot))
    expect(screen.getByTestId('event-dialog-create')).toBeInTheDocument()
    expect(plan.planTask).toHaveBeenCalledTimes(2)
  })
})
