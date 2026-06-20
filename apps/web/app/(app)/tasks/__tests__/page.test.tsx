import { screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TasksPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import messages from '@/messages/en.json'
import type { Task } from '@silentsuite/core'
import type { TaskList } from '@/app/stores/use-task-list-store'

// Mobile reachability smoke test for the Tasks page (epic #295). jsdom does not
// evaluate CSS media queries, so these assert that the primary create action and
// the collection switcher render with their accessible labels and carry the
// expected responsive / touch-target classes, complementing manual width QA.
// Accessible names that are backed by next-intl messages are resolved from the
// message catalog so the tests do not couple to English copy.

const manageTaskLists = messages.Collections.manageTaskLists

const storeMock = vi.hoisted(() => ({
  taskState: {
    tasks: [] as Task[],
    isLoading: true,
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    toggleComplete: vi.fn(),
  },
  taskListState: {
    lists: [] as TaskList[],
    activeListId: null as string | null,
  },
  syncState: {
    isOnline: true,
  },
  authState: {
    canWrite: vi.fn(() => true),
  },
}))

vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: (selector: (state: typeof storeMock.taskState) => unknown) => selector(storeMock.taskState),
}))

vi.mock('@/app/stores/use-task-list-store', () => ({
  useTaskListStore: (selector: (state: typeof storeMock.taskListState) => unknown) => selector(storeMock.taskListState),
}))

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (state: typeof storeMock.syncState) => unknown) => selector(storeMock.syncState),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: typeof storeMock.authState) => unknown) => selector(storeMock.authState),
}))

vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="collection-sheet" /> : null),
}))

describe('TasksPage mobile reachability', () => {
  beforeEach(() => {
    storeMock.taskState.isLoading = true
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  it('exposes the primary create action on all widths', () => {
    renderWithIntl(<TasksPage />)
    const createButton = screen.getByRole('button', { name: 'New task' })
    expect(createButton).toBeInTheDocument()
    // Not hidden behind a desktop-only breakpoint.
    expect(createButton.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(createButton.className).not.toContain('md:flex')
  })

  it('exposes an inline quick-add on mobile', () => {
    renderWithIntl(<TasksPage />)
    expect(screen.getByPlaceholderText('Add a task...')).toBeInTheDocument()
  })

  it('exposes a mobile collection switcher with a 44px touch target', () => {
    renderWithIntl(<TasksPage />)
    const folderButton = screen.getByRole('button', { name: manageTaskLists })
    expect(folderButton).toBeInTheDocument()
    // Mobile-only control that meets the minimum touch target.
    expect(folderButton.className).toContain('md:hidden')
    expect(folderButton.className).toContain('touch-target')
  })
})
