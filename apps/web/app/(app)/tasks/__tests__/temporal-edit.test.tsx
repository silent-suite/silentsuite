import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deserializeTask, type Task } from '@silentsuite/core'
import TasksPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'

// #295: saving a task from the mobile editor must not rewrite dates the user did not touch.
// This renders the real Tasks page and editor on the real task store (updateTask and its date
// source handling) and checks the iCalendar text the store hands to the account layer, produced
// by the real core serializer. Only the account layer's updateItem, the label-usage index, the
// toast and sync stores and two layout-only components are replaced. No account, network or
// persistence is involved.

vi.mock('@/app/stores/use-toast-store', () => ({ showErrorToast: vi.fn() }))

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (state: { isOnline: boolean }) => unknown) => selector({ isOnline: true }),
}))

vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: () => null,
}))

const START_LINE = 'DTSTART;TZID=Europe/Berlin:20260530T080000'
const DUE_LINE = 'DUE;TZID=America/New_York:20260601T090000'

function vcalendar(lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SilentSuite//EN',
    'BEGIN:VTODO',
    'UID:timed-task',
    'SUMMARY:Timed task',
    'DESCRIPTION:Original notes',
    ...lines,
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n')
}

/** A stored task as the real core parser reads it from iCalendar text. */
function seedTask(dateLines: string[]): Task {
  const task = { ...deserializeTask(vcalendar(dateLines)), listId: 'tasks-a' }
  useTaskStore.setState({ tasks: [task], syncStatus: 'synced' })
  return task
}

/** The account layer, reached with the task already known remotely: records what the store sends. */
function acknowledgedAccount() {
  const updateItem = vi.fn(async () => 'remote')
  useEtebaseStore.setState({ account: {}, itemCache: new Map([['timed-task', {}]]), updateItem } as never)
  return updateItem
}

/** Content lines of the iCalendar text, with folded continuation lines joined. */
function contentLines(content: string): string[] {
  return content.replace(/\r\n[ \t]/g, '').split('\r\n')
}

function openMobileEditor() {
  const mobileEdit = screen.getAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('md:hidden'))
  expect(mobileEdit, 'mobile Edit task button').toBeTruthy()
  fireEvent.click(mobileEdit!)
  return screen.getByRole('dialog', { name: 'Edit Task' })
}

async function saveAndReadContent(dialog: HTMLElement, updateItem: ReturnType<typeof acknowledgedAccount>) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1))
  const [type, id, content] = updateItem.mock.calls[0] as unknown as [string, string, string]
  expect([type, id]).toEqual(['tasks', 'timed-task'])
  return { content, lines: contentLines(content), saved: deserializeTask(content) }
}

