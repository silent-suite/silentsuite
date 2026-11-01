import { act, fireEvent, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NotesPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import type { Note } from '@silentsuite/core'
import type { Notebook } from '@/app/stores/use-notebook-store'
import type { StoredNote } from '@/app/stores/use-note-store'
import { useSidebarStore } from '@/app/stores/use-sidebar-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: (selector: (state: typeof storeMock.etebaseState) => unknown) => selector(storeMock.etebaseState),
}))

type DomainStatus = 'unknown' | 'loaded' | 'failed'

const storeMock = vi.hoisted(() => ({
  etebaseState: {
    accountFingerprint: 'notes-test-account',
    account: null as object | null,
    isInitialized: false,
    restoreBlocked: false,
    domainLoadState: {} as Record<'calendar' | 'tasks' | 'contacts' | 'notes' | 'preferences', DomainStatus>,
  },
  noteState: {
    notes: [] as Note[],
    isLoading: true,
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    moveNote: vi.fn(),
    canWriteNote: (note: Note) => {
      const notebook = storeMock.notebookState.lists.find((list) => list.id === note.notebookId)
      return notebook?.accessLevel === 1 || notebook?.accessLevel === 2
    },
  },
  notebookState: {
    lists: [] as Notebook[],
    activeListId: 'all',
  },
  syncState: { isOnline: true },
  authState: { canWrite: vi.fn(() => true) },
}))

vi.mock('@/app/stores/use-note-store', () => ({
  useNoteStore: (selector: (state: typeof storeMock.noteState) => unknown) => selector(storeMock.noteState),
  // No obligations or custody here; the #744 editor lifecycle has its own rendered test.
  getNoteObligation: () => undefined,
  observeNoteCustody: async () => {},
  proveNoteBase: async () => false,
  registerNoteEditor: () => () => {},
  releaseNoteObligation: () => {},
}))

vi.mock('@/app/stores/use-notebook-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/stores/use-notebook-store')>()),
  useNotebookStore: (selector: (state: typeof storeMock.notebookState) => unknown) => selector(storeMock.notebookState),
}))

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (state: typeof storeMock.syncState) => unknown) => selector(storeMock.syncState),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: typeof storeMock.authState) => unknown) => selector(storeMock.authState),
}))

vi.mock('@/app/stores/use-preferences-store', () => ({
  usePreferencesStore: (selector: (state: { dateFormat: string; timeFormat: string }) => unknown) => (
    selector({ dateFormat: 'system', timeFormat: '12h' })
  ),
}))

vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="collection-sheet" /> : null),
}))

// The real renderer and editor are covered by their own test files.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown-preview">{children}</div>,
}))

