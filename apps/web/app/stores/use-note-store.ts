'use client'

import { create } from 'zustand'
import type { Note, SyncStatus } from '@silentsuite/core'
import {
  hasOutstandingNoteCustody,
  noteEditorMatches,
  proveLiveNoteBase,
  proveNoteRevision,
  useEtebaseStore,
  type SealedEditingBase,
} from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { AccountBoundaryChangedError, getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { canWriteNotebook, newNoteNotebook, useNotebookStore } from '@/app/stores/use-notebook-store'

interface NewNote {
  title?: string
  content?: string
  notebookId?: string
}

/**
 * A note with the server revision its title and content were read at (#744),
 * paired from the same SDK item; null when unknown. In memory only: the core
 * Note type, serializeNote, the display cache and export never carry it.
 */
export type StoredNote = Note & { revision: string | null }

/** What an editor captured with a save: the base its text was typed on. */
export interface NoteSaveCapture {
  base: SealedEditingBase
  /** The reconciliation obligation captured with the save, compared by identity (#744 §5). */
  obligation?: object
  /** Called with the exact saved etag of this save's own accepted write. */
  onSaved?: (etag: string) => void
}

/** A mounted note editor's registration (#744 §2): read-only views of its own lineage state. */
export interface MountedNoteEditor {
  periodGen: () => number
  isClean: () => boolean
  chainIdle: () => boolean
  base: () => SealedEditingBase
  flushAndWait: () => Promise<void>
}

// In memory only. Each entry keeps the account epoch it was made under, so a
// later account never sees an earlier account's obligation or editor.
const noteObligations = new Map<string, { obligation: object; accountEpoch: number }>()
const mountedEditors = new Map<string, { editor: MountedNoteEditor; accountEpoch: number }>()

/** The note's current reconciliation obligation in this account, if any. */
export function getNoteObligation(id: string): object | undefined {
  const entry = noteObligations.get(id)
  if (!entry) return undefined
  if (!isCurrentAccountEpoch(entry.accountEpoch)) {
    noteObligations.delete(id)
    return undefined
  }
  return entry.obligation
}

/** Sets the note's obligation if absent (triggers T1–T3) and returns the current one. */
export function markNoteObligation(id: string): object {
  const existing = getNoteObligation(id)
  if (existing) return existing
  const obligation = {}
  noteObligations.set(id, { obligation, accountEpoch: getAccountEpoch() })
  return obligation
}

/** Releases the note's obligation only if it is still this exact object. */
export function releaseNoteObligation(id: string, obligation: object): void {
  if (noteObligations.get(id)?.obligation === obligation) noteObligations.delete(id)
}

/** Registers a mounted editor; the returned function removes only this registration. */
export function registerNoteEditor(id: string, editor: MountedNoteEditor): () => void {
  const entry = { editor, accountEpoch: getAccountEpoch() }
  mountedEditors.set(id, entry)
  return () => {
    if (mountedEditors.get(id) === entry) mountedEditors.delete(id)
  }
}

/** The note's mounted editor in this account, if any. */
export function getMountedNoteEditor(id: string): MountedNoteEditor | undefined {
  const entry = mountedEditors.get(id)
  if (!entry || !isCurrentAccountEpoch(entry.accountEpoch)) return undefined
  return entry.editor
}

/** T3: this context's own proved sealed write of a note obliges its mounted editor. */
export function noteSealedWriteAccepted(id: string): void {
  if (getMountedNoteEditor(id)) markNoteObligation(id)
}

/** T2: outstanding custody observed for a note obliges it in this account. */
export async function observeNoteCustody(id: string): Promise<void> {
  const accountEpoch = getAccountEpoch()
  const outstanding = await hasOutstandingNoteCustody(id)
  if (outstanding && isCurrentAccountEpoch(accountEpoch)) markNoteObligation(id)
}

/** Whether a fresh live copy proves the note still equals `base` with nothing outstanding. */
export async function proveNoteBase(id: string, base: SealedEditingBase): Promise<boolean> {
  const accountEpoch = getAccountEpoch()
  const proved = await proveLiveNoteBase(id, base)
  return proved && isCurrentAccountEpoch(accountEpoch)
}

/**
 * Account reset: drops every obligation and editor registration, with the
 * callbacks that hold draft text. Epoch tags stay as a second line of defence.
 */
export function resetNoteLifecycle(): void {
  noteObligations.clear()
  mountedEditors.clear()
}

/**
 * Whether the note's open editor holds typing begun after a destructive action was
 * authorized against `authorized` in `period` (#744 §9): an unsaved draft, or the same
 * editor in a later period. Such typing keeps its note shown.
 */
function typedSince(id: string, authorized: MountedNoteEditor | undefined, period: number | undefined): boolean {
  const current = getMountedNoteEditor(id)
  if (!current) return false
  return !current.isClean() || (current === authorized && current.periodGen() !== period)
}

interface NoteState {
  notes: StoredNote[]
  isLoading: boolean
  syncStatus: SyncStatus
}

/**
 * Every action captures the account epoch before its first await. Once logout
 * or an account switch moves the epoch on, a late result belongs to the old
 * account: it is never written into the store and never reported to the user.
 */
interface NoteActions {
  /**
   * Creates the note in Etebase first and only then adds it locally; throws if
   * that fails, or quietly with AccountBoundaryChangedError if the account changed.
   */
  createNote: (note?: NewNote) => Promise<Note>
  /**
   * Resolves true once the change is saved remotely or queued for offline replay.
   * With a capture, the save goes only through the captured editing base (#744):
   * a refused save rolls back only its own optimistic record.
   */
  updateNote: (id: string, patch: Partial<Pick<Note, 'title' | 'content'>>, capture?: NoteSaveCapture) => Promise<boolean>
  /**
   * Resolves false (and restores the note) when the server delete fails, and
   * false without restoring anything when the account changed meanwhile.
   */
  deleteNote: (id: string) => Promise<boolean>
  /**
   * Moves a note to another notebook. An Etebase item belongs to one
   * collection, so the note is recreated there and removed from its old
   * notebook. Resolves with the note's new id, or null when nothing moved
   * or the account changed meanwhile.
   */
  moveNote: (id: string, notebookId: string) => Promise<string | null>
  canWriteNote: (note: Note) => boolean
  syncFromRemote: (notes: StoredNote[]) => void
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
      const accountEpoch = getAccountEpoch()
      let itemUid: string | null = null
      // Unknown until the committed item reports its saved revision (#744).
      let committedRevision: string | null = null
      try {
        const { noteToItemMeta, savedRevisionOf } = await import('@silentsuite/core')
        // Check before the lower store sees anything: a late call would run as the next account.
        if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
        const etebase = useEtebaseStore.getState()
        itemUid = etebase.account
          ? await etebase.createItem('notes', draft.content, undefined, notebookId, noteToItemMeta(draft), (item) => {
            // Content and revision come from the same committed SDK object.
            if (isCurrentAccountEpoch(accountEpoch)) committedRevision = savedRevisionOf(item)
          })
          : null
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) {
          throw new AccountBoundaryChangedError()
        }
        console.error('[note-store] Failed to sync new note to Etebase', getSafeErrorDetails(err))
        showErrorToast('Failed to save note. Please try again.')
      }
      if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
      // The etebase store already reported why the item was not created.
      if (!itemUid) throw new Error('Note could not be saved.')

      const note: StoredNote = { id: itemUid, uid: itemUid, ...draft, revision: committedRevision }
      set((state) => ({ notes: [...state.notes, note] }))
      return note
    },

    updateNote: async (id, patch, capture) => {
      if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
      const existing = get().notes.find((n) => n.id === id)
      if (!existing || !get().canWriteNote(existing)) return false

      const accountEpoch = getAccountEpoch()
      if (capture) {
        // The optimistic record has no known revision until its own save is accepted.
        const pending: StoredNote = { ...existing, ...patch, updated_at: new Date(), revision: null }
        set((state) => ({ notes: state.notes.map((n) => (n.id === id ? pending : n)) }))
        // Only this save's own record is ever rolled back; a newer published one stays.
        const rollback = () => {
          if (!isCurrentAccountEpoch(accountEpoch)) return
          set((state) => ({ notes: state.notes.map((n) => (n === pending ? existing : n)) }))
        }
        if (!useEtebaseStore.getState().account) {
          rollback()
          return false
        }
        try {
          const { noteToItemMeta } = await import('@silentsuite/core')
          if (!isCurrentAccountEpoch(accountEpoch)) return false
          // Obligated if the captured obligation or the current map entry exists at dispatch (#744 §5).
          const owed = capture.obligation ?? getNoteObligation(id)
          const obligated = Boolean(capture.obligation || getNoteObligation(id))
          const outcome = await useEtebaseStore.getState().updateItem('notes', id, pending.content, {
            meta: noteToItemMeta(pending),
            persistEncryptedOfflineContent: true,
            collectionUid: existing.notebookId,
            sealIntent: 'note',
            base: capture.base,
            obligated,
            onCustodyObserved: () => {
              if (isCurrentAccountEpoch(accountEpoch)) markNoteObligation(id)
            },
            onSaved: (etag) => {
              if (!isCurrentAccountEpoch(accountEpoch)) return
              set((state) => ({ notes: state.notes.map((n) => (n === pending ? { ...pending, revision: etag } : n)) }))
              capture.onSaved?.(etag)
            },
          })
          if (!isCurrentAccountEpoch(accountEpoch)) return false
          if (outcome === false) {
            rollback()
            return false
          }
          // Proved acceptance releases only the obligation this save owed, if the map still holds it.
          if (obligated && owed) releaseNoteObligation(id, owed)
          return true
        } catch (err) {
          if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
          console.error('[note-store] Failed to sync note update to Etebase', getSafeErrorDetails(err))
          showErrorToast('Failed to save note. Please try again.')
          rollback()
          return false
        }
      }

      const updated: StoredNote = { ...existing, ...patch, updated_at: new Date() }
      set((state) => ({ notes: state.notes.map((n) => (n.id === id ? updated : n)) }))

      if (!useEtebaseStore.getState().account) return false

      try {
        const { noteToItemMeta } = await import('@silentsuite/core')
        // Check before the lower store sees anything: a late call would run as the next account.
        if (!isCurrentAccountEpoch(accountEpoch)) return false
        const etebase = useEtebaseStore.getState()
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
        return isCurrentAccountEpoch(accountEpoch) && outcome !== false
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
        console.error('[note-store] Failed to sync note update to Etebase', getSafeErrorDetails(err))
        showErrorToast('Failed to save note. Please try again.')
        return false
      }
    },

    deleteNote: async (id) => {
      if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
      const note = get().notes.find((n) => n.id === id)
      if (!note || !get().canWriteNote(note)) return false

      const accountEpoch = getAccountEpoch()
      if (!useEtebaseStore.getState().account) return false
      try {
        // Editor-bound authorization first (#744 §9): a mounted editor flushes, then must
        // show exactly the shown note, saved and idle. Not optimistic: nothing leaves first.
        const editor = getMountedNoteEditor(id)
        if (editor) {
          await editor.flushAndWait()
          if (!isCurrentAccountEpoch(accountEpoch)) return false
        }
        const shown = get().notes.find((n) => n.id === id)
        if (!shown) return false
        if (editor && !noteEditorMatches(editor, shown)) return false
        const period = editor?.periodGen()
        const obligated = Boolean(getNoteObligation(id))
        let revision = shown.revision
        if (obligated || !revision) {
          // An obligated note or an unknown revision is proved against a fresh live copy first.
          revision = await proveNoteRevision(id, { title: shown.title, content: shown.content, revision: shown.revision })
          if (!isCurrentAccountEpoch(accountEpoch) || !revision) return false
        }
        const outcome = await useEtebaseStore.getState().deleteItem('notes', id, {
          collectionUid: shown.notebookId,
          conditional: true,
          expectedRevision: revision,
          offlineAllowed: !obligated,
          // Repeated inside the offline admission transaction.
          admit: () => {
            const current = getMountedNoteEditor(id)
            return !current || noteEditorMatches(current, shown)
          },
        })
        if (!isCurrentAccountEpoch(accountEpoch) || outcome === false) return false
        // Typing begun on the open editor while the delete was in flight stays shown, and can only be refused.
        if (typedSince(id, editor, period)) return true
        set((state) => ({ notes: state.notes.filter((n) => n.id !== id) }))
        return true
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
        console.error('[note-store] Failed to sync note deletion to Etebase', getSafeErrorDetails(err))
        showErrorToast('Failed to delete note. Please try again.')
        return false
      }
    },

    moveNote: async (id, notebookId) => {
      if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
      const existing = get().notes.find((n) => n.id === id)
      if (!existing || !get().canWriteNote(existing)) return null
      if (existing.notebookId === notebookId) return id
      const target = useNotebookStore.getState().lists.find((list) => list.id === notebookId)
      if (!target || !canWriteNotebook(target)) return null

      const accountEpoch = getAccountEpoch()
      const { account, itemCache } = useEtebaseStore.getState()
      if (!account || !itemCache.has(id)) return null

      try {
        // A move deletes the source, so it is authorized like a delete (#744 §9): a mounted
        // editor flushes and must show exactly the shown note, saved and idle.
        const editor = getMountedNoteEditor(id)
        if (editor) {
          await editor.flushAndWait()
          if (!isCurrentAccountEpoch(accountEpoch)) return null
        }
        const shown = get().notes.find((n) => n.id === id)
        if (!shown || (editor && !noteEditorMatches(editor, shown))) return null
        const period = editor?.periodGen()
        const obligated = Boolean(getNoteObligation(id))
        let revision = shown.revision
        if (obligated || !revision) {
          revision = await proveNoteRevision(id, { title: shown.title, content: shown.content, revision: shown.revision })
          if (!isCurrentAccountEpoch(accountEpoch) || !revision) return null
        }
        const { noteToItemMeta } = await import('@silentsuite/core')
        // Check before the lower store sees anything: a late call would run as the next account.
        if (!isCurrentAccountEpoch(accountEpoch)) return null
        const etebase = useEtebaseStore.getState()
        // A move is not an edit: the title and last-edit time travel with the note.
        const movedId = await etebase.moveItem('notes', id, shown.content, notebookId, shown.notebookId, noteToItemMeta(shown), {
          sourceRevision: revision,
          offlineAllowed: !obligated,
        })
        if (!movedId || !isCurrentAccountEpoch(accountEpoch)) return null
        // The moved note is a new item: its revision is unknown until a paired read (#744).
        const moved: StoredNote = { ...shown, id: movedId, uid: movedId, notebookId, revision: null }
        if (typedSince(id, editor, period)) {
          // Typing begun while the move was in flight stays on the open editor's note; the copy joins the list.
          set((state) => ({ notes: [...state.notes, moved] }))
          return id
        }
        set((state) => ({ notes: state.notes.map((n) => (n.id === id ? moved : n)) }))
        return movedId
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return null
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
      // A note the server no longer lists stays shown while its open editor holds unsaved typing (#744).
      const remoteIds = new Set(remoteNotes.map((n) => n.id))
      const kept = get().notes.filter((n) => !remoteIds.has(n.id) && getMountedNoteEditor(n.id)?.isClean() === false)
      set({ notes: [...remoteNotes, ...kept], isLoading: false, syncStatus: 'synced' })
    },
  }),
)

export type { NewNote }
