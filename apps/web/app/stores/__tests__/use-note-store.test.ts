import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Note } from '@silentsuite/core'
import { useNoteStore } from '../use-note-store'
import { useEtebaseStore } from '../use-etebase-store'
import { useNotebookStore } from '../use-notebook-store'
import { useAuthStore } from '../use-auth-store'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)

function note(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    uid: id,
    title: 'Note',
    content: 'Body',
    notebookId: 'notes-1',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function etebase(overrides: Record<string, unknown>) {
  useEtebaseStore.setState({ account: {}, itemCache: new Map(), ...overrides } as any)
}

describe('useNoteStore', () => {
  beforeEach(() => {
    toastMock.showErrorToast.mockReset()
    useAuthStore.setState({ subscriptionStatus: 'active' })
    useNoteStore.setState({ notes: [], isLoading: false, syncStatus: 'synced' })
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNotebookStore.setState({
      lists: [{ id: 'notes-1', name: 'Notes', color: '#fff', visible: true, accessLevel: 1 }],
      activeListId: 'all',
    })
  })

  describe('createNote', () => {
    it('creates the Etebase item with the body as content and the title/mtime as item meta', async () => {
      const createItem = vi.fn(async () => 'remote-note')
      etebase({ createItem })

      const created = await useNoteStore.getState().createNote({ title: 'Titled', content: '# Hi' })

      expect(createItem).toHaveBeenCalledWith(
        'notes',
        '# Hi',
        undefined,
        'notes-1',
        { name: 'Titled', mtime: created.updated_at.getTime() },
      )
      expect(created).toMatchObject({ id: 'remote-note', uid: 'remote-note', title: 'Titled', content: '# Hi', notebookId: 'notes-1' })
      expect(useNoteStore.getState().notes).toEqual([created])
    })

    it('defaults an empty title to Untitled and an empty body', async () => {
      const createItem = vi.fn(async () => 'remote-note')
      etebase({ createItem })

      const created = await useNoteStore.getState().createNote()

      expect(created.title).toBe('Untitled')
      expect(created.content).toBe('')
    })

    it('adds nothing locally and rejects when the item cannot be created', async () => {
      etebase({ createItem: vi.fn(async () => null) })

      await expect(useNoteStore.getState().createNote({ title: 'Lost' })).rejects.toThrow('could not be saved')

      expect(useNoteStore.getState().notes).toEqual([])
    })

    it('reports and rejects when creation throws', async () => {
      etebase({ createItem: vi.fn(async () => { throw new Error('boom') }) })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(useNoteStore.getState().createNote({ title: 'Lost' })).rejects.toThrow()

      expect(useNoteStore.getState().notes).toEqual([])
      expect(toastMock.showErrorToast).toHaveBeenCalledWith('Failed to save note. Please try again.')
      errorSpy.mockRestore()
    })

    it('targets the active notebook when it is shown and writable, else the first shown writable notebook', async () => {
      const createItem = vi.fn(async () => 'remote-note')
      etebase({ createItem })
      useNotebookStore.setState({
        lists: [
          { id: 'readonly', name: 'Shared', color: '#fff', visible: true, accessLevel: 0 },
          { id: 'hidden', name: 'Hidden', color: '#fff', visible: false, accessLevel: 2 },
          { id: 'mine', name: 'Mine', color: '#fff', visible: true, accessLevel: 2 },
        ],
        activeListId: 'readonly',
      })

      expect((await useNoteStore.getState().createNote()).notebookId).toBe('mine')

      useNotebookStore.setState({ activeListId: 'hidden' })
      expect((await useNoteStore.getState().createNote()).notebookId).toBe('mine')

      useNotebookStore.getState().toggleVisibility('hidden')
      expect((await useNoteStore.getState().createNote()).notebookId).toBe('hidden')
    })

    it('refuses read-only notebooks and notebooks without a known access level', async () => {
      const createItem = vi.fn(async () => 'remote-note')
      etebase({ createItem })
      useNotebookStore.setState({
        lists: [
          { id: 'readonly', name: 'Shared', color: '#fff', visible: true, accessLevel: 0 },
          { id: 'default', name: 'Personal Notes', color: '#fff', visible: true },
        ],
        activeListId: 'all',
      })

      await expect(useNoteStore.getState().createNote({ notebookId: 'readonly' })).rejects.toThrow('No writable notebook')
      await expect(useNoteStore.getState().createNote()).rejects.toThrow('No writable notebook')
      expect(createItem).not.toHaveBeenCalled()
      expect(useNoteStore.getState().notes).toEqual([])
    })

    it('rejects when the account is read-only', async () => {
      useAuthStore.setState({ subscriptionStatus: 'expired' })
      await expect(useNoteStore.getState().createNote()).rejects.toThrow('subscription')
    })
  })

  describe('updateNote', () => {
    it('sends the body as content and the title/mtime as meta, keeping offline content encrypted locally', async () => {
      const updateItem = vi.fn(async () => 'remote')
      etebase({ updateItem, itemCache: new Map([['note-1', {}]]) })
      useNoteStore.setState({ notes: [note('note-1')] })

      await expect(useNoteStore.getState().updateNote('note-1', { title: 'Updated', content: 'new body' })).resolves.toBe(true)

      const stored = useNoteStore.getState().notes[0]!
      expect(stored).toMatchObject({ title: 'Updated', content: 'new body' })
      expect(updateItem).toHaveBeenCalledWith('notes', 'note-1', 'new body', {
        meta: { name: 'Updated', mtime: stored.updated_at.getTime() },
        persistEncryptedOfflineContent: true,
        collectionUid: 'notes-1',
      })
    })

    it('reports true for a queued offline save and false when the save failed', async () => {
      const updateItem = vi.fn(async () => 'queued' as const)
      etebase({ updateItem, itemCache: new Map([['note-1', {}]]) })
      useNoteStore.setState({ notes: [note('note-1')] })
      await expect(useNoteStore.getState().updateNote('note-1', { content: 'offline' })).resolves.toBe(true)

      updateItem.mockResolvedValueOnce(false as never)
      await expect(useNoteStore.getState().updateNote('note-1', { content: 'failed' })).resolves.toBe(false)
    })

    it('reports false and toasts when the etebase store throws', async () => {
      etebase({ updateItem: vi.fn(async () => { throw new Error('boom') }), itemCache: new Map([['note-1', {}]]) })
      useNoteStore.setState({ notes: [note('note-1')] })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(useNoteStore.getState().updateNote('note-1', { content: 'x' })).resolves.toBe(false)

      expect(toastMock.showErrorToast).toHaveBeenCalledWith('Failed to save note. Please try again.')
      errorSpy.mockRestore()
    })

    it('ignores unknown notes and notes in read-only notebooks', async () => {
      const updateItem = vi.fn(async () => 'remote')
      etebase({ updateItem, itemCache: new Map([['shared-1', {}]]) })
      useNotebookStore.setState({
        lists: [
          { id: 'notes-1', name: 'Notes', color: '#fff', visible: true, accessLevel: 1 },
          { id: 'shared', name: 'Shared', color: '#fff', visible: true, accessLevel: 0 },
        ],
      })
      useNoteStore.setState({ notes: [note('shared-1', { notebookId: 'shared' })] })

      await expect(useNoteStore.getState().updateNote('missing', { title: 'x' })).resolves.toBe(false)
      await expect(useNoteStore.getState().updateNote('shared-1', { title: 'x' })).resolves.toBe(false)

      expect(updateItem).not.toHaveBeenCalled()
      expect(useNoteStore.getState().notes[0]!.title).toBe('Note')
    })

    it('still hands an edit to the store when no Etebase item is in memory, as after a reload while offline', async () => {
      const updateItem = vi.fn(async () => 'queued' as const)
      etebase({ updateItem, itemCache: new Map() })
      useNoteStore.setState({ notes: [note('cached-1', { title: 'Cached', content: 'old' })] })

      await expect(useNoteStore.getState().updateNote('cached-1', { content: 'edited after reload' })).resolves.toBe(true)

      const stored = useNoteStore.getState().notes[0]!
      expect(stored.content).toBe('edited after reload')
      expect(updateItem).toHaveBeenCalledWith('notes', 'cached-1', 'edited after reload', {
        meta: { name: 'Cached', mtime: stored.updated_at.getTime() },
        persistEncryptedOfflineContent: true,
        collectionUid: 'notes-1',
      })
    })
  })

  describe('deleteNote', () => {
    it('removes the note locally and remotely', async () => {
      const deleteItem = vi.fn(async () => 'remote' as const)
      etebase({ deleteItem, itemCache: new Map([['note-1', {}]]) })
      useNoteStore.setState({ notes: [note('note-1')] })

      await expect(useNoteStore.getState().deleteNote('note-1')).resolves.toBe(true)

      expect(deleteItem).toHaveBeenCalledWith('notes', 'note-1', { collectionUid: 'notes-1' })
      expect(useNoteStore.getState().notes).toEqual([])
    })

    it('hands a delete to the store when no Etebase item is in memory and keeps the note removed once queued', async () => {
      const deleteItem = vi.fn(async () => 'queued' as const)
      etebase({ deleteItem, itemCache: new Map() })
      useNoteStore.setState({ notes: [note('cached-1')] })

      await expect(useNoteStore.getState().deleteNote('cached-1')).resolves.toBe(true)

      expect(deleteItem).toHaveBeenCalledWith('notes', 'cached-1', { collectionUid: 'notes-1' })
      expect(useNoteStore.getState().notes).toEqual([])
    })

    it('restores the note when the remote delete fails', async () => {
      const original = note('note-1')
      etebase({ deleteItem: vi.fn(async () => false as const), itemCache: new Map([['note-1', {}]]) })
      useNoteStore.setState({ notes: [original] })

      await expect(useNoteStore.getState().deleteNote('note-1')).resolves.toBe(false)

      expect(useNoteStore.getState().notes).toEqual([original])
    })

    it('refuses to delete from a read-only notebook', async () => {
      const deleteItem = vi.fn()
      etebase({ deleteItem, itemCache: new Map([['shared-1', {}]]) })
      useNotebookStore.setState({ lists: [{ id: 'shared', name: 'Shared', color: '#fff', visible: true, accessLevel: 0 }] })
      useNoteStore.setState({ notes: [note('shared-1', { notebookId: 'shared' })] })

      await expect(useNoteStore.getState().deleteNote('shared-1')).resolves.toBe(false)

      expect(deleteItem).not.toHaveBeenCalled()
      expect(useNoteStore.getState().notes).toHaveLength(1)
    })
  })

  describe('moveNote', () => {
    const notebooks = [
      { id: 'notes-1', name: 'Notes', color: '#fff', visible: true, accessLevel: 1 },
      { id: 'notes-2', name: 'Work', color: '#00f', visible: true, accessLevel: 2 },
      { id: 'shared', name: 'Shared', color: '#f00', visible: true, accessLevel: 0 },
    ]

    it('recreates the note in the target notebook with its title and mtime, then follows the new id', async () => {
      const moveItem = vi.fn(async () => 'note-moved')
      etebase({ moveItem, itemCache: new Map([['note-1', {}]]) })
      useNotebookStore.setState({ lists: notebooks })
      const original = note('note-1', { title: 'Keep me', content: 'body' })
      useNoteStore.setState({ notes: [original] })

      await expect(useNoteStore.getState().moveNote('note-1', 'notes-2')).resolves.toBe('note-moved')

      expect(moveItem).toHaveBeenCalledWith('notes', 'note-1', 'body', 'notes-2', 'notes-1', { name: 'Keep me', mtime: original.updated_at.getTime() })
      expect(useNoteStore.getState().notes).toEqual([{ ...original, id: 'note-moved', uid: 'note-moved', notebookId: 'notes-2' }])
    })

    it('leaves the note in place when the move does not happen', async () => {
      const moveItem = vi.fn(async () => null)
      etebase({ moveItem, itemCache: new Map([['note-1', {}]]) })
      useNotebookStore.setState({ lists: notebooks })
      const original = note('note-1')
      useNoteStore.setState({ notes: [original] })

      await expect(useNoteStore.getState().moveNote('note-1', 'notes-2')).resolves.toBeNull()
      expect(useNoteStore.getState().notes).toEqual([original])

      moveItem.mockRejectedValueOnce(new Error('boom'))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(useNoteStore.getState().moveNote('note-1', 'notes-2')).resolves.toBeNull()
      expect(toastMock.showErrorToast).toHaveBeenCalledWith('Failed to move note. Please try again.')
      expect(useNoteStore.getState().notes).toEqual([original])
      errorSpy.mockRestore()
    })

    it('refuses read-only targets and sources and unknown notes, and reports the same id for a no-op', async () => {
      const moveItem = vi.fn(async () => 'note-moved')
      etebase({ moveItem, itemCache: new Map([['note-1', {}], ['shared-1', {}]]) })
      useNotebookStore.setState({ lists: notebooks })
      useNoteStore.setState({ notes: [note('note-1'), note('shared-1', { notebookId: 'shared' })] })

      await expect(useNoteStore.getState().moveNote('note-1', 'shared')).resolves.toBeNull()
      await expect(useNoteStore.getState().moveNote('shared-1', 'notes-2')).resolves.toBeNull()
      await expect(useNoteStore.getState().moveNote('missing', 'notes-2')).resolves.toBeNull()
      await expect(useNoteStore.getState().moveNote('note-1', 'notes-1')).resolves.toBe('note-1')
      expect(moveItem).not.toHaveBeenCalled()
    })
  })

  it('creates in the first shown writable notebook by name when nothing is starred, whatever order the server uses', async () => {
    const createItem = vi.fn(async () => 'remote-note')
    etebase({ createItem })
    useNotebookStore.setState({
      lists: [
        { id: 'z', name: 'Zulu', color: '#fff', visible: true, accessLevel: 2 },
        { id: 'a', name: 'Alpha', color: '#fff', visible: true, accessLevel: 2 },
      ],
      activeListId: 'all',
    })

    expect((await useNoteStore.getState().createNote()).notebookId).toBe('a')
  })

  it('syncFromRemote replaces notes and clears the loading flag', () => {
    useNoteStore.setState({ isLoading: true })
    useNoteStore.getState().syncFromRemote([note('remote-1')])
    expect(useNoteStore.getState().notes.map((n) => n.id)).toEqual(['remote-1'])
    expect(useNoteStore.getState().isLoading).toBe(false)
  })
})
