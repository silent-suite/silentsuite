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
