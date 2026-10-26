import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import TaskImport from '../TaskImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import type { VTodo } from '@silentsuite/core/utils/ical-parser'

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
