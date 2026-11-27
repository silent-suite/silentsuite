import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const updateCollectionMeta = vi.fn()

const mockTaskListState = {
  lists: [
    { id: 'tasks-1', name: 'Work Tasks', color: '#3b82f6', visible: true, accessLevel: 1 },
    { id: 'tasks-2', name: 'Home Tasks', color: '#10b981', visible: false, accessLevel: 2 },
  ],
  activeListId: 'tasks-1',
  toggleVisibility: vi.fn(),
  setActiveList: vi.fn(),
  getNextColor: vi.fn(() => '#10b981'),
}

const mockEtebaseState = {
  domainLoadState: { tasks: 'loaded' } as Record<string, string>,
  isInitialized: true,
  restoreBlocked: false,
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

  // WEB-14: on reload the store holds only the local "My Tasks" placeholder until the real lists load.
  it('shows a skeleton instead of the placeholder list while task lists load', () => {
    const realLists = mockTaskListState.lists
    mockTaskListState.lists = [{ id: 'default', name: 'My Tasks', color: '#3b82f6', visible: true }] as typeof realLists
    mockEtebaseState.domainLoadState = { tasks: 'unknown' }
    mockEtebaseState.isInitialized = false
    try {
      const view = render(<TaskListPanel />)
      expect(screen.getByRole('status', { name: 'Loading task lists' })).toBeInTheDocument()
      expect(screen.queryByText('My Tasks')).not.toBeInTheDocument()

      // Real list names replace the skeleton as soon as they arrive.
      mockTaskListState.lists = realLists
      view.rerender(<TaskListPanel />)
      expect(screen.queryByRole('status', { name: 'Loading task lists' })).not.toBeInTheDocument()
      expect(screen.getByText('Work Tasks')).toBeInTheDocument()

      // If initialization ends without real lists, the placeholder shows rather than a skeleton forever.
      mockTaskListState.lists = [{ id: 'default', name: 'My Tasks', color: '#3b82f6', visible: true }] as typeof realLists
      mockEtebaseState.isInitialized = true
      view.rerender(<TaskListPanel />)
      expect(screen.queryByRole('status', { name: 'Loading task lists' })).not.toBeInTheDocument()
      expect(screen.getByText('My Tasks')).toBeInTheDocument()
    } finally {
      mockTaskListState.lists = realLists
      mockEtebaseState.domainLoadState = { tasks: 'loaded' }
      mockEtebaseState.isInitialized = true
    }
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

  it('gives the add button a mobile-only 44px hit area', () => {
    render(<TaskListPanel />)
    const add = screen.getByRole('button', { name: 'Add task list' })
    expect(add.className).toContain('max-md:min-h-[44px]')
    expect(add.className).toContain('max-md:min-w-[44px]')
    expect(add.className).not.toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
  })

  it('offers Delete only on a task list this user administers', () => {

    render(<TaskListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Tasks actions'))
    expect(screen.getByRole('menuitem', { name: 'Delete task list' })).toBeEnabled()
    fireEvent.click(screen.getByLabelText('Open Work Tasks actions'))

    fireEvent.click(screen.getByLabelText('Open Home Tasks actions'))
    expect(screen.getByRole('menuitem', { name: 'Delete task list' })).toBeDisabled()
    expect(screen.getByText('Only an admin of this shared task list can delete it.')).toBeInTheDocument()
  })
})
