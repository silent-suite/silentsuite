import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const updateCollectionMeta = vi.fn()

const mockTaskListState = {
  lists: [
    { id: 'tasks-1', name: 'Work Tasks', color: '#3b82f6', visible: true },
    { id: 'tasks-2', name: 'Home Tasks', color: '#10b981', visible: false },
  ],
  activeListId: 'tasks-1',
  toggleVisibility: vi.fn(),
  setActiveList: vi.fn(),
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
    mockTaskListState.toggleVisibility.mockClear()
    mockTaskListState.setActiveList.mockClear()
  })

  it('persists task-list color changes through collection metadata', () => {
    render(<TaskListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Tasks actions'))
    const colorInput = screen.getByLabelText('Change Work Tasks color')
    expect(colorInput).toHaveAttribute('type', 'color')

    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('tasks', 'tasks-1', { color: '#ff0000' })
  })

  it('renames task lists through collection metadata', () => {
    render(<TaskListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Tasks actions'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByLabelText('Rename Work Tasks')

    fireEvent.change(input, { target: { value: 'Client Tasks' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateCollectionMeta).toHaveBeenCalledWith('tasks', 'tasks-1', { name: 'Client Tasks' })
  })

  it('sets hidden task lists as default and makes them visible', () => {
    render(<TaskListPanel />)

    fireEvent.click(screen.getByLabelText('Open Home Tasks actions'))
    fireEvent.click(screen.getByText('Set as default'))

    expect(mockTaskListState.toggleVisibility).toHaveBeenCalledWith('tasks-2')
    expect(mockTaskListState.setActiveList).toHaveBeenCalledWith('tasks-2')
  })
})