vi.mock('../MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange, ariaLabel, readOnly, placeholder, className }: {
    value: string
    onChange: (value: string) => void
    ariaLabel: string
    readOnly?: boolean
    placeholder?: string
    className?: string
  }) => (
    <textarea
      aria-label={ariaLabel}
      placeholder={placeholder}
      readOnly={readOnly}
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

const NOTEBOOK: Notebook = { id: 'notes-1', name: 'Personal Notes', color: '#f59e0b', visible: true, accessLevel: 1 }
const WORK: Notebook = { id: 'notes-2', name: 'Work', color: '#3b82f6', visible: true, accessLevel: 2 }

function note(id: string, overrides: Partial<StoredNote> = {}): StoredNote {
  const date = new Date('2026-01-01T00:00:00Z')
  return { id, uid: id, title: id, content: '', notebookId: 'notes-1', created_at: date, updated_at: date, revision: null, ...overrides }
}

/** The capture an editor save carries: the text it was typed on, at an unknown revision here. */
function typedOn(title: string, content: string) {
  return expect.objectContaining({ base: { title, content, revision: null } })
}

/** A cold restore: no session yet, every domain unknown, initialization still running. */
function coldRestore() {
  storeMock.etebaseState.account = null
  storeMock.etebaseState.isInitialized = false
  storeMock.etebaseState.restoreBlocked = false
  storeMock.etebaseState.domainLoadState = { calendar: 'unknown', tasks: 'unknown', contacts: 'unknown', notes: 'unknown', preferences: 'unknown' }
}

function loaded(notes: Note[], lists: Notebook[] = [NOTEBOOK]) {
  storeMock.noteState.isLoading = false
  storeMock.etebaseState.domainLoadState = { ...storeMock.etebaseState.domainLoadState, notes: 'loaded' }
  storeMock.noteState.notes = notes
  storeMock.notebookState.lists = lists
}

const hasSkeleton = () => document.querySelector('.skeleton-shimmer') !== null

describe('NotesPage loading skeleton (#747)', () => {
  beforeEach(() => {
    useExperimentalStore.setState({ hydrated: true, notesAccounts: ['notes-test-account'] })
    coldRestore()
    storeMock.noteState.notes = []
    storeMock.notebookState.lists = [NOTEBOOK]
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  // The legacy note-store flag is set opposite to the expected outcome each
  // time, so only the domain initialization state can produce the result.
  it('shows the skeleton during a cold session restore before any account is restored', () => {
    storeMock.noteState.isLoading = false
    renderWithIntl(<NotesPage />)
    expect(hasSkeleton()).toBe(true)
    expect(screen.queryByText('No notes yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New note' })).toBeDisabled()
  })

  it.each([
    ['the notes domain loaded', () => { storeMock.etebaseState.domainLoadState.notes = 'loaded' }],
    ['the notes domain failed', () => { storeMock.etebaseState.domainLoadState.notes = 'failed' }],
    ['initialization ended with every domain still unknown', () => { storeMock.etebaseState.isInitialized = true }],
    ['the session restore is blocked', () => { storeMock.etebaseState.restoreBlocked = true }],
  ])('hides the skeleton once %s', (_label, settle) => {
    storeMock.noteState.isLoading = true
    settle()
    renderWithIntl(<NotesPage />)
    expect(hasSkeleton()).toBe(false)
    expect(screen.getByText('No notes yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New note' })[0]).toBeEnabled()
  })

  it('keeps cached notes painted while the notes domain is still unknown', () => {
    storeMock.noteState.isLoading = true
    storeMock.noteState.notes = [note('cached', { title: 'Cached note' })]
    renderWithIntl(<NotesPage />)
    expect(hasSkeleton()).toBe(false)
    expect(screen.getByRole('button', { name: /Cached note/ })).toBeInTheDocument()
    // Painted cached notes enable creation in a writable notebook, as the old
    // cache paint did by clearing the store flag.
    expect(screen.getByRole('button', { name: 'New note' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'New note' })).toHaveAttribute('title', 'New note in Personal Notes')
  })

  it('drops the skeleton when initialization ends after the first render', () => {
    storeMock.noteState.isLoading = false
    const view = renderWithIntl(<NotesPage />)
    expect(hasSkeleton()).toBe(true)
    storeMock.etebaseState.isInitialized = true
    view.rerender(<NotesPage />)
    expect(hasSkeleton()).toBe(false)
    expect(screen.getByText('No notes yet')).toBeInTheDocument()
  })
})

describe('NotesPage', () => {
  beforeEach(() => {
    localStorage.clear()
    useExperimentalStore.setState({ hydrated: true, notesAccounts: ['notes-test-account'] })
    storeMock.noteState.isLoading = true
    coldRestore()
    storeMock.noteState.notes = []
    storeMock.notebookState.lists = []
    storeMock.noteState.createNote.mockReset().mockResolvedValue(note('new-note', { title: 'Untitled' }))
    storeMock.noteState.updateNote.mockReset().mockResolvedValue(true)
    storeMock.noteState.deleteNote.mockReset().mockResolvedValue(true)
    storeMock.noteState.moveNote.mockReset().mockResolvedValue(null)
    storeMock.notebookState.activeListId = 'all'
    storeMock.authState.canWrite.mockReturnValue(true)
    useSidebarStore.setState({ isExpanded: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a loading skeleton and disables creation until notebooks are loaded', () => {
    renderWithIntl(<NotesPage />)
    expect(screen.getByRole('button', { name: 'New note' })).toBeDisabled()
    expect(screen.queryByText('No notes yet')).not.toBeInTheDocument()
  })

  it('blocks direct URLs until opted in without mounting the editor or mutating notes', () => {
    useExperimentalStore.setState({ notesAccounts: [] })
    loaded([note('existing')])
    renderWithIntl(<NotesPage />)
    expect(screen.getByRole('link', { name: 'Open Experimental settings' })).toHaveAttribute('href', '/settings/experimental')
    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument()
    expect(storeMock.noteState.createNote).not.toHaveBeenCalled()
    expect(storeMock.noteState.updateNote).not.toHaveBeenCalled()
    expect(storeMock.noteState.deleteNote).not.toHaveBeenCalled()
    act(() => useExperimentalStore.getState().setNotesEnabled('notes-test-account', true))
    expect(screen.getByRole('button', { name: /existing/ })).toBeInTheDocument()
  })

  it('flushes pending edits when hidden and preserves existing notes for re-enabling', async () => {
    loaded([note('existing')])
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /existing/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), { target: { value: 'Pending title' } })
    await act(async () => useExperimentalStore.getState().setNotesEnabled('notes-test-account', false))
    expect(storeMock.noteState.updateNote).toHaveBeenCalledWith('existing', expect.objectContaining({ title: 'Pending title' }), typedOn('existing', ''))
    expect(storeMock.noteState.deleteNote).not.toHaveBeenCalled()
    expect(storeMock.noteState.notes).toHaveLength(1)
    act(() => useExperimentalStore.getState().setNotesEnabled('notes-test-account', true))
    expect(screen.getByRole('button', { name: /existing/ })).toBeInTheDocument()
  })

  it('creates a note and opens it in the editor', async () => {
    loaded([])
    renderWithIntl(<NotesPage />)
    expect(screen.getByText('No notes yet')).toBeInTheDocument()

    // Header action and empty-state action both create.
    fireEvent.click(screen.getAllByRole('button', { name: 'New note' })[0]!)
    await vi.waitFor(() => expect(storeMock.noteState.createNote).toHaveBeenCalledTimes(1))

    storeMock.noteState.notes = [note('new-note', { title: 'Untitled' })]
    await act(async () => {})
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: 'Note title' })
    expect(title).toHaveValue('Untitled')
    expect(title).toHaveFocus()
    // The default title is selected so typing replaces it.
    expect(title.selectionStart).toBe(0)
    expect(title.selectionEnd).toBe('Untitled'.length)
  })

  it('does not flush an old account draft into the next account on gate unmount', async () => {
    loaded([note('existing')])
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /existing/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), { target: { value: 'Old account draft' } })
    await act(async () => {
      bumpAccountEpoch()
      useExperimentalStore.setState({ notesAccounts: [] })
    })
    expect(storeMock.noteState.updateNote).not.toHaveBeenCalled()
  })

  it('focuses the title only for a note created here, not for one opened from the list', async () => {
    loaded([note('existing', { title: 'Existing' })])
    renderWithIntl(<NotesPage />)

    fireEvent.click(screen.getByRole('button', { name: /Existing/ }))
    expect(screen.getByRole('textbox', { name: 'Note title' })).not.toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    await vi.waitFor(() => expect(storeMock.noteState.createNote).toHaveBeenCalledTimes(1))
    storeMock.noteState.notes = [note('new-note', { title: 'Untitled' }), note('existing', { title: 'Existing' })]
    await act(async () => {})
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Untitled')
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveFocus()

    // Reopening the same note from the list later does not grab focus again.
    fireEvent.click(screen.getByRole('button', { name: /Existing/ }))
    fireEvent.click(screen.getByRole('button', { name: /Untitled/ }))
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Untitled')
    expect(screen.getByRole('textbox', { name: 'Note title' })).not.toHaveFocus()
  })

  it('labels each note with the time when edited today, otherwise the date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 5, 12, 0, 0))
    loaded([
      note('today', { title: 'Today', updated_at: new Date(2026, 2, 5, 9, 30) }),
      note('this-year', { title: 'This year', updated_at: new Date(2026, 0, 20, 8, 0) }),
      note('last-year', { title: 'Last year', updated_at: new Date(2025, 11, 31, 8, 0) }),
    ])
    renderWithIntl(<NotesPage />)

    expect(screen.getByRole('button', { name: /Today/ })).toHaveTextContent(/9:30\sAM/)
    expect(screen.getByRole('button', { name: /This year/ })).toHaveTextContent('Jan 20')
    expect(screen.getByRole('button', { name: /Last year/ })).toHaveTextContent('Dec 31, 2025')
    expect(screen.getByRole('button', { name: /Last year/ }).querySelector('time'))
      .toHaveAttribute('datetime', new Date(2025, 11, 31, 8, 0).toISOString())
  })

  it('still lists notes when one carries an unusable date', () => {
    loaded([
      note('broken', { title: 'Broken date', updated_at: new Date(Number.NaN) }),
      note('fine', { title: 'Fine', updated_at: new Date('2026-01-02T00:00:00Z') }),
    ])
    renderWithIntl(<NotesPage />)

    expect(screen.getByRole('button', { name: /Broken date/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fine/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Broken date/ }).querySelector('time'))
      .not.toHaveAttribute('datetime')
    expect(screen.getByRole('button', { name: /Broken date/ })).not.toHaveTextContent('Invalid Date')
  })

  it('lists visible notes newest first, hides notes from hidden notebooks, and previews Markdown', async () => {
    loaded(
      [
        note('older', { title: 'Older', updated_at: new Date('2026-01-01T00:00:00Z') }),
        note('newer', { title: 'Newer', content: '# Hello', updated_at: new Date('2026-02-01T00:00:00Z') }),
        note('hidden-note', { title: 'Hidden note', notebookId: 'notes-2' }),
      ],
      [NOTEBOOK, { id: 'notes-2', name: 'Hidden', color: '#111', visible: false, accessLevel: 1 }],
    )

    renderWithIntl(<NotesPage />)

    const titles = screen.getAllByRole('button').map((b) => b.textContent ?? '').filter((text) => /Newer|Older|Hidden note/.test(text))
    expect(titles[0]).toContain('Newer')
    expect(titles[1]).toContain('Older')
    expect(screen.queryByText('Hidden note')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Newer/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('# Hello')
    // The editor stays mounted (hidden) during preview so its undo history survives.
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveClass('hidden')
    // The toggle keeps its label; only the pressed state changes.
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('textbox', { name: 'Note body' })).not.toHaveClass('hidden')
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveValue('# Hello')
  })

  it('autosaves the latest draft after a pause and keeps it when the same note refreshes from the server', async () => {
    vi.useFakeTimers()
    loaded([note('note-1', { title: 'Original', content: 'server body' })])

    const view = renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Original/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), { target: { value: 'Renamed' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note body' }), { target: { value: 'local draft' } })

    storeMock.noteState.notes = [note('note-1', { title: 'Original', content: 'stale server body', updated_at: new Date('2026-03-01T00:00:00Z') })]
    view.rerender(<NotesPage />)
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveValue('local draft')
    expect(storeMock.noteState.updateNote).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(storeMock.noteState.updateNote).toHaveBeenCalledTimes(1)
    expect(storeMock.noteState.updateNote).toHaveBeenCalledWith('note-1', { title: 'Renamed', content: 'local draft' }, typedOn('Original', 'server body'))
  })

  it('adopts a server refresh once the draft is saved', async () => {
    vi.useFakeTimers()
    loaded([note('note-1', { title: 'Original', content: 'server body' })])

    const view = renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Original/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note body' }), { target: { value: 'saved draft' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })

    storeMock.noteState.notes = [note('note-1', { title: 'Original', content: 'edited elsewhere' })]
    view.rerender(<NotesPage />)
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveValue('edited elsewhere')
  })

  it('flushes an unsaved draft when switching notes', async () => {
    loaded([
      note('a', { title: 'Note A', updated_at: new Date('2026-02-01T00:00:00Z') }),
      note('b', { title: 'Note B', updated_at: new Date('2026-01-01T00:00:00Z') }),
    ])
    renderWithIntl(<NotesPage />)

    fireEvent.click(screen.getByRole('button', { name: /Note A/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note body' }), { target: { value: 'typed in A' } })
    fireEvent.click(screen.getByRole('button', { name: /Note B/ }))

    await vi.waitFor(() => expect(storeMock.noteState.updateNote).toHaveBeenCalledWith('a', { title: 'Note A', content: 'typed in A' }, typedOn('Note A', '')))
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveValue('')
  })

  it('deletes the selected note after confirmation', async () => {
    loaded([note('note-1', { title: 'Doomed' })])
    renderWithIntl(<NotesPage />)

    fireEvent.click(screen.getByRole('button', { name: /Doomed/ }))
    // Preview and Delete sit in the editor toolbar with full-size touch targets.
    expect(screen.getByRole('button', { name: 'Preview' }).className).toContain('touch-target')
    expect(screen.getByRole('button', { name: 'Delete note' }).className).toContain('touch-target')
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    // The confirm dialog is exposed to assistive technology: query it by role.
    const dialog = screen.getByRole('dialog', { name: 'Delete note?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note' }))

    await vi.waitFor(() => expect(storeMock.noteState.deleteNote).toHaveBeenCalledWith('note-1'))
  })

  it('explains when every notebook is hidden and blocks creation', () => {
    loaded([note('note-1', { title: 'Hidden note' })], [{ ...NOTEBOOK, visible: false }])

    renderWithIntl(<NotesPage />)

    expect(screen.getByText('No visible notes')).toBeInTheDocument()
    expect(screen.getByText('Show a notebook to see its notes here.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New note' })).toBeDisabled()
  })

  it('disables editing, deletion, and creation for a read-only shared notebook', () => {
    loaded([note('note-1', { title: 'Shared note', content: 'Read only', notebookId: 'shared' })], [
      { id: 'shared', name: 'Shared', color: '#111', visible: true, accessLevel: 0 },
    ])

    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Shared note/ }))

    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveAttribute('readonly')
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Notebook' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New note' })).toBeDisabled()
  })

  it('exposes the mobile notebook switcher and back button with touch targets', () => {
    loaded([note('note-1', { title: 'Mobile' })])
    renderWithIntl(<NotesPage />)

    const folderButton = screen.getByRole('button', { name: 'Manage notebooks' })
    expect(folderButton.className).toContain('md:hidden')
    expect(folderButton.className).toContain('touch-target')
    fireEvent.click(folderButton)
    expect(screen.getByTestId('collection-sheet')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Mobile/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))
    expect(screen.queryByRole('textbox', { name: 'Note title' })).not.toBeInTheDocument()
  })

  it('searches titles and bodies locally without disturbing the open note', () => {
    loaded([
      note('a', { title: 'Alpha', content: 'plain body', updated_at: new Date('2026-03-01T00:00:00Z') }),
      note('b', { title: 'Beta', content: 'contains the needle here', updated_at: new Date('2026-02-01T00:00:00Z') }),
      note('c', { title: 'Needle in title', content: '', updated_at: new Date('2026-01-01T00:00:00Z') }),
    ])
    renderWithIntl(<NotesPage />)
    // One notebook: no filter chips to choose from.
    expect(screen.queryByRole('group', { name: 'Show notes from' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Alpha')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notes' }), { target: { value: 'NEEDLE' } })

    expect(screen.queryByRole('button', { name: /Alpha/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Beta/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Needle in title/ })).toBeInTheDocument()
    // The open note stays open even though it is filtered out of the list.
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Alpha')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notes' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching notes')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notes' }), { target: { value: '' } })
    expect(screen.getByRole('button', { name: /Alpha/ })).toBeInTheDocument()
  })

  it('shows autosave progress: unsaved, saving, saved, and not saved', async () => {
    vi.useFakeTimers()
    let resolveSave: (saved: boolean) => void = () => {}
    storeMock.noteState.updateNote.mockImplementation(() => new Promise<boolean>((resolve) => { resolveSave = resolve }))
    loaded([note('note-1', { title: 'Original', content: 'server body' })])
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Original/ }))
    expect(screen.getByRole('status')).toHaveTextContent('')

    fireEvent.change(screen.getByRole('textbox', { name: 'Note body' }), { target: { value: 'draft one' } })
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Saving')

    await act(async () => {
      resolveSave(true)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Saved')

    fireEvent.change(screen.getByRole('textbox', { name: 'Note body' }), { target: { value: 'draft two' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    await act(async () => {
      resolveSave(false)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Not saved')
  })

  it('filters by notebook, names each note\'s notebook in the combined view, and has a per-notebook empty state', () => {
    const EMPTY: Notebook = { id: 'notes-3', name: 'Empty', color: '#10b981', visible: true, accessLevel: 2 }
    loaded([
      note('a', { title: 'Alpha', notebookId: 'notes-1', updated_at: new Date('2026-02-01T00:00:00Z') }),
      note('b', { title: 'Beta', notebookId: 'notes-2', content: 'work body' }),
    ], [NOTEBOOK, WORK, EMPTY])
    renderWithIntl(<NotesPage />)

    const chips = screen.getByRole('group', { name: 'Show notes from' })
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Alpha/ })).toHaveTextContent('Personal Notes')
    expect(screen.getByRole('button', { name: /Beta/ })).toHaveTextContent('Work')

    fireEvent.click(within(chips).getByRole('button', { name: 'Work' }))
    expect(within(chips).getByRole('button', { name: 'Work' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /Alpha/ })).not.toBeInTheDocument()
    // Inside one notebook the rows no longer repeat its name.
    expect(screen.getByRole('button', { name: /Beta/ })).not.toHaveTextContent('Work')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notes' }), { target: { value: 'alpha' } })
    expect(screen.getByText('No matching notes')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search notes' }), { target: { value: '' } })

    fireEvent.click(within(chips).getByRole('button', { name: 'Empty' }))
    expect(screen.getByText('No notes in Empty')).toBeInTheDocument()
  })

  it('creates the note where the reader expects and says so in the New note tooltip', async () => {
    const ZULU: Notebook = { id: 'z', name: 'Zulu', color: '#111', visible: true, accessLevel: 2 }
    const ALPHA: Notebook = { id: 'a', name: 'Alpha', color: '#222', visible: true, accessLevel: 2 }
    loaded([note('n', { title: 'In Zulu', notebookId: 'z' })], [ZULU, ALPHA])
    const view = renderWithIntl(<NotesPage />)
    const newNote = () => screen.getByRole('button', { name: 'New note' })

    // Nothing starred and nothing open: the first notebook by name, not server order.
    expect(newNote()).toHaveAttribute('title', 'New note in Alpha')

    // The open note's notebook beats the alphabetical fallback.
    fireEvent.click(screen.getByRole('button', { name: /In Zulu/ }))
    expect(newNote()).toHaveAttribute('title', 'New note in Zulu')

    // A starred default beats the open note.
    storeMock.notebookState.activeListId = 'a'
    view.rerender(<NotesPage />)
    expect(newNote()).toHaveAttribute('title', 'New note in Alpha')

    // The notebook the list is filtered to beats everything.
    fireEvent.click(within(screen.getByRole('group', { name: 'Show notes from' })).getByRole('button', { name: 'Zulu' }))
    expect(newNote()).toHaveAttribute('title', 'New note in Zulu')
    fireEvent.click(newNote())
    await vi.waitFor(() => expect(storeMock.noteState.createNote).toHaveBeenCalledWith({ notebookId: 'z' }))
  })

  it('moves the open note to another notebook after saving its draft, and keeps it open under its new id', async () => {
    loaded([note('n1', { title: 'Mover', content: 'body', notebookId: 'notes-1' })], [NOTEBOOK, WORK])
    storeMock.noteState.moveNote.mockImplementation(async (id: string, notebookId: string) => {
      storeMock.noteState.notes = storeMock.noteState.notes.map((n) => (n.id === id ? { ...n, id: 'n1-moved', uid: 'n1-moved', notebookId } : n))
      return 'n1-moved'
    })
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Mover/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note body' }), { target: { value: 'draft' } })

    const picker = screen.getByRole('combobox', { name: 'Notebook' })
    expect(picker).toHaveValue('notes-1')
    fireEvent.change(picker, { target: { value: 'notes-2' } })

    await vi.waitFor(() => expect(storeMock.noteState.moveNote).toHaveBeenCalledWith('n1', 'notes-2'))
    // The draft was saved under the old item before the move.
    expect(storeMock.noteState.updateNote).toHaveBeenCalledWith('n1', { title: 'Mover', content: 'draft' }, typedOn('Mover', 'body'))
    expect(storeMock.noteState.updateNote.mock.invocationCallOrder[0]!).toBeLessThan(storeMock.noteState.moveNote.mock.invocationCallOrder[0]!)
    await vi.waitFor(() => expect(screen.getByRole('combobox', { name: 'Notebook' })).toHaveValue('notes-2'))
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Mover')
  })

  it('reports a move that did not happen and leaves the note where it was', async () => {
    loaded([note('n1', { title: 'Stay', notebookId: 'notes-1' })], [NOTEBOOK, WORK])
    storeMock.noteState.moveNote.mockResolvedValue(null)
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Stay/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Notebook' }), { target: { value: 'notes-2' } })

    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not move note'))
    expect(screen.getByRole('combobox', { name: 'Notebook' })).toHaveValue('notes-1')
    expect(screen.getByRole('combobox', { name: 'Notebook' })).toBeEnabled()
  })

  it('keeps the title and body read-only while the note moves, and editable again when the move fails (#849)', async () => {
    loaded([note('n1', { title: 'Mover', content: 'body', notebookId: 'notes-1' })], [NOTEBOOK, WORK])
    let finishMove: (movedId: string | null) => void = () => {}
    storeMock.noteState.moveNote.mockImplementation(() => new Promise<string | null>((resolve) => { finishMove = resolve }))
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Mover/ }))
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: 'Note title' })
    const body = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note body' })
    const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Notebook' })
    expect([title.readOnly, body.readOnly]).toEqual([false, false])

    fireEvent.change(picker, { target: { value: 'notes-2' } })
    await vi.waitFor(() => expect(storeMock.noteState.moveNote).toHaveBeenCalledWith('n1', 'notes-2'))
    expect([title.readOnly, body.readOnly, picker.disabled]).toEqual([true, true, true])

    await act(async () => { finishMove(null) })
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not move note'))
    expect([title.readOnly, body.readOnly]).toEqual([false, false])
  })

  it('keeps a note opened again during its own move read-only until the move ends (#849)', async () => {
    loaded([
      note('n1', { title: 'Mover', content: 'body', notebookId: 'notes-1' }),
      note('n2', { title: 'Other', notebookId: 'notes-1' }),
    ], [NOTEBOOK, WORK])
    let finishMove: (movedId: string | null) => void = () => {}
    storeMock.noteState.moveNote.mockImplementation(() => new Promise<string | null>((resolve) => { finishMove = resolve }))
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Mover/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Notebook' }), { target: { value: 'notes-2' } })
    await vi.waitFor(() => expect(storeMock.noteState.moveNote).toHaveBeenCalledWith('n1', 'notes-2'))

    // Another note, then this one again: a new editor while the move still runs.
    fireEvent.click(screen.getByRole('button', { name: /Other/ }))
    fireEvent.click(screen.getByRole('button', { name: /Mover/ }))
    const title = screen.getByRole<HTMLInputElement>('textbox', { name: 'Note title' })
    const body = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Note body' })
    const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Notebook' })
    expect(title).toHaveValue('Mover')
    expect([title.readOnly, body.readOnly, picker.disabled]).toEqual([true, true, true])

    await act(async () => { finishMove(null) })
    expect([title.readOnly, body.readOnly, picker.disabled]).toEqual([false, false, false])
  })

  it('stays on a note opened while another note moves, with its draft (#849)', async () => {
    loaded([
      note('n1', { title: 'Mover', content: 'body', notebookId: 'notes-1' }),
      note('n2', { title: 'Other', notebookId: 'notes-1' }),
    ], [NOTEBOOK, WORK])
    let finishMove: (movedId: string | null) => void = () => {}
    storeMock.noteState.moveNote.mockImplementation(() => new Promise<string | null>((resolve) => { finishMove = resolve }))
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Mover/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Notebook' }), { target: { value: 'notes-2' } })
    await vi.waitFor(() => expect(storeMock.noteState.moveNote).toHaveBeenCalledWith('n1', 'notes-2'))

    fireEvent.click(screen.getByRole('button', { name: /Other/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), { target: { value: 'Draft while moving' } })
    // The store swaps in the copy, then the move resolves with the copy's id.
    await act(async () => {
      storeMock.noteState.notes = storeMock.noteState.notes.map((n) => (n.id === 'n1' ? { ...n, id: 'n1-moved', uid: 'n1-moved', notebookId: 'notes-2' } : n))
      finishMove('n1-moved')
    })
    expect([
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Note title' }).value,
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Notebook' }).value,
    ]).toEqual(['Draft while moving', 'notes-1'])
  })

  it('offers notebook management on desktop while the sidebar is collapsed', () => {
    loaded([note('n1', { title: 'Any' })])
    useSidebarStore.setState({ isExpanded: false })
    renderWithIntl(<NotesPage />)

    const desktopButton = screen.getAllByRole('button', { name: 'Manage notebooks' }).find((button) => button.className.includes('max-md:hidden'))
    expect(desktopButton).toBeDefined()
    // A responsive variant, not a plain `hidden`: touch-target sets display too and would win.
    expect(desktopButton!.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    fireEvent.click(desktopButton!)
    expect(useSidebarStore.getState().isExpanded).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Manage notebooks' })).toHaveLength(1)
  })

  it('keeps a single pane on tablet widths while the sidebar is open, so the editor is not squeezed', () => {
    loaded([note('n1', { title: 'Wide' })])
    useSidebarStore.setState({ isExpanded: true })
    renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Wide/ }))
    const listColumn = () => screen.getByRole('searchbox', { name: 'Search notes' }).closest('.flex-col')!

    expect(screen.getByRole('button', { name: 'Back to notes' }).className).toContain('lg:hidden')
    expect(listColumn().className).toContain('hidden lg:flex')

    act(() => {
      useSidebarStore.setState({ isExpanded: false })
    })
    expect(screen.getByRole('button', { name: 'Back to notes' }).className).toContain('md:hidden')
    expect(listColumn().className).toContain('hidden md:flex')
  })

  it('shows the offline notice', () => {
    storeMock.syncState.isOnline = false
    loaded([])
    renderWithIntl(<NotesPage />)
    expect(screen.getByText(/You are offline/)).toBeInTheDocument()
    storeMock.syncState.isOnline = true
  })

  it('shows the compact Experimental · Web app only label next to the heading on every layout', () => {
    loaded([note('note-1', { title: 'Any' })])
    renderWithIntl(<NotesPage />)

    // One label, attached to the Notes heading, with no responsive hiding:
    // the same DOM serves desktop and mobile (only the panes below switch).
    const label = screen.getByTestId('notes-experimental-label')
    expect(screen.getAllByTestId('notes-experimental-label')).toHaveLength(1)
    expect(label).toHaveTextContent('Experimental · Web app only')
    expect(label.className).not.toMatch(/(^|\s)(hidden|md:hidden|lg:hidden|max-md:hidden)(\s|$)/)
    // Inside the heading, so screen readers announce it as part of the name.
    const heading = screen.getByRole('heading', { level: 2, name: 'Notes Experimental · Web app only' })
    expect(label.parentElement).toBe(heading)

    // Still present with a note open (mobile single-pane view).
    fireEvent.click(screen.getByRole('button', { name: /Any/ }))
    expect(screen.getByTestId('notes-experimental-label')).toHaveTextContent('Experimental · Web app only')
  })

  // #295: the mobile bottom nav sits outside the page's `main`, which is its own stacking context, so a
  // confirmation rendered inside the page paints under the nav and the nav stays tappable while it is open.
  it('portals the note delete confirmation to <body> at its call site; cancel keeps the note and confirm deletes once', async () => {
    loaded([note('note-1', { title: 'Doomed' })])
    const { container } = renderWithIntl(<NotesPage />)
    fireEvent.click(screen.getByRole('button', { name: /Doomed/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete note?' })
    expect(within(dialog).getByRole('button', { name: 'Delete note' })).toBeInTheDocument()

    expect(container.contains(dialog), 'confirmation is rendered inside the page container').toBe(false)
    let outer: HTMLElement | null = null
    for (let node: HTMLElement | null = dialog; node && node !== document.body; node = node.parentElement) {
      if (node.classList.contains('fixed')) outer = node
    }
    expect(outer, 'fixed overlay wrapper').not.toBeNull()
    expect(outer!.parentElement, 'overlay wrapper is a direct child of <body>').toBe(document.body)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Delete note?' })).not.toBeInTheDocument()
    expect(storeMock.noteState.deleteNote).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Doomed')

    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete note?' })).getByRole('button', { name: 'Delete note' }))
    expect(screen.queryByRole('dialog', { name: 'Delete note?' })).not.toBeInTheDocument()
    await vi.waitFor(() => expect(storeMock.noteState.deleteNote).toHaveBeenCalledTimes(1))
    expect(storeMock.noteState.deleteNote).toHaveBeenCalledWith('note-1')
  })
})
