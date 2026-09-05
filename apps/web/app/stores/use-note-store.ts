'use client'

import { create } from 'zustand'
import type { Note, SyncStatus } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { canWriteNotebook, newNoteNotebook, useNotebookStore } from '@/app/stores/use-notebook-store'

interface NewNote {
  title?: string
  content?: string
  notebookId?: string
}

interface NoteState {
  notes: Note[]
  isLoading: boolean
  syncStatus: SyncStatus
}

interface NoteActions {
  /** Creates the note in Etebase first and only then adds it locally; throws if that fails. */
  createNote: (note?: NewNote) => Promise<Note>
  /** Resolves true once the change is saved remotely or queued for offline replay. */
  updateNote: (id: string, patch: Partial<Pick<Note, 'title' | 'content'>>) => Promise<boolean>
  /** Resolves false (and restores the note) when the server delete fails. */
  deleteNote: (id: string) => Promise<boolean>
  /**
   * Moves a note to another notebook. An Etebase item belongs to one
   * collection, so the note is recreated there and removed from its old
   * notebook. Resolves with the note's new id, or null when nothing moved.
   */
  moveNote: (id: string, notebookId: string) => Promise<string | null>
  canWriteNote: (note: Note) => boolean
  syncFromRemote: (notes: Note[]) => void
}

/** The starred notebook when it is shown and writable, else the first such notebook by name. */
function defaultNotebookId(): string | undefined {
  const { lists, activeListId } = useNotebookStore.getState()
  return newNoteNotebook(lists, activeListId)?.id
}

export const useNoteStore = create<NoteState & NoteActions>()(
  (set, get) => ({
    notes: [],
    isLoading: true,
    syncStatus: 'synced' as SyncStatus,

    createNote: async (newNote: NewNote = {}) => {
      if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
      const notebookId = newNote.notebookId ?? defaultNotebookId()
      const notebook = useNotebookStore.getState().lists.find((list) => list.id === notebookId)
      if (!notebook || !canWriteNotebook(notebook)) throw new Error('No writable notebook is available.')

      const now = new Date()
      const draft: Omit<Note, 'id' | 'uid'> = {
        title: newNote.title?.trim() ? newNote.title : 'Untitled',
        content: newNote.content ?? '',
        notebookId,
        created_at: now,
        updated_at: now,
      }

      // The list only ever shows notes that already have an Etebase item UID,
      // so there is no window in which an entry exists but cannot be saved.
      const etebase = useEtebaseStore.getState()
      let itemUid: string | null = null
      try {
        const { noteToItemMeta } = await import('@silentsuite/core')
        itemUid = etebase.account
          ? await etebase.createItem('notes', draft.content, undefined, notebookId, noteToItemMeta(draft))
          : null
      } catch (err) {
        console.error('[note-store] Failed to sync new note to Etebase', getSafeErrorDetails(err))
        showErrorToast('Failed to save note. Please try again.')
      }
      // The etebase store already reported why the item was not created.
      if (!itemUid) throw new Error('Note could not be saved.')

      const note: Note = { id: itemUid, uid: itemUid, ...draft }
      set((state) => ({ notes: [...state.notes, note] }))
      return note
    },

    updateNote: async (id, patch) => {
      if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
      const existing = get().notes.find((n) => n.id === id)
      if (!existing || !get().canWriteNote(existing)) return false

      const updated: Note = { ...existing, ...patch, updated_at: new Date() }
      set((state) => ({ notes: state.notes.map((n) => (n.id === id ? updated : n)) }))

      const etebase = useEtebaseStore.getState()
      if (!etebase.account) return false

      try {
        const { noteToItemMeta } = await import('@silentsuite/core')
        const outcome = await etebase.updateItem('notes', id, updated.content, {
          meta: noteToItemMeta(updated),
          // Offline edits keep their body and title in the encrypted local
          // cache; the queue entry itself stays content-free.
          persistEncryptedOfflineContent: true,
          // After a reload while offline the note is known only from the local
          // cache, with no Etebase item in memory; the store then queues the
          // edit by UID under its notebook instead of dropping it.
          collectionUid: existing.notebookId,
        })
        return outcome !== false
      } catch (err) {
        console.error('[note-store] Failed to sync note update to Etebase', getSafeErrorDetails(err))
        showErrorToast('Failed to save note. Please try again.')
        return false
      }
    },

    deleteNote: async (id) => {
      if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
      const note = get().notes.find((n) => n.id === id)
      if (!note || !get().canWriteNote(note)) return false

      set((state) => ({ notes: state.notes.filter((n) => n.id !== id) }))

      const etebase = useEtebaseStore.getState()
      if (!etebase.account) return true

      try {
        // The notebook lets the store queue the delete by UID when no item is in memory.
        const outcome = await etebase.deleteItem('notes', id, { collectionUid: note.notebookId })
        if (outcome !== false) return true
      } catch (err) {
        console.error('[note-store] Failed to sync note deletion to Etebase', getSafeErrorDetails(err))
        showErrorToast('Failed to delete note. Please try again.')
      }

      // The server still has the note; put it back.
      set((state) => (state.notes.some((n) => n.id === id) ? state : { notes: [...state.notes, note] }))
      return false
    },

    moveNote: async (id, notebookId) => {
      if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
      const existing = get().notes.find((n) => n.id === id)
      if (!existing || !get().canWriteNote(existing)) return null
      if (existing.notebookId === notebookId) return id
      const target = useNotebookStore.getState().lists.find((list) => list.id === notebookId)
      if (!target || !canWriteNotebook(target)) return null

      const etebase = useEtebaseStore.getState()
      if (!etebase.account || !etebase.itemCache.has(id)) return null

      try {
        const { noteToItemMeta } = await import('@silentsuite/core')
        // A move is not an edit: the title and last-edit time travel with the note.
        const movedId = await etebase.moveItem('notes', id, existing.content, notebookId, existing.notebookId, noteToItemMeta(existing))
        if (!movedId) return null
        set((state) => ({
          notes: state.notes.map((n) => (n.id === id ? { ...existing, id: movedId, uid: movedId, notebookId } : n)),
        }))
        return movedId
      } catch (err) {
        console.error('[note-store] Failed to move note', getSafeErrorDetails(err))
        showErrorToast('Failed to move note. Please try again.')
        return null
      }
    },

    canWriteNote: (note) => {
      if (!useAuthStore.getState().canWrite()) return false
      const notebook = useNotebookStore.getState().lists.find((list) => list.id === note.notebookId)
      return canWriteNotebook(notebook)
    },

    syncFromRemote: (remoteNotes) => {
      set({ notes: remoteNotes, isLoading: false, syncStatus: 'synced' })
    },
  }),
)

export type { NewNote }
