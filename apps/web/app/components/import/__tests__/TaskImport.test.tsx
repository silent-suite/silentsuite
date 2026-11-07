import { describe, it, expect, beforeEach, onTestFinished, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import TaskImport from '../TaskImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { parseVTodo } from '@silentsuite/core/utils/ical-parser'
import type { VTodo } from '@silentsuite/core/utils/ical-parser'
import { taskICalDateFromProperty } from '@silentsuite/core'
import type { NewTask } from '@/app/stores/use-task-store'
import { ImportIncompleteError } from '@/app/lib/import-outcome'

const mocks = vi.hoisted(() => ({
  importTasks: vi.fn(),
  createCollection: vi.fn(),
  onImportComplete: vi.fn(),
}))

vi.mock('@silentsuite/core/utils/ical-parser', () => ({
  parseVTodo: vi.fn((ical: string): VTodo => {
    void ical
    return {
      uid: 'vt-1',
      summary: 'Review PR',
      categories: [' Work ', 'work', 'Home'],
    }
  }),
}))

vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: function useTaskStore<T>(selector: (state: {
    importTasks: typeof mocks.importTasks
  }) => T): T {
    return selector({ importTasks: mocks.importTasks })
  },
}))

vi.mock('@/app/stores/use-task-list-store', () => ({
  useTaskListStore: function useTaskListStore<T>(selector: (state: {
    lists: { id: string; name: string; color: string; visible: boolean }[]
    activeListId: string
  }) => T): T {
    return selector({
      lists: [{ id: 'default', name: 'Default', color: '#10b981', visible: true }],
      activeListId: 'default',
    })
  },
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: function useEtebaseStore<T>(selector: (state: {
    createCollection: typeof mocks.createCollection
  }) => T): T {
    return selector({ createCollection: mocks.createCollection })
  },
}))

describe('TaskImport categories normalization', () => {
  beforeEach(() => {
    mocks.importTasks.mockReset().mockResolvedValue(1)
    mocks.createCollection.mockReset()
    mocks.onImportComplete.mockReset()
  })

  it('normalizes categories in the built import payload', async () => {
    const { container } = renderWithIntl(<TaskImport onImportComplete={mocks.onImportComplete} />)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(
      ['BEGIN:VTODO\nSUMMARY:Review PR\nEND:VTODO'],
      'tasks.ics',
      { type: 'text/calendar' },
    )
    fireEvent.change(input, { target: { files: [file] } })

    const importButton = await screen.findByRole('button', { name: /Import 1 tasks/ })
    fireEvent.click(importButton)

    await waitFor(() => {
      expect(mocks.importTasks).toHaveBeenCalledTimes(1)
    })

    const payload = mocks.importTasks.mock.calls[0]![0] as Array<{ categories: string[] }>
    expect(payload[0]!.categories).toEqual(['Work', 'Home'])
  })
})

describe('TaskImport keeps source DTSTART and DUE identity (#66)', () => {
  beforeEach(() => {
    mocks.importTasks.mockReset().mockResolvedValue(1)
    mocks.onImportComplete.mockReset()
  })

  async function importParsed(todo: VTodo) {
    vi.mocked(parseVTodo).mockReturnValueOnce(todo)
    const { container } = renderWithIntl(<TaskImport onImportComplete={mocks.onImportComplete} />)
    const file = new File(['BEGIN:VTODO\nSUMMARY:Zoned\nEND:VTODO'], 'tasks.ics', { type: 'text/calendar' })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 tasks/ }))
    await waitFor(() => expect(mocks.importTasks).toHaveBeenCalledTimes(1))
    return (mocks.importTasks.mock.calls[0]![0] as NewTask[])[0]!
  }

  it('maps independently zoned DTSTART and DUE through the shared classifier', async () => {
    const payload = await importParsed({
      uid: 'zoned',
      summary: 'Zoned',
      dtstart: '20260530T080000',
      dtstartParams: { TZID: 'Europe/Berlin' },
      due: '20260601T090000',
      dueParams: { TZID: 'America/New_York' },
    })

    const start = taskICalDateFromProperty('20260530T080000', { TZID: 'Europe/Berlin' })
    const due = taskICalDateFromProperty('20260601T090000', { TZID: 'America/New_York' })
    expect(payload).toMatchObject({ start_date: start.date, start_ical: start.source, due_date: due.date, due_ical: due.source })
    expect(payload.due_date!.toISOString()).toBe('2026-06-01T13:00:00.000Z')
    expect(payload.start_ical).toEqual({ kind: 'tzid', value: '20260530T080000', tzid: 'Europe/Berlin' })
  })

  it('keeps a date-only DUE as the same local day', async () => {
    const payload = await importParsed({ uid: 'dated', summary: 'Dated', due: '20260601', dueParams: { VALUE: 'DATE' } })

    expect(payload.due_date).toEqual(new Date(2026, 5, 1))
    expect(payload.due_ical).toEqual({ kind: 'date', value: '20260601' })
    expect(payload.start_date).toBeNull()
  })
})

