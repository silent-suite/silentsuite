import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'

const updateCollectionMeta = vi.fn()

const mockNotebookState = {
  lists: [
    { id: 'notes-1', name: 'Personal', color: '#f59e0b', visible: true, accessLevel: 1 },
    { id: 'notes-2', name: 'Work', color: '#3b82f6', visible: false, accessLevel: 2 },
  ],
  activeListId: 'notes-1',
  toggleVisibility: vi.fn(),
  setActiveList: vi.fn(),
  getNextColor: vi.fn(() => '#10b981'),
}

const mockEtebaseState = {
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  updateCollectionMeta,
}

vi.mock('@/app/stores/use-notebook-store', () => ({
  useNotebookStore: () => mockNotebookState,
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: <T,>(selector: (s: typeof mockEtebaseState) => T) => selector(mockEtebaseState),
}))

const mockNoteState = {
  notes: [
    { id: 'n1', notebookId: 'notes-1' },
    { id: 'n2', notebookId: 'notes-1' },
    { id: 'n3', notebookId: 'notes-2' },
  ],
}

vi.mock('@/app/stores/use-note-store', () => ({
  useNoteStore: <T,>(selector: (s: typeof mockNoteState) => T) => selector(mockNoteState),
}))

import { NotebookListPanel } from '../NotebookListPanel'

describe('NotebookListPanel', () => {
  beforeEach(() => {
    updateCollectionMeta.mockClear()
    mockEtebaseState.createCollection.mockReset()
    mockEtebaseState.deleteCollection.mockReset()
    mockNotebookState.toggleVisibility.mockClear()
    mockNotebookState.setActiveList.mockClear()
  })

  it('persists notebook color changes through collection metadata', () => {
    renderWithIntl(<NotebookListPanel />)

    fireEvent.click(screen.getByLabelText('Open Personal actions'))
    fireEvent.change(screen.getByLabelText('Change Personal color'), { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('notes', 'notes-1', { color: '#ff0000' })
  })

  it('renames notebooks through collection metadata', () => {
    renderWithIntl(<NotebookListPanel />)

    fireEvent.click(screen.getByLabelText('Open Personal actions'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByLabelText('Rename Personal')
    fireEvent.change(input, { target: { value: 'Journal' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateCollectionMeta).toHaveBeenCalledWith('notes', 'notes-1', { name: 'Journal' })
  })

  it('sets hidden notebooks as default and makes them visible', () => {
    renderWithIntl(<NotebookListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work actions'))
    fireEvent.click(screen.getByText('Set as default'))

    expect(mockNotebookState.toggleVisibility).toHaveBeenCalledWith('notes-2')
    expect(mockNotebookState.setActiveList).toHaveBeenCalledWith('notes-2')
  })

  it('confirms notebook deletion in the app dialog, naming the notebook and counting its notes', async () => {
    mockEtebaseState.deleteCollection.mockResolvedValue(undefined)
    renderWithIntl(<NotebookListPanel />)

    fireEvent.click(screen.getByLabelText('Open Personal actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete notebook' }))

    expect(screen.getByText('Delete notebook?')).toBeInTheDocument()
    expect(screen.getByText(/"Personal" and the 2 notes in it will be permanently deleted/)).toBeInTheDocument()
    expect(mockEtebaseState.deleteCollection).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog', { name: 'Delete notebook?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete notebook' }))
    await vi.waitFor(() => expect(mockEtebaseState.deleteCollection).toHaveBeenCalledWith('notes', 'notes-1'))
    expect(screen.queryByText('Delete notebook?')).not.toBeInTheDocument()
  })

  it('cancels notebook deletion without touching the server', () => {
    renderWithIntl(<NotebookListPanel />)
    fireEvent.click(screen.getByLabelText('Open Work actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete notebook' }))
    expect(screen.getByText(/"Work" and the 1 note in it/)).toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete notebook?' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete notebook?')).not.toBeInTheDocument()
    expect(mockEtebaseState.deleteCollection).not.toHaveBeenCalled()
  })

  it('creates a new encrypted notebook collection', async () => {
    mockEtebaseState.createCollection.mockResolvedValue('notes-3')
    renderWithIntl(<NotebookListPanel />)

    fireEvent.click(screen.getByLabelText('Add notebook'))
    const input = screen.getByLabelText('Notebook name')
    fireEvent.change(input, { target: { value: 'Recipes' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockEtebaseState.createCollection).toHaveBeenCalledWith('notes', 'Recipes', '#10b981')
    await vi.waitFor(() => expect(screen.queryByLabelText('Notebook name')).not.toBeInTheDocument())
  })
})
