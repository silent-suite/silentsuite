import { act, fireEvent, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NotesPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import type { Note } from '@silentsuite/core'
import type { Notebook } from '@/app/stores/use-notebook-store'
import { useSidebarStore } from '@/app/stores/use-sidebar-store'

const storeMock = vi.hoisted(() => ({
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

function note(id: string, overrides: Partial<Note> = {}): Note {
  const date = new Date('2026-01-01T00:00:00Z')
  return { id, uid: id, title: id, content: '', notebookId: 'notes-1', created_at: date, updated_at: date, ...overrides }
}

function loaded(notes: Note[], lists: Notebook[] = [NOTEBOOK]) {
  storeMock.noteState.isLoading = false
  storeMock.noteState.notes = notes
  storeMock.notebookState.lists = lists
}

describe('NotesPage', () => {
  beforeEach(() => {
    storeMock.noteState.isLoading = true
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
    expect(storeMock.noteState.updateNote).toHaveBeenCalledWith('note-1', { title: 'Renamed', content: 'local draft' })
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

    await vi.waitFor(() => expect(storeMock.noteState.updateNote).toHaveBeenCalledWith('a', { title: 'Note A', content: 'typed in A' }))
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
    expect(storeMock.noteState.updateNote).toHaveBeenCalledWith('n1', { title: 'Mover', content: 'draft' })
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
})