describe('TaskImport CSV quoted fields across line breaks', () => {
  const HEADER = 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT'
  const SECTION = 'section,Section name,,,,,,,,,,'
  const LATER = 'completed,Later task,"After, with comma",1,2,me,,Oct 16 2025,,,,'
  const cases = (['\n', '\r\n'] as const).flatMap((eol) => {
    const label = eol === '\n' ? 'LF' : 'CRLF'
    return [
      {
        name: `${label}: quoted-comma control`,
        eol,
        record: 'task,"Buy eggs, milk","Note, with comma",2,1,me,,Oct 15 2025,,,,',
        title: 'Buy eggs, milk',
        description: 'Note, with comma',
      },
      {
        name: `${label}: multiline summary`,
        eol,
        record: `task,"Line one${eol}Line two",,2,1,me,,Oct 15 2025,,,,`,
        title: `Line one${eol}Line two`,
        description: '',
      },
      {
        name: `${label}: multiline description with escaped quotes`,
        eol,
        record: `task,Plain task,"Desc one${eol}Desc ""two""${eol}Desc three",2,1,me,,Oct 15 2025,,,,`,
        title: 'Plain task',
        description: `Desc one${eol}Desc "two"${eol}Desc three`,
      },
    ]
  })

  beforeEach(() => {
    mocks.importTasks.mockReset().mockResolvedValue(2)
    mocks.createCollection.mockReset()
    mocks.onImportComplete.mockReset()
  })

  it.each(cases)('$name', async ({ eol, record, title, description }) => {
    const { container } = renderWithIntl(<TaskImport onImportComplete={mocks.onImportComplete} />)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const csv = [HEADER, record, SECTION, LATER].join(eol) + eol
    const file = new File([csv], 'todoist.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [file] } })

    const found = await screen.findByText(/^\d+ tasks found$/)
    const preview = {
      count: found.textContent,
      titles: Array.from(found.nextElementSibling!.children, (row) => row.firstElementChild?.textContent),
    }

    fireEvent.click(screen.getByRole('button', { name: /^Import \d+ tasks$/ }))
    await waitFor(() => {
      expect(mocks.importTasks).toHaveBeenCalledTimes(1)
    })

    const payload = (mocks.importTasks.mock.calls[0]![0] as Array<{
      title: string
      description: string
      due_date: Date | null
      priority: string
      completed: boolean
    }>).map(({ title, description, due_date, priority, completed }) => ({
      title, description, due_date, priority, completed,
    }))

    expect({ preview, payload }).toEqual({
      preview: { count: '2 tasks found', titles: [title, 'Later task'] },
      payload: [
        { title, description, due_date: new Date(2025, 9, 15), priority: 'medium', completed: false },
        { title: 'Later task', description: 'After, with comma', due_date: new Date(2025, 9, 16), priority: 'urgent', completed: true },
      ],
    })
  })
})

// C3a-R5 (PLAN U1, U2, U4). The store outcome is controlled here to isolate the recovery UI;
// the store contract itself is proven against the pinned SDK in use-task-store.test.ts.
describe('C3a-R5 TaskImport reports only acknowledged tasks and keeps the rest for retry', () => {
  // The real Todoist CSV path (this file mocks the iCal parser), so each task keeps its own title.
  const csv = (titles: string[]) => new File([['TYPE,CONTENT', ...titles.map((title) => `task,${title}`)].join('\n')], 'todoist.csv', { type: 'text/csv' })
  const caveat = /may already be saved/i
  const payloadTitles = (call: number) => (mocks.importTasks.mock.calls[call]![0] as { title: string }[]).map(({ title }) => title)

  beforeEach(() => {
    mocks.importTasks.mockReset()
    mocks.onImportComplete.mockReset()
  })

  async function previewTasks(titles: string[]) {
    const { container } = renderWithIntl(<TaskImport onImportComplete={mocks.onImportComplete} />)
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [csv(titles)] } })
    return screen.findByRole('button', { name: `Import ${titles.length} tasks` })
  }

  it('C3a-R5 tasks: a partial unconfirmed import reports the acknowledged count, warns before retry, and retries only the rest', async () => {
    mocks.importTasks
      .mockRejectedValueOnce(new ImportIncompleteError(1, [1], true))
      .mockResolvedValueOnce(1)
    fireEvent.click(await previewTasks(['First task', 'Second task']))

    const message = await screen.findByText(/Imported 1 of 2 tasks/)
    expect(message.textContent).toMatch(/(weren't|were not) confirmed as saved/i)
    expect(message.textContent).toMatch(caveat)
    expect(screen.queryByText(/tasks imported/)).toBeNull()
    expect(mocks.onImportComplete).not.toHaveBeenCalled()

    // Only the unacknowledged original record stays previewed and importable.
    const retry = screen.getByRole('button', { name: 'Import 1 tasks' })
    expect(screen.queryByText('First task')).toBeNull()
    expect(screen.getByText('Second task')).toBeInTheDocument()

    fireEvent.click(retry)
    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(1))
    expect(payloadTitles(1)).toEqual(['Second task'])
    expect(screen.getByText('1 tasks imported')).toBeInTheDocument()
    expect(screen.queryByText(/Imported 1 of 2 tasks/)).toBeNull()
  })

  it('C3a-R5 tasks: an unconfirmed import with nothing acknowledged keeps every task and warns they may already be saved', async () => {
    mocks.importTasks.mockRejectedValueOnce(new ImportIncompleteError(0, [0, 1], true))
    fireEvent.click(await previewTasks(['First task', 'Second task']))

    const message = await screen.findByText(/Imported 0 of 2 tasks/)
    expect(message.textContent).toMatch(caveat)
    expect(screen.getByRole('button', { name: 'Import 2 tasks' })).toBeInTheDocument()
    expect(screen.getByText('First task')).toBeInTheDocument()
    expect(screen.getByText('Second task')).toBeInTheDocument()
    expect(mocks.onImportComplete).not.toHaveBeenCalled()
  })

  it('C3a-R5 tasks: an import that sent nothing says none were saved, without the may-already-be-saved caveat', async () => {
    mocks.importTasks.mockRejectedValueOnce(new ImportIncompleteError(0, [0, 1], false))
    fireEvent.click(await previewTasks(['First task', 'Second task']))

    const message = await screen.findByText(/None of the 2 tasks were saved/i)
    expect(message.textContent).not.toMatch(caveat)
    expect(screen.getByRole('button', { name: 'Import 2 tasks' })).toBeInTheDocument()
    expect(screen.getByText('First task')).toBeInTheDocument()
    expect(screen.getByText('Second task')).toBeInTheDocument()
    expect(mocks.onImportComplete).not.toHaveBeenCalled()
  })

  it('C3a-R5 tasks: a file chosen while an import is pending is refused, so the failed import keeps its own file, preview and retry', async () => {
    let rejectPending!: (reason: unknown) => void
    mocks.importTasks
      .mockImplementationOnce(() => new Promise<number>((_, reject) => { rejectPending = reject }))
      .mockResolvedValueOnce(1)
    // Never leave the deferred import pending, even when an assertion fails first.
    onTestFinished(() => rejectPending?.(new Error('settled at test end')))
    const { container } = renderWithIntl(<TaskImport onImportComplete={mocks.onImportComplete} />)
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [csv(['First task', 'Second task'])] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 tasks' }))
    await waitFor(() => expect(mocks.importTasks).toHaveBeenCalledTimes(1))

    // Another file while the first import is still pending, given time to be read if it were accepted.
    const replacement = new File(['TYPE,CONTENT\ntask,Replacement task'], 'replacement.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [replacement] } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(screen.queryByText('replacement.csv')).toBeNull()
    expect(screen.getByText('todoist.csv')).toBeInTheDocument()
    expect(screen.queryByText('Replacement task')).toBeNull()
    expect(screen.getByText('First task')).toBeInTheDocument()

    await act(async () => { rejectPending(new ImportIncompleteError(1, [1], true)) })
    await screen.findByText(/Imported 1 of 2 tasks/)
    expect(screen.getByText('todoist.csv')).toBeInTheDocument()
    expect(screen.queryByText('Replacement task')).toBeNull()
    expect(screen.getByText('Second task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 tasks' }))
    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(1))
    expect(payloadTitles(1)).toEqual(['Second task'])
    expect(mocks.importTasks).toHaveBeenCalledTimes(2)
  })

  it('C3a-R5 tasks control: after an import settles, choosing another file still replaces the file, preview and retry', async () => {
    mocks.importTasks
      .mockRejectedValueOnce(new ImportIncompleteError(1, [1], true))
      .mockResolvedValueOnce(1)
    const { container } = renderWithIntl(<TaskImport onImportComplete={mocks.onImportComplete} />)
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [csv(['First task', 'Second task'])] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 tasks' }))
    await screen.findByText(/Imported 1 of 2 tasks/)

    const replacement = new File(['TYPE,CONTENT\ntask,Replacement task'], 'replacement.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [replacement] } })
    await screen.findByText('Replacement task')
    expect(screen.queryByText('Second task')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 tasks' }))

    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(1))
    expect(payloadTitles(1)).toEqual(['Replacement task'])
    expect(screen.getByText('replacement.csv')).toBeInTheDocument()
    expect(screen.queryByText(/Imported 1 of 2 tasks/)).toBeNull()
  })

  it('C3a-R5 tasks: a fully acknowledged import still reports its true count', async () => {
    mocks.importTasks.mockResolvedValueOnce(2)
    fireEvent.click(await previewTasks(['First task', 'Second task']))

    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(2))
    expect(screen.getByText('2 tasks imported')).toBeInTheDocument()
    expect(payloadTitles(0)).toEqual(['First task', 'Second task'])
  })
})
