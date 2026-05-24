import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const updateCollectionMeta = vi.fn()

const mockTaskListState = {
  lists: [
    { id: 'tasks-1', name: 'Work Tasks', color: '#3b82f6', visible: true },
  ],
  toggleVisibility: vi.fn(),
  getNextColor: vi.fn(() => '#10b981'),
}

const mockEtebaseState = {
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  updateCollectionMeta,
}

vi.mock('@/app/stores/use-task-list-store', () => ({
  useTaskListStore: () => mockTaskListState,
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: <T,>(selector: (s: typeof mockEtebaseState) => T) => selector(mockEtebaseState),
}))

import { TaskListPanel } from '../TaskListPanel'

describe('TaskListPanel', () => {
  beforeEach(() => {
    updateCollectionMeta.mockClear()
  })

  it('renders task-list color input and persists changes through collection metadata', () => {
    render(<TaskListPanel />)

    const colorInput = screen.getByLabelText('Change Work Tasks color')
    expect(colorInput).toHaveAttribute('type', 'color')

    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('tasks', 'tasks-1', { color: '#ff0000' })
  })
})