describe('Mobile task editor keeps untouched dates (#295)', () => {
  let updateItem: ReturnType<typeof acknowledgedAccount>
  let patches: Array<Partial<Task>>

  beforeEach(() => {
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useEtebaseStore.setState((state) => ({ domainLoadState: { ...state.domainLoadState, tasks: 'loaded' } }))
    useAuthStore.setState({ canWrite: () => true } as never)
    useTaskListStore.setState({
      lists: [{ id: 'tasks-a', name: 'Work', color: '#3b82f6', visible: true }],
      activeListId: 'tasks-a',
    })
    useTaskStore.setState(useTaskStore.getInitialState(), true)
    // The real updateTask, wrapped only to see which fields the editor sends.
    patches = []
    const realUpdateTask = useTaskStore.getState().updateTask
    useTaskStore.setState({
      updateTask: (id: string, patch: Partial<Task>) => {
        patches.push(patch)
        return realUpdateTask(id, patch)
      },
    })
    updateItem = acknowledgedAccount()
    // Label usage is recorded after a remote update; it is not part of the saved task text.
    useLabelSuggestionsStore.setState({ recordUsage: vi.fn(async () => {}) } as never)
  })

  it('keeps both timed, zoned dates exactly when only the title changes', async () => {
    const original = seedTask([START_LINE, DUE_LINE])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    fireEvent.change(within(dialog).getByPlaceholderText('Task title'), { target: { value: 'Renamed task' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(lines).toContain('SUMMARY:Renamed task')
    expect(lines).toContain(START_LINE)
    expect(lines).toContain(DUE_LINE)
    expect(saved.start_ical).toEqual(original.start_ical)
    expect(saved.due_ical).toEqual(original.due_ical)
    expect(patches[0]).not.toHaveProperty('listId')
  })

  it('keeps both timed, zoned dates exactly when only the notes change', async () => {
    const original = seedTask([START_LINE, DUE_LINE])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    fireEvent.change(within(dialog).getByPlaceholderText('Add notes...'), { target: { value: 'New notes' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(lines).toContain('DESCRIPTION:New notes')
    expect(lines).toContain(START_LINE)
    expect(lines).toContain(DUE_LINE)
    expect(saved.start_ical).toEqual(original.start_ical)
    expect(saved.due_ical).toEqual(original.due_ical)
  })

  it('changes only the due date to the picked day and keeps the start time and zone', async () => {
    const original = seedTask([START_LINE, DUE_LINE])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    fireEvent.change(within(dialog).getByLabelText('Due date'), { target: { value: '2026-06-05' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(lines).toContain(START_LINE)
    expect(saved.start_ical).toEqual(original.start_ical)
    expect(lines).not.toContain(DUE_LINE)
    expect(saved.due_ical).toEqual({ kind: 'date', value: '20260605' })
  })

  it('clears only the due date and keeps the start time and zone', async () => {
    const original = seedTask([START_LINE, DUE_LINE])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    fireEvent.change(within(dialog).getByLabelText('Due date'), { target: { value: '' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(lines).toContain(START_LINE)
    expect(saved.start_ical).toEqual(original.start_ical)
    expect(lines.some((line) => line.startsWith('DUE'))).toBe(false)
    expect(saved.due_date).toBeNull()
  })

  it('changes only the start date to the picked day and keeps the due time and zone', async () => {
    const original = seedTask([START_LINE, DUE_LINE])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '2026-05-25' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(lines).toContain(DUE_LINE)
    expect(saved.due_ical).toEqual(original.due_ical)
    expect(lines).not.toContain(START_LINE)
    expect(saved.start_ical).toEqual({ kind: 'date', value: '20260525' })
  })

  it('clears only the start date and keeps the due time and zone', async () => {
    const original = seedTask([START_LINE, DUE_LINE])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(lines).toContain(DUE_LINE)
    expect(saved.due_ical).toEqual(original.due_ical)
    expect(lines.some((line) => line.startsWith('DTSTART'))).toBe(false)
    expect(saved.start_date ?? null).toBeNull()
  })

  it('keeps a date that was changed and then set back to its original day', async () => {
    const original = seedTask([START_LINE, DUE_LINE])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    const due = within(dialog).getByLabelText<HTMLInputElement>('Due date')
    const shownDay = due.value
    fireEvent.change(due, { target: { value: '2026-06-05' } })
    fireEvent.change(due, { target: { value: shownDay } })
    fireEvent.change(within(dialog).getByPlaceholderText('Task title'), { target: { value: 'Renamed task' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(lines).toContain(START_LINE)
    expect(lines).toContain(DUE_LINE)
    expect(saved.start_ical).toEqual(original.start_ical)
    expect(saved.due_ical).toEqual(original.due_ical)
  })

  it('leaves a date-only start and a missing due date as they were on a title-only save', async () => {
    seedTask(['DTSTART;VALUE=DATE:20260530'])
    renderWithIntl(<TasksPage />)
    const dialog = openMobileEditor()

    fireEvent.change(within(dialog).getByPlaceholderText('Task title'), { target: { value: 'Renamed task' } })
    const { lines, saved } = await saveAndReadContent(dialog, updateItem)

    expect(saved.start_ical).toEqual({ kind: 'date', value: '20260530' })
    expect(lines.some((line) => line.startsWith('DUE'))).toBe(false)
    expect(saved.due_date).toBeNull()
  })
})
