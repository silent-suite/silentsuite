import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, Task } from '@silentsuite/core'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { CalendarSaveError, useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { planTask, SCHEDULED_LABEL } from '../plan-task'

const auth = vi.hoisted(() => ({ canWrite: vi.fn(() => true) }))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: { getState: () => ({ canWrite: auth.canWrite }) } }))

const START = new Date('2026-11-16T09:00:00Z')

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1', uid: 'task-uid-1', title: 'Write report', description: 'Draft section 2', due_date: null,
    priority: 'high', completed: false, status: 'needs-action', location: 'Office', url: 'https://example.com/r',
    categories: ['Work'], listId: 'list-a', created_at: new Date('2026-11-01T00:00:00Z'),
    updated_at: new Date('2026-11-02T00:00:00Z'), ...overrides,
  }
}

const createEvent = vi.fn()
const updateTask = vi.fn()
const deleteTask = vi.fn()

function acknowledged(): Promise<CalendarEvent> {
  return Promise.resolve({ id: 'server-item', uid: 'temp-uid' } as CalendarEvent)
}

beforeEach(() => {
  auth.canWrite.mockReturnValue(true)
  createEvent.mockReset().mockImplementation(acknowledged)
  updateTask.mockReset().mockResolvedValue(undefined)
  deleteTask.mockReset().mockResolvedValue(undefined)
  useTaskStore.setState({ tasks: [task()], updateTask, deleteTask })
  useCalendarStore.setState({ createEvent })
  useTaskListStore.setState({ lists: [{ id: 'list-a', name: 'Work', color: '#000', visible: true, accessLevel: 2 }] })
  useCalendarListStore.setState({
    calendars: [{ id: 'cal-a', name: 'Personal', color: '#10b981', visible: true, accessLevel: 2 }],
    defaultCalendarId: 'cal-a',
  })
})

