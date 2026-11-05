import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import TasksPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import messages from '@/messages/en.json'
import type { Task } from '@silentsuite/core'
import type { TaskList } from '@/app/stores/use-task-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

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
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    storeMock.taskState.tasks = []
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  it('derives its skeleton from the tasks domain and skips it for cached tasks (#747)', () => {
    const hasSkeleton = () => document.querySelector('.skeleton-shimmer') !== null
    const view = renderWithIntl(<TasksPage />)
    expect(hasSkeleton()).toBe(true)

    storeMock.taskState.tasks = [{ id: 'cached', uid: 'cached', title: 'Cached task', listId: 'default' } as Task]
    view.rerender(<TasksPage />)
    expect(hasSkeleton()).toBe(false)

    storeMock.taskState.tasks = []
    act(() => useEtebaseStore.setState((state) => ({ domainLoadState: { ...state.domainLoadState, tasks: 'loaded' } })))
    view.rerender(<TasksPage />)
    expect(hasSkeleton()).toBe(false)
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

// C3b-R12/R13 (PLAN U6, U7, U8). The store boundary is the existing mock; each create is a
// controlled deferred promise. The store contract itself (TaskSaveError.unconfirmed) is proven
// in use-task-store.test.ts and the node SDK integration test.
describe('C3b task drafts survive an unsaved or unconfirmed create', () => {
  let TaskSaveError: typeof import('@/app/stores/use-task-store').TaskSaveError
  const unconfirmedMessage = /(couldn't|could not) confirm/i
  const definiteMessage = /Task not saved/i

  beforeAll(async () => {
    ;({ TaskSaveError } = await vi.importActual<typeof import('@/app/stores/use-task-store')>('@/app/stores/use-task-store'))
  })

  beforeEach(() => {
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    storeMock.taskState.tasks = []
    storeMock.authState.canWrite.mockReturnValue(true)
    storeMock.taskState.createTask.mockReset()
  })

  /**
   * The next createTask stays pending until the test settles it. Teardown resolves it, never
   * rejects it, so a handler that does not await it can never surface an unhandled rejection.
   */
  function deferCreate() {
    let resolve!: (task: Task) => void
    let reject!: (reason: unknown) => void
    const pending = new Promise<Task>((resolvePending, rejectPending) => { resolve = resolvePending; reject = rejectPending })
    storeMock.taskState.createTask.mockImplementationOnce(() => pending)
    onTestFinished(() => resolve({ id: 'settled-at-test-end', title: 'settled' } as Task))
    return { resolve, reject }
  }

  const dialog = () => screen.queryByRole('dialog', { name: 'New Task' })
  const backdrop = () => document.querySelector('div[aria-hidden="true"][class*="bg-black/40"]')

  async function openDraft() {
    renderWithIntl(<TasksPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Draft title' } })
    fireEvent.change(screen.getByPlaceholderText('Add notes...'), { target: { value: 'Draft notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1))
    expect(storeMock.taskState.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Draft title', description: 'Draft notes' }))
  }

  it.each([
    ['unconfirmed', true, unconfirmedMessage, definiteMessage],
    ['known unsaved', false, definiteMessage, unconfirmedMessage],
  ] as const)('C3b-R12 dialog: a pending create keeps the draft open and guarded, and an %s outcome keeps every field', async (_label, unconfirmed, shown, notShown) => {
    const create = deferCreate()
    await openDraft()

    // Pending: the draft stays mounted, Create cannot dispatch again, and nothing can discard it.
    expect(dialog()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(backdrop()!)
    expect(dialog()).not.toBeNull()
    expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1)

    await act(async () => { create.reject(new TaskSaveError(unconfirmed)) })

    const message = await screen.findByText(shown)
    if (unconfirmed) expect(message.textContent).toMatch(/(appears|already)/i)
    expect(screen.queryByText(notShown)).toBeNull()
    expect(dialog()).not.toBeNull()
    expect(screen.getByPlaceholderText('Task title')).toHaveValue('Draft title')
    expect(screen.getByPlaceholderText('Add notes...')).toHaveValue('Draft notes')
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })

  it('C3b-R12 dialog control: an acknowledged create closes the dialog without an outcome message', async () => {
    const create = deferCreate()
    await openDraft()

    await act(async () => { create.resolve({ id: 'remote-task-1', title: 'Draft title' } as Task) })

    await waitFor(() => expect(dialog()).toBeNull())
    expect(screen.queryByText(unconfirmedMessage)).toBeNull()
    expect(screen.queryByText(definiteMessage)).toBeNull()
  })

  /** Every native control in the open dialog: its header actions and all draft fields, nested editors included. */
  const draftControls = () => Array.from(dialog()!.querySelectorAll<HTMLElement>('input, textarea, select, button'))
  const describeControl = (control: HTMLElement) =>
    `${control.tagName.toLowerCase()} ${control.getAttribute('aria-label') ?? control.getAttribute('placeholder') ?? control.textContent?.trim() ?? ''}`

  it('C3b-R12 dialog: while a create is pending no draft control accepts input, so the acknowledged create closes on exactly the submitted draft', async () => {
    const create = deferCreate()
    await openDraft()

    // Pending: native disabled semantics refuse every edit, so no newer input can exist to be discarded.
    const controls = draftControls()
    expect(controls.length).toBeGreaterThan(4)
    for (const control of controls) expect(control, describeControl(control)).toBeDisabled()
    expect(screen.getByPlaceholderText('Task title')).toHaveValue('Draft title')
    expect(screen.getByPlaceholderText('Add notes...')).toHaveValue('Draft notes')

    await act(async () => { create.resolve({ id: 'remote-task-1', title: 'Draft title' } as Task) })

    await waitFor(() => expect(dialog()).toBeNull())
    expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1)
  })

  it('C3b-R12 dialog: a rejected create makes the submitted draft editable again', async () => {
    const create = deferCreate()
    renderWithIntl(<TasksPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Draft title' } })
    fireEvent.change(screen.getByPlaceholderText('Add notes...'), { target: { value: 'Draft notes' } })
    // Which controls accept input before submitting; the same ones must accept it again after a rejection.
    const editableBefore = draftControls().map((control) => !control.matches(':disabled'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1))

    for (const control of draftControls()) expect(control, describeControl(control)).toBeDisabled()

    await act(async () => { create.reject(new TaskSaveError(true)) })
    await screen.findByText(unconfirmedMessage)

    const controls = draftControls()
    expect(controls).toHaveLength(editableBefore.length)
    controls.forEach((control, index) => {
      if (editableBefore[index]) expect(control, describeControl(control)).toBeEnabled()
      else expect(control, describeControl(control)).toBeDisabled()
    })
    expect(screen.getByPlaceholderText('Task title')).toHaveValue('Draft title')
    expect(screen.getByPlaceholderText('Add notes...')).toHaveValue('Draft notes')
    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Draft title, revised' } })
    expect(screen.getByPlaceholderText('Task title')).toHaveValue('Draft title, revised')
  })

  /** Disabled by its own attribute or by a disabled fieldset around it, as a browser treats it. */
  const isDisabledControl = (element: Element) => element.matches(':disabled') || element.closest('fieldset[disabled]') !== null

  /** A real cancelable keydown delivered to the focused element, as a browser starts a Tab move. */
  function pressTab(shiftKey: boolean) {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
    ;(document.activeElement ?? document.body).dispatchEvent(event)
    return event
  }

  /** Opens a draft, lets the dialog's own autofocus settle, then presses a focused Create. */
  async function pendingCreateFromFocusedCreate() {
    const create = deferCreate()
    renderWithIntl(<TasksPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Draft title' } })
    fireEvent.change(screen.getByPlaceholderText('Add notes...'), { target: { value: 'Draft notes' } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
    const createButton = screen.getByRole('button', { name: 'Create' })
    createButton.focus()
    expect(createButton).toHaveFocus()
    fireEvent.click(createButton)
    await waitFor(() => expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1))
    return create
  }

  it('C3b-R12 dialog focus: a pending create keeps focus on a focusable element inside the dialog, and Tab and Shift+Tab cannot leave it', async () => {
    const create = await pendingCreateFromFocusedCreate()

    const focused = document.activeElement!
    expect(dialog()!.contains(focused), `focus is on ${focused.tagName}`).toBe(true)
    expect(isDisabledControl(focused), `focus is on a disabled ${focused.tagName}`).toBe(false)
    for (const shiftKey of [false, true]) {
      // Every draft control is disabled, so only the dialog can stop native traversal leaving it.
      const event = pressTab(shiftKey)
      expect(event.defaultPrevented, shiftKey ? 'Shift+Tab' : 'Tab').toBe(true)
      expect(document.activeElement).toBe(focused)
    }

    await act(async () => { create.resolve({ id: 'remote-task-1', title: 'Draft title' } as Task) })
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('C3b-R12 dialog focus: after a rejected create, focus is on an editable draft field inside the dialog', async () => {
    const create = await pendingCreateFromFocusedCreate()

    await act(async () => { create.reject(new TaskSaveError(true)) })
    await screen.findByText(unconfirmedMessage)

    const focused = document.activeElement!
    expect(dialog()!.contains(focused), `focus is on ${focused.tagName}`).toBe(true)
    expect(isDisabledControl(focused), `focus is on a disabled ${focused.tagName}`).toBe(false)
    expect(['INPUT', 'TEXTAREA'], `focus is on ${focused.tagName}`).toContain(focused.tagName)
  })

  async function submitQuickAdd(title: string) {
    renderWithIntl(<TasksPage />)
    const input = screen.getByPlaceholderText('Add a task...')
    fireEvent.change(input, { target: { value: title } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1))
    return input
  }

  it.each([
    ['unconfirmed', true, unconfirmedMessage, definiteMessage],
    ['known unsaved', false, definiteMessage, unconfirmedMessage],
  ] as const)('C3b-R13 quick add: a pending create keeps the submitted title read-only, and an %s outcome leaves it editable', async (_label, unconfirmed, shown, notShown) => {
    const create = deferCreate()
    const input = await submitQuickAdd('First')

    // Pending: the submitted title stays, the field cannot be edited, and Add (with it Enter) cannot submit again.
    expect(input).toHaveValue('First')
    expect(input).toHaveAttribute('readonly')
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    fireEvent.click(add)
    expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1)

    await act(async () => { create.reject(new TaskSaveError(unconfirmed)) })

    const message = await screen.findByText(shown)
    if (unconfirmed) expect(message.textContent).toMatch(/(appears|already)/i)
    expect(screen.queryByText(notShown)).toBeNull()
    expect(input).toHaveValue('First')
    expect(input).not.toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  it('C3b-R13 quick add: an acknowledged create clears the title only once it resolves', async () => {
    const create = deferCreate()
    const input = await submitQuickAdd('First')

    expect(input).toHaveValue('First')

    await act(async () => { create.resolve({ id: 'remote-task-1', title: 'First' } as Task) })

    await waitFor(() => expect(input).toHaveValue(''))
    expect(input).not.toHaveAttribute('readonly')
    expect(screen.queryByText(unconfirmedMessage)).toBeNull()
    expect(screen.queryByText(definiteMessage)).toBeNull()
  })

  it('C3b-R13 quick add control: an acknowledged create sends the title and leaves the field empty', async () => {
    storeMock.taskState.createTask.mockResolvedValueOnce({ id: 'remote-task-1', title: 'Quick' } as Task)
    const input = await submitQuickAdd('Quick')

    expect(storeMock.taskState.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Quick' }))
    await waitFor(() => expect(input).toHaveValue(''))
    expect(screen.queryByText(unconfirmedMessage)).toBeNull()
    expect(screen.queryByText(definiteMessage)).toBeNull()
  })
})

// Class checks record the intended mobile hit area. Measured geometry is the later browser fixture.

function taskFixture(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    uid: overrides.id,
    description: '',
    start_date: null,
    due_date: null,
    priority: 'medium',
    completed: false,
    status: 'needs-action',
    percent_complete: 0,
    location: '',
    url: '',
    categories: [],
    listId: 'work',
    created_at: new Date(2026, 5, 1),
    updated_at: new Date(2026, 5, 1),
    ...overrides,
  } as Task
}

function visibleLists() {
  storeMock.taskListState.lists = [
    { id: 'work', name: 'Work', color: '#3b82f6', visible: true },
    { id: 'secret', name: 'Secret', color: '#ef4444', visible: false },
  ]
  storeMock.taskListState.activeListId = 'work'
}

function expectMobileHeight(element: HTMLElement) {
  expect(element.className).toContain('max-md:min-h-[44px]')
  expect(element.className).not.toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
}

function expectMobileSquare(element: HTMLElement) {
  expectMobileHeight(element)
  expect(element.className).toContain('max-md:min-w-[44px]')
}

describe('TasksPage search and mobile editor', () => {
  beforeEach(() => {
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    storeMock.taskState.tasks = []
    storeMock.taskListState.lists = []
    storeMock.taskListState.activeListId = null
    storeMock.authState.canWrite.mockReturnValue(true)
    storeMock.taskState.createTask.mockReset()
    storeMock.taskState.updateTask.mockReset()
    storeMock.taskState.toggleComplete.mockReset()
  })

  it('searches visible tasks by title, description, location, and label, and hides a non-match', () => {
    visibleLists()
    storeMock.taskState.tasks = [
      taskFixture({ id: 'title', title: 'Alpha task' }),
      taskFixture({ id: 'notes', title: 'Bring paper', description: 'meeting notes' }),
      taskFixture({ id: 'place', title: 'Errand', location: 'Office lobby' }),
      taskFixture({ id: 'label', title: 'Review', categories: ['Standup'] }),
      taskFixture({ id: 'hidden', title: 'Secret standup', listId: 'secret' }),
    ]
    renderWithIntl(<TasksPage />)

    const search = screen.getByLabelText('Search tasks')
    expect(search.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(search.className).not.toContain('md:hidden')
    expect(screen.getByLabelText('Add a task').compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.change(search, { target: { value: 'ALPHA' } })
    expect(screen.getByText('Alpha task')).toBeInTheDocument()
    expect(screen.queryByText('Bring paper')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'notes' } })
    expect(screen.getByText('Bring paper')).toBeInTheDocument()
    expect(screen.queryByText('Alpha task')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'office' } })
    expect(screen.getByText('Errand')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'standup' } })
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(screen.queryByText('Secret standup')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(screen.getByText('No tasks match your search')).toBeInTheDocument()
    expect(screen.queryByText('Review')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: '' } })
    expect(screen.queryByText('No tasks match your search')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha task')).toBeInTheDocument()
    expect(screen.queryByText('Secret standup')).not.toBeInTheDocument()
  })

  it('hides search while tasks are loading or the store is empty', () => {
    renderWithIntl(<TasksPage />)
    expect(screen.queryByLabelText('Search tasks')).not.toBeInTheDocument()

    act(() => useEtebaseStore.setState((state) => ({ domainLoadState: { ...state.domainLoadState, tasks: 'loaded' } })))
    expect(screen.queryByLabelText('Search tasks')).not.toBeInTheDocument()
  })

  it('keeps search available when writing is disabled, and does not offer the mobile editor', () => {
    visibleLists()
    storeMock.authState.canWrite.mockReturnValue(false)
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task', description: 'Visible note' })]
    renderWithIntl(<TasksPage />)

    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'alpha' } })
    expect(screen.getByText('Alpha task')).toBeInTheDocument()
    const mobileEdit = screen.queryAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('md:hidden'))
    expect(mobileEdit).toBeUndefined()

    fireEvent.click(screen.getByText('Alpha task'))
    expect(screen.getByPlaceholderText('Add a description...')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Edit Task' })).not.toBeInTheDocument()
  })

  it('opens the full editor from the mobile edit button without a list selector or listId', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({
      id: 'alpha',
      title: 'Alpha task',
      description: 'Visible note',
      start_date: new Date(2026, 5, 2),
      due_date: new Date(2026, 5, 3),
      status: 'needs-action',
      location: 'Office',
      url: 'https://example.invalid/task',
    })]
    renderWithIntl(<TasksPage />)

    const mobileEdit = screen.getAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('md:hidden'))
    expect(mobileEdit, 'mobile Edit task button').toBeTruthy()
    expect(mobileEdit!.className).toContain('md:hidden')
    const desktopPencil = screen.getAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('hidden') && button.className.includes('md:flex'))
    expect(desktopPencil?.className).toContain('hidden')
    expect(desktopPencil?.className).toContain('md:flex')

    fireEvent.click(mobileEdit!)
    const dialog = screen.getByRole('dialog', { name: 'Edit Task' })
    expect(within(dialog).getByPlaceholderText('Task title')).toHaveValue('Alpha task')
    expect(within(dialog).getByLabelText('Start date')).toHaveValue('2026-06-02')
    expect(within(dialog).getByLabelText('Due date')).toHaveValue('2026-06-03')
    expect(within(dialog).getByLabelText('Task status')).toHaveValue('needs-action')
    expect(within(dialog).getByLabelText('Location')).toHaveValue('Office')
    expect(within(dialog).getByLabelText('URL')).toHaveValue('https://example.invalid/task')
    expect(within(dialog).queryByRole('button', { name: 'Work' })).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByPlaceholderText('Task title'), { target: { value: 'Alpha revised' } })
    fireEvent.change(within(dialog).getByLabelText('Task status'), { target: { value: 'in-process' } })
    fireEvent.change(within(dialog).getByLabelText('Location'), { target: { value: 'Home' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(storeMock.taskState.updateTask).toHaveBeenCalledTimes(1)
    const patch = storeMock.taskState.updateTask.mock.calls[0]?.[1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('listId')
    expect(patch).toEqual(expect.objectContaining({ title: 'Alpha revised', status: 'in-process', location: 'Home' }))
  })

  it('still sends listId from the create dialog', async () => {
    visibleLists()
    storeMock.taskState.createTask.mockResolvedValue({ id: 'created', title: 'Created' } as Task)
    renderWithIntl(<TasksPage />)

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New Task' })
    expect(within(dialog).getByRole('button', { name: 'Work' })).toBeInTheDocument()
    fireEvent.change(within(dialog).getByPlaceholderText('Task title'), { target: { value: 'Created' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1))
    expect(storeMock.taskState.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Created', listId: 'work' }))
  })

  it('keeps the desktop pencil as expand-only', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task' })]
    renderWithIntl(<TasksPage />)

    const pencil = screen.getAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('md:flex'))
    expect(pencil, 'desktop pencil').toBeTruthy()
    fireEvent.click(pencil!)
    expect(screen.getByPlaceholderText('Add a description...')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Edit Task' })).not.toBeInTheDocument()
  })

  it('uses mobile-only 44px classes on the complete toggle and primary task actions', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task' })]
    renderWithIntl(<TasksPage />)

    const toggle = screen.getByRole('button', { name: 'Mark complete' })
    expectMobileSquare(toggle)
    fireEvent.click(toggle)
    expect(storeMock.taskState.toggleComplete).toHaveBeenCalledTimes(1)
    expect(storeMock.taskState.toggleComplete).toHaveBeenCalledWith('alpha')

    expectMobileHeight(screen.getByRole('button', { name: 'New task' }))
    expectMobileHeight(screen.getByRole('button', { name: 'Add' }))

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New Task' })
    expectMobileHeight(within(dialog).getByRole('button', { name: 'Cancel' }))
    expectMobileHeight(within(dialog).getByRole('button', { name: 'Create' }))
  })
})

// #295: the mobile bottom nav sits outside `main`, which is its own stacking context, so a dialog
// rendered inside the page paints under the nav and the nav stays tappable while it is open.
// These check where each overlay is mounted; they do not measure painted geometry.

/** The outermost `fixed` element between the role=dialog card and <body>: the overlay's own wrapper. */
function outerOverlay(dialog: HTMLElement): HTMLElement | null {
  let outer: HTMLElement | null = null
  for (let node: HTMLElement | null = dialog; node && node !== document.body; node = node.parentElement) {
    if (node.classList.contains('fixed')) outer = node
  }
  return outer
}

function expectPortaledOverlay(dialog: HTMLElement, pageContainer: HTMLElement) {
  expect(pageContainer.contains(dialog), 'dialog is rendered inside the page container').toBe(false)
  const outer = outerOverlay(dialog)
  expect(outer, 'fixed overlay wrapper').not.toBeNull()
  expect(outer!.parentElement, 'overlay wrapper is a direct child of <body>').toBe(document.body)
}

describe('TasksPage overlays mount above the bottom nav', () => {
  beforeEach(() => {
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    storeMock.taskState.tasks = []
    storeMock.taskListState.lists = []
    storeMock.taskListState.activeListId = null
    storeMock.authState.canWrite.mockReturnValue(true)
    storeMock.taskState.deleteTask.mockReset()
    storeMock.taskState.updateTask.mockReset()
  })

  it('portals the New Task dialog and its backdrop to <body>', () => {
    visibleLists()
    const { container } = renderWithIntl(<TasksPage />)

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New Task' })
    expect(within(dialog).getByPlaceholderText('Task title')).toBeInTheDocument()

    expectPortaledOverlay(dialog, container)
    const backdrop = document.querySelector<HTMLElement>('div[aria-hidden="true"][class*="bg-black/40"]')
    expect(backdrop, 'TaskDialog backdrop').not.toBeNull()
    expect(backdrop!.parentElement, 'backdrop is a direct child of <body>').toBe(document.body)
  })

  it('portals the full editor opened from the mobile Edit task button', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task' })]
    const { container } = renderWithIntl(<TasksPage />)

    const mobileEdit = screen.getAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('md:hidden'))
    expect(mobileEdit, 'mobile Edit task button').toBeTruthy()
    fireEvent.click(mobileEdit!)
    const dialog = screen.getByRole('dialog', { name: 'Edit Task' })
    expect(within(dialog).getByPlaceholderText('Task title')).toHaveValue('Alpha task')

    expectPortaledOverlay(dialog, container)
  })

  it('portals the task delete confirmation at its call site; cancel keeps the task and confirm still deletes', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task' })]
    const { container } = renderWithIntl(<TasksPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
    const confirm = screen.getByRole('dialog', { name: 'Delete task?' })
    expectPortaledOverlay(confirm, container)

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Delete task?' })).not.toBeInTheDocument()
    expect(storeMock.taskState.deleteTask).not.toHaveBeenCalled()
    expect(screen.getByText('Alpha task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete task?' })).getByRole('button', { name: 'Delete task' }))
    expect(storeMock.taskState.deleteTask).toHaveBeenCalledTimes(1)
    expect(storeMock.taskState.deleteTask).toHaveBeenCalledWith('alpha')
    expect(screen.queryByRole('dialog', { name: 'Delete task?' })).not.toBeInTheDocument()
  })

  it('leaves the shared ConfirmDialog itself unportaled (only call sites move)', async () => {
    const { ConfirmDialog } = await import('@/app/components/confirm-dialog')
    const { container } = renderWithIntl(
      <ConfirmDialog title="Shared confirm" message="Stays where it is rendered." onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(container.contains(screen.getByRole('dialog', { name: 'Shared confirm' }))).toBe(true)
  })
})

// #295: on narrow phones the quick-add input kept its intrinsic minimum width and pushed Add past the
// page edge, and the 44px row actions left too little room for the task row.

describe('TasksPage mobile row and quick-add containment', () => {
  beforeEach(() => {
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    storeMock.taskState.tasks = []
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  it('lets the quick-add input shrink below md without changing desktop', () => {
    renderWithIntl(<TasksPage />)
    const input = screen.getByLabelText('Add a task')
    expect(input.className).toContain('flex-1')
    expect(input.className).toContain('max-md:min-w-0')
    expect(input.className).not.toMatch(/(^|\s)min-w-0(\s|$)/)
  })

  it('tightens the task row and badge group below md and keeps the desktop spacing', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task', due_date: new Date(2026, 5, 3), priority: 'urgent' })]
    renderWithIntl(<TasksPage />)

    const row = screen.getByRole('button', { name: 'Mark complete' }).parentElement!
    expect(row.className).toContain('gap-3')
    expect(row.className).toContain('max-md:gap-1.5')

    const badgeGroup = screen.getByRole('button', { name: 'Delete task' }).parentElement!
    expect(within(badgeGroup).getByText('Urgent')).toBeInTheDocument()
    expect(badgeGroup.className).toContain('gap-2')
    expect(badgeGroup.className).toContain('shrink-0')
    expect(badgeGroup.className).toContain('max-md:gap-1.5')
    expect(badgeGroup.className).toContain('max-md:min-w-0')
  })
})

// #295: on narrow phones a long task title still had no room beside the due date, priority and row
// actions, so those move to a line under the title below md. In the task dialog, a scrolling <fieldset>
// did not bring its lower fields into view, and a long list name widened the dialog past the screen.

describe('TasksPage mobile metadata line and dialog reachability', () => {
  const longListName = 'A'.repeat(40)

  beforeEach(() => {
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    storeMock.taskState.tasks = []
    storeMock.taskListState.lists = []
    storeMock.taskListState.activeListId = null
    storeMock.authState.canWrite.mockReturnValue(true)
    storeMock.taskState.createTask.mockReset()
  })

  it('shows due date and priority on a mobile-only line under the title and keeps the desktop badges desktop-only', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task', due_date: new Date(2026, 5, 3), priority: 'urgent' })]
    renderWithIntl(<TasksPage />)

    // Desktop badges: still the two spans in the action group, now hidden below md.
    const badgeGroup = screen.getByRole('button', { name: 'Delete task' }).parentElement!
    const desktopBadges = Array.from(badgeGroup.querySelectorAll<HTMLElement>(':scope > span'))
    expect(desktopBadges).toHaveLength(2)
    const [desktopDue, desktopPriority] = desktopBadges as [HTMLElement, HTMLElement]
    expect(desktopPriority).toHaveTextContent('Urgent')
    for (const badge of desktopBadges) expect(badge.className, badge.textContent ?? '').toContain('max-md:hidden')

    // Mobile line: inside the title column, after the title, md:hidden, with the same due text and priority.
    const title = screen.getByText('Alpha task')
    const titleColumn = title.parentElement!
    const mobilePriority = within(titleColumn).getByText('Urgent')
    const mobileLine = mobilePriority.closest<HTMLElement>('.md\\:hidden')
    expect(mobileLine, 'mobile metadata line').not.toBeNull()
    expect(titleColumn.contains(mobileLine)).toBe(true)
    expect(title.compareDocumentPosition(mobileLine!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(mobileLine!).getByText(desktopDue.textContent!)).toBeInTheDocument()

    // Every row action keeps its label and 44px mobile target.
    expectMobileSquare(screen.getByRole('button', { name: 'Mark complete' }))
    const mobileEdit = screen.getAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('md:hidden'))
    expect(mobileEdit, 'mobile Edit task button').toBeTruthy()
    expectMobileSquare(mobileEdit!)
    expect(screen.getByRole('button', { name: 'Delete task' }).className).toContain('min-h-[44px]')
    expect(screen.getByRole('button', { name: 'Delete task' }).className).toContain('min-w-[44px]')

    // Expanding the row hides the collapsed metadata on both widths, as the desktop badges already do.
    fireEvent.click(title)
    expect(screen.getByPlaceholderText('Add a description...')).toBeInTheDocument()
    expect(within(titleColumn).queryByText('Urgent')).not.toBeInTheDocument()
  })

  it('scrolls the TaskDialog body with an ordinary constrained div around the pending-safe fieldset', () => {
    visibleLists()
    storeMock.taskState.tasks = [taskFixture({ id: 'alpha', title: 'Alpha task' })]
    renderWithIntl(<TasksPage />)

    const assertScrollOwner = (dialog: HTMLElement) => {
      const fieldset = dialog.querySelector('fieldset')
      expect(fieldset, 'draft fieldset').not.toBeNull()
      const scroller = fieldset!.parentElement!
      expect(scroller.tagName).toBe('DIV')
      expect(dialog.contains(scroller) && scroller !== dialog, 'scroller sits inside the dialog card').toBe(true)
      for (const name of ['min-h-0', 'flex-1', 'overflow-y-auto']) expect(scroller.className, name).toContain(name)
      // One scroll owner: the fieldset keeps its disabled-while-pending role but no longer scrolls.
      expect(fieldset!.className).not.toContain('overflow-y-auto')
      expect(within(fieldset!).getByPlaceholderText('Task title')).toBeInTheDocument()
      expect(within(fieldset!).getByPlaceholderText('Add notes...')).toBeInTheDocument()
    }

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    assertScrollOwner(screen.getByRole('dialog', { name: 'New Task' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'New Task' })).getByRole('button', { name: 'Cancel' }))

    const mobileEdit = screen.getAllByRole('button', { name: 'Edit task' }).find((button) => button.className.includes('md:hidden'))
    fireEvent.click(mobileEdit!)
    assertScrollOwner(screen.getByRole('dialog', { name: 'Edit Task' }))
  })

  it('keeps a long list pill inside the create dialog below md, with its full name and selection intact', async () => {
    storeMock.taskListState.lists = [
      { id: 'work', name: 'Work', color: '#3b82f6', visible: true },
      { id: 'long', name: longListName, color: '#2bb673', visible: true },
    ]
    storeMock.taskListState.activeListId = 'work'
    storeMock.taskState.createTask.mockResolvedValue({ id: 'created', title: 'Created' } as Task)
    renderWithIntl(<TasksPage />)

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New Task' })
    const pill = within(dialog).getByRole('button', { name: longListName })
    expect(pill.className).toContain('max-md:max-w-full')
    expect(pill.parentElement!.className).toContain('max-md:min-w-0')
    const label = within(pill).getByText(longListName)
    expect(label).not.toBe(pill)
    expect(label.className).toContain('max-md:truncate')

    fireEvent.click(pill)
    fireEvent.change(within(dialog).getByPlaceholderText('Task title'), { target: { value: 'Created' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(storeMock.taskState.createTask).toHaveBeenCalledTimes(1))
    expect(storeMock.taskState.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Created', listId: 'long' }))
  })
})