describe('planTask', () => {
  it('creates a 30-minute event from the task, then labels it Scheduled keeping its labels', async () => {
    const result = await planTask('task-1', START, 'cal-a', 'label')
    expect(result.kind).toBe('done')
    expect(createEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: 'Write report',
      description: 'Draft section 2\n\nhttps://example.com/r',
      location: 'Office',
      categories: ['Work'],
      startDate: START,
      endDate: new Date('2026-11-16T09:30:00Z'),
      calendarId: 'cal-a',
    }))
    expect(updateTask).toHaveBeenCalledExactlyOnceWith('task-1', { categories: ['Work', SCHEDULED_LABEL] })
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it('marks the task completed when that is the chosen disposition', async () => {
    await planTask('task-1', START, 'cal-a', 'complete')
    expect(updateTask).toHaveBeenCalledExactlyOnceWith('task-1', { completed: true, status: 'completed', percent_complete: 100 })
  })

  it('deletes the task only after the event is acknowledged', async () => {
    await planTask('task-1', START, 'cal-a', 'delete')
    expect(createEvent.mock.invocationCallOrder[0]).toBeLessThan(deleteTask.mock.invocationCallOrder[0]!)
    expect(deleteTask).toHaveBeenCalledExactlyOnceWith('task-1')
  })

  it.each(['label', 'complete', 'delete'] as const)('leaves the task untouched when the event is only queued offline (%s)', async (disposition) => {
    createEvent.mockResolvedValue({ id: 'temp-uid', uid: 'temp-uid' })
    const result = await planTask('task-1', START, 'cal-a', disposition)
    expect(result).toMatchObject({ kind: 'done', message: expect.stringContaining('left unchanged') })
    expect(updateTask).not.toHaveBeenCalled()
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it.each([new CalendarSaveError(true), new CalendarSaveError(false), new Error('boom')])('leaves the task untouched when the event save fails', async (error) => {
    createEvent.mockRejectedValue(error)
    const result = await planTask('task-1', START, 'cal-a', 'delete')
    expect(result.kind).toBe('error')
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it.each([
    ['repeating', task({ unknownProperties: ['RRULE:FREQ=WEEKLY'] })],
    ['an occurrence', task({ unknownProperties: ['RECURRENCE-ID;VALUE=DATE:20261116'] })],
    ['completed', task({ completed: true, status: 'completed' })],
    ['cancelled', task({ status: 'cancelled' })],
  ])('rejects a %s task before creating an event', async (_label, blocked) => {
    useTaskStore.setState({ tasks: [blocked] })
    const result = await planTask('task-1', START, 'cal-a', 'delete')
    expect(result.kind).toBe('error')
    expect(createEvent).not.toHaveBeenCalled()
  })

  it('rejects tasks in read-only lists, read-only accounts and unknown calendars', async () => {
    useTaskListStore.setState({ lists: [{ id: 'list-a', name: 'Shared', color: '#000', visible: true, accessLevel: 0 }] })
    expect((await planTask('task-1', START, 'cal-a', 'label')).kind).toBe('error')
    useTaskListStore.setState({ lists: [{ id: 'list-a', name: 'Work', color: '#000', visible: true, accessLevel: 2 }] })
    expect((await planTask('task-1', START, 'missing', 'label')).kind).toBe('error')
    auth.canWrite.mockReturnValue(false)
    expect((await planTask('task-1', START, 'cal-a', 'label')).kind).toBe('error')
    expect(createEvent).not.toHaveBeenCalled()
  })

  it('keeps labels added while the event was saving', async () => {
    let confirm!: (event: CalendarEvent) => void
    createEvent.mockImplementation(() => new Promise((resolve) => { confirm = resolve }))
    const pending = planTask('task-1', START, 'cal-a', 'label')
    useTaskStore.setState({ tasks: [task({ categories: ['Work', 'Urgent'], updated_at: new Date('2026-11-15T00:00:00Z') })] })
    confirm({ id: 'server-item', uid: 'temp-uid' } as CalendarEvent)
    await pending
    expect(updateTask).toHaveBeenCalledExactlyOnceWith('task-1', { categories: ['Work', 'Urgent', SCHEDULED_LABEL] })
  })

  it('does not delete a task that was edited while the event was saving', async () => {
    let confirm!: (event: CalendarEvent) => void
    createEvent.mockImplementation(() => new Promise((resolve) => { confirm = resolve }))
    const pending = planTask('task-1', START, 'cal-a', 'delete')
    useTaskStore.setState({ tasks: [task({ description: 'Newer notes', updated_at: new Date('2026-11-15T00:00:00Z') })] })
    confirm({ id: 'server-item', uid: 'temp-uid' } as CalendarEvent)
    const result = await pending
    expect(result.message).toContain('edited meanwhile')
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it('does not change the task after an account switch', async () => {
    let confirm!: (event: CalendarEvent) => void
    createEvent.mockImplementation(() => new Promise((resolve) => { confirm = resolve }))
    const pending = planTask('task-1', START, 'cal-a', 'complete')
    bumpAccountEpoch()
    confirm({ id: 'server-item', uid: 'temp-uid' } as CalendarEvent)
    expect((await pending).kind).toBe('error')
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('ignores a second placement of the same task while the first is saving', async () => {
    let confirm!: (event: CalendarEvent) => void
    createEvent.mockImplementation(() => new Promise((resolve) => { confirm = resolve }))
    const first = planTask('task-1', START, 'cal-a', 'label')
    expect((await planTask('task-1', START, 'cal-a', 'label')).kind).toBe('error')
    confirm({ id: 'server-item', uid: 'temp-uid' } as CalendarEvent)
    await first
    expect(createEvent).toHaveBeenCalledTimes(1)
  })

  it('reports a task update failure after the event was added', async () => {
    updateTask.mockRejectedValue(new Error('read-only'))
    const result = await planTask('task-1', START, 'cal-a', 'complete')
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('could not be updated') })
  })
})
