'use client'

import { create } from 'zustand'
import type { ItemMeta, Note, SyncStatus } from '@silentsuite/core'
import {
  hasOutstandingNoteCustody,
  noteEditorMatches,
  prepareNoteCopyItem,
  proveLiveNoteBase,
  proveNoteRevision,
  readLiveNote,
  reviseNoteCopyItem,
  uploadNoteCopyItem,
  useEtebaseStore,
  type LiveNoteRead,
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
  /** Called when the server refused the save, with 'changed' when the note proved to have moved on. */
  onRefused?: (reason?: 'changed') => void
}

/** A mounted note editor's registration (#744 §2): read-only views of its own lineage state. */
export interface MountedNoteEditor {
  periodGen: () => number
  isClean: () => boolean
  chainIdle: () => boolean
  base: () => SealedEditingBase
  flushAndWait: () => Promise<void>
}

/**
 * Why a note save was refused (#1113 D1): the note proved to have changed since
 * the text's base, or this browser could not prove that it did not.
 */
export type NoteRefusal = 'changed' | 'unproved'

/** Why a Save as a copy did not make a copy. */
export type NoteCopyFailure = 'offline' | 'unconfirmed' | 'deleted' | 'read-only' | 'no-notebook'

/**
 * Text of a note whose last save failed, with the base it was typed on (#1113 D1).
 * An editor that opens the note starts from it, so the text outlives its editor.
 */
export interface HeldNoteDraft {
  draft: { title: string; content: string }
  base: SealedEditingBase
  /** How the last save failed. Absent for text carried to a new copy, which is saved when it opens. */
  failed?: 'error' | NoteRefusal
  /** A Save as a copy of this text that is running, or why it failed. */
  copy?: 'running' | NoteCopyFailure
}

export type NoteCopyResult =
  | { kind: 'copied'; id: string }
  | { kind: 'failed'; reason: NoteCopyFailure }
  /** The account changed meanwhile; nothing is reported. */
  | { kind: 'stale' }

/** What Show newer version found. */
export type NewerNoteVersion = LiveNoteRead

const UNTITLED = 'Untitled'
const CONFLICTED_COPY = '(conflicted copy)'

/**
 * Android's conflicted copy title (NotePushPolicy.conflictCopyTitle): the title as
 * displayed, so a blank one becomes "Untitled (conflicted copy)", and a copy of a
 * copy gets no second suffix. Stored on the server and read by every client, so
 * in English, like "Untitled".
 */
export function conflictCopyTitle(displayTitle: string): string {
  const base = displayTitle.trim() || UNTITLED
  return base.endsWith(` ${CONFLICTED_COPY}`) ? base : `${base} ${CONFLICTED_COPY}`
}

/**
 * The copy for a note's held text, recorded before each upload: a retry of the
 * same text sends the same item (same UID, same revision); newer text goes out
 * as a new revision of that UID, so older text is never sent again. Dropped
 * with the held text it was made for, in memory only.
 */
interface NoteCopyAttempt {
  item: any
  collectionUid: string
  title: string
  content: string
  createdAt: Date
  /** Every revision of the copy sent so far, with the text it holds. */
  sent: { revision: string; title: string; content: string }[]
}

// In memory only. Each entry keeps the account epoch it was made under, so a
// later account never sees an earlier account's obligation, editor or text.
const noteObligations = new Map<string, { obligation: object; accountEpoch: number }>()
const mountedEditors = new Map<string, { editor: MountedNoteEditor; accountEpoch: number }>()
const heldNoteDrafts = new Map<string, { held: HeldNoteDraft; accountEpoch: number }>()
// Unmounted editors whose last save is still running, per note.
const closingNoteSaves = new Map<string, number>()
// Keyed by the note the copy is made from.
const noteCopyAttempts = new Map<string, { attempt: NoteCopyAttempt; accountEpoch: number }>()
const noteCopiesInFlight = new Map<string, { running: Promise<NoteCopyResult>; accountEpoch: number }>()

let unloadGuard: ((event: BeforeUnloadEvent) => void) | null = null

/**
 * While any text is held or a closing save runs, the browser asks before the
 * tab closes: that text exists only in this page.
 */
function syncUnloadGuard(): void {
  if (typeof window === 'undefined') return
  const needed = heldNoteDrafts.size > 0 || closingNoteSaves.size > 0 || noteCopiesInFlight.size > 0
  if (needed && !unloadGuard) {
    unloadGuard = (event) => {
      event.preventDefault()
      // Older browsers show the prompt only when returnValue is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', unloadGuard)
  } else if (!needed && unloadGuard) {
    window.removeEventListener('beforeunload', unloadGuard)
    unloadGuard = null
  }
}

/** The note's held text in this account, if any. */
export function getHeldNoteDraft(id: string): HeldNoteDraft | undefined {
  const entry = heldNoteDrafts.get(id)
  if (!entry) return undefined
  if (!isCurrentAccountEpoch(entry.accountEpoch)) {
    heldNoteDrafts.delete(id)
    syncUnloadGuard()
    return undefined
  }
  return entry.held
}

/** Holds the note's text after a failed save, replacing any earlier text of it. */
export function holdNoteDraft(id: string, held: HeldNoteDraft): void {
  heldNoteDrafts.set(id, { held, accountEpoch: getAccountEpoch() })
  syncUnloadGuard()
}

/**
 * Drops the note's held text once it is saved or no longer differs from the saved
 * text; with `only`, just when that exact record is still the one held.
 */
export function releaseHeldNoteDraft(id: string, only?: HeldNoteDraft): void {
  if (only && heldNoteDrafts.get(id)?.held !== only) return
  // The text a copy attempt was made for is saved or gone: a later refusal gets a new copy.
  noteCopyAttempts.delete(id)
  if (heldNoteDrafts.delete(id)) syncUnloadGuard()
}

/** Replaces the held record only while it is still `current`. */
function replaceHeldNoteDraft(id: string, current: HeldNoteDraft, next: HeldNoteDraft): void {
  const entry = heldNoteDrafts.get(id)
  if (entry?.held === current) heldNoteDrafts.set(id, { held: next, accountEpoch: entry.accountEpoch })
}

/** The note's running Save as a copy in this account, if any. */
export function getNoteCopyInFlight(id: string): Promise<NoteCopyResult> | undefined {
  const entry = noteCopiesInFlight.get(id)
  return entry && isCurrentAccountEpoch(entry.accountEpoch) ? entry.running : undefined
}

function getNoteCopyAttempt(id: string): NoteCopyAttempt | undefined {
  const entry = noteCopyAttempts.get(id)
  if (!entry) return undefined
  if (!isCurrentAccountEpoch(entry.accountEpoch)) {
    noteCopyAttempts.delete(id)
    return undefined
  }
  return entry.attempt
}

/**
 * A fresh, read-only look at the note's server copy (#1113 D1). Nothing it
 * reads reaches the item cache, the note store or the editor.
 */
export async function readNewerNoteVersion(id: string): Promise<NewerNoteVersion> {
  const note = useNoteStore.getState().notes.find((n) => n.id === id)
  return readLiveNote(id, note?.notebookId)
}

/**
 * The copy itself: builds or revises the item and records it before the upload,
 * uploads it, and on a confirmed copy does everything a new note does here. Any
 * failure keeps the attempt, so a retry cannot make a second copy; a tombstone
 * for the copy's UID, or the release of the held text, retires it.
 */
async function runNoteCopy(
  id: string,
  held: HeldNoteDraft,
  accountEpoch: number,
  get: () => NoteState & NoteActions,
  set: (partial: (state: NoteState & NoteActions) => Partial<NoteState>) => void,
): Promise<NoteCopyResult> {
  const failed = (reason: NoteCopyFailure): NoteCopyResult => ({ kind: 'failed', reason })
  try {
    let attempt = getNoteCopyAttempt(id)
    const notebookId = attempt?.collectionUid ?? get().notes.find((n) => n.id === id)?.notebookId
    const notebook = useNotebookStore.getState().lists.find((list) => list.id === notebookId)
    if (!notebookId || !notebook) return failed('no-notebook')
    if (!useAuthStore.getState().canWrite() || !canWriteNotebook(notebook)) return failed('read-only')
    // Nothing is built or sent while the browser knows it is offline.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return failed('offline')
    const { noteToItemMeta } = await import('@silentsuite/core')
    if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
    const title = conflictCopyTitle(held.draft.title)
    const content = held.draft.content
    if (!attempt || attempt.title !== title || attempt.content !== content) {
      const createdAt = new Date()
      const meta = noteToItemMeta({ title, updated_at: createdAt })
      // Newer text under the same UID, never the older text again; else a new copy.
      const item = attempt
        ? await reviseNoteCopyItem(attempt.item, content, meta)
        : await prepareNoteCopyItem(notebookId, content, meta)
      if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
      if (!item) return failed('no-notebook')
      attempt = { item, collectionUid: notebookId, title, content, createdAt, sent: attempt?.sent ?? [] }
    }
    // Recorded before anything is sent: a lost response or a retry re-sends this same item.
    if (!attempt.sent.some((sent) => sent.revision === attempt!.item.etag)) {
      attempt.sent = [...attempt.sent, { revision: attempt.item.etag, title, content }]
    }
    noteCopyAttempts.set(id, { attempt, accountEpoch })
    const upload = await uploadNoteCopyItem(attempt.collectionUid, attempt.item, { title: attempt.title, content: attempt.content })
    if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
    if (upload.kind === 'deleted') {
      if (getNoteCopyAttempt(id) === attempt) noteCopyAttempts.delete(id)
      return failed('deleted')
    }
    if (upload.kind === 'refused') return failed('read-only')
    if (upload.kind !== 'copied') return failed(upload.kind)
    if (getNoteCopyAttempt(id) === attempt) noteCopyAttempts.delete(id)
    const copyId: string = upload.item.uid
    const copy: StoredNote = {
      id: copyId,
      uid: copyId,
      title: upload.title,
      content: upload.content,
      notebookId: attempt.collectionUid,
      created_at: attempt.createdAt,
      updated_at: attempt.createdAt,
      revision: upload.revision,
    }
    set((state) => (state.notes.some((n) => n.id === copyId) ? {} : { notes: [...state.notes, copy] }))
    // The server held an earlier revision of the copy (a 409): the current text goes onto it
    // as an edit of the revision it grew from. On a revision this tab sent, that saves; on
    // one another device wrote, the save is refused and the text stays.
    if (upload.title !== title || upload.content !== content) {
      const ours = attempt.sent.find((sent) => sent.revision === upload.revision)
      const typedOn = ours ?? [...attempt.sent].reverse().find((sent) => sent.title !== title || sent.content !== content)
      if (typedOn) holdNoteDraft(copyId, { draft: { title, content }, base: { title: typedOn.title, content: typedOn.content, revision: typedOn.revision } })
    }
    return { kind: 'copied', id: copyId }
  } catch (err) {
    if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return { kind: 'stale' }
    console.error('[note-store] Failed to save a note copy', getSafeErrorDetails(err))
    // Unknown, as anything after a send can be: the attempt stays for a retry.
    return failed('unconfirmed')
  }
}

/** An editor closed with a save still to finish; the note opens read-only until it does. */
export function beginClosingNoteSave(id: string): void {
  closingNoteSaves.set(id, (closingNoteSaves.get(id) ?? 0) + 1)
  useNoteStore.setState({ closingNoteIds: [...closingNoteSaves.keys()] })
  syncUnloadGuard()
}

export function endClosingNoteSave(id: string): void {
  const count = closingNoteSaves.get(id)
  if (count === undefined) return
  if (count > 1) closingNoteSaves.set(id, count - 1)
  else closingNoteSaves.delete(id)
  useNoteStore.setState({ closingNoteIds: [...closingNoteSaves.keys()] })
  syncUnloadGuard()
}

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

/**
 * Whether the note has text this page has not saved: typing in its open editor,
 * or text held after a failed save (#1113 D1). Destructive and refresh paths keep
 * such a note, as they keep an open editor's unsaved typing (#744).
 */
export function hasUnsavedNoteText(id: string): boolean {
  return getMountedNoteEditor(id)?.isClean() === false || getHeldNoteDraft(id) !== undefined
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
 * callbacks that hold draft text, and all held text. Epoch tags stay as a
 * second line of defence.
 */
export function resetNoteLifecycle(): void {
  noteObligations.clear()
  mountedEditors.clear()
  heldNoteDrafts.clear()
  closingNoteSaves.clear()
  noteCopyAttempts.clear()
  noteCopiesInFlight.clear()
  useNoteStore.setState({ closingNoteIds: [] })
  syncUnloadGuard()
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

/** A move this store refused before anything was written; `toast` says why and that nothing moved. */
class NoteMoveRefusedError extends Error {
  constructor(name: string, message: string, readonly toast: string) {
    super(message)
    this.name = name
  }
}

/** The source item's metadata cannot be decoded, or is not a map of fields. */
class NoteMetaUnreadableError extends NoteMoveRefusedError {
  constructor() {
    super(
      'NoteMetaUnreadableError',
      'Note metadata is unreadable',
      'Note not moved: some of its details could not be read. It stays in its notebook, unchanged.',
    )
  }
}

/** The cached source item is not saved at the revision the move removes. */
class NoteMoveSourceChangedError extends NoteMoveRefusedError {
  constructor() {
    super(
      'NoteMoveSourceChangedError',
      'Cached note is not at the revision being moved',
      'Note not moved: it changed since this page loaded it. It stays in its notebook. Move it again after sync finishes.',
    )
  }
}

/** Another client gave the source item a type other than a Markdown note. */
class NoteMoveNotANoteError extends NoteMoveRefusedError {
  constructor() {
    super(
      'NoteMoveNotANoteError',
      'Note item has a non-note type',
      'Note not moved: another app changed it into an item that is not a note. It stays in its notebook, unchanged.',
    )
  }
}

/**
 * The moved copy's metadata: every field of the source item, including fields
 * other clients wrote, with `own` (title and last-edit time) on top. Metadata
 * that cannot be decoded or is not a map is never dropped: the move is refused.
 * Metadata that decodes to null or undefined holds no fields, as on save. An
 * item `isNote` rejects is refused too, so a move never lands a non-note copy
 * that every client skips while it deletes the source.
 */
function movedNoteMeta(source: { getMeta?: () => unknown }, own: ItemMeta, isNote: (meta: ItemMeta) => boolean): ItemMeta {
  if (typeof source.getMeta !== 'function') throw new NoteMetaUnreadableError()
  let decoded: unknown
  try {
    decoded = source.getMeta()
  } catch {
    // The SDK error is not passed on: only this error's name is ever logged.
    throw new NoteMetaUnreadableError()
  }
  if (decoded == null) return { ...own }
  const prototype = typeof decoded === 'object' ? Object.getPrototypeOf(decoded) : undefined
  if (prototype !== Object.prototype && prototype !== null) throw new NoteMetaUnreadableError()
  if (!isNote(decoded as ItemMeta)) throw new NoteMoveNotANoteError()
  return { ...(decoded as ItemMeta), ...own }
}

interface NoteState {
  notes: StoredNote[]
  syncStatus: SyncStatus
  /** Notes whose closed editor still has a save running; they open read-only until it ends. */
  closingNoteIds: string[]
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
  /**
   * Saves a note's text as a new note in the same notebook, titled
   * "<title> (conflicted copy)" (#1113 D1). The text is held from the call on;
   * a second call while one runs gets the same result.
   */
  saveNoteCopy: (id: string, held: HeldNoteDraft) => Promise<NoteCopyResult>
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
    syncStatus: 'synced' as SyncStatus,
    closingNoteIds: [],

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
            onRefused: (reason) => {
              if (isCurrentAccountEpoch(accountEpoch)) capture.onRefused?.(reason)
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
          const proved = await proveNoteRevision(id, { title: shown.title, content: shown.content, revision: shown.revision })
          if (!isCurrentAccountEpoch(accountEpoch) || !proved) return false
          revision = proved.revision
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
        // The copy's metadata and the revision the source delete uses always come from one read.
        let source: { getMeta?: () => unknown } | undefined
        if (obligated || !revision) {
          // A fresh proof: the copy takes the metadata of that same fresh read.
          const proved = await proveNoteRevision(id, { title: shown.title, content: shown.content, revision: shown.revision })
          if (!isCurrentAccountEpoch(accountEpoch) || !proved) return null
          revision = proved.revision
          source = proved.item
        }
        const { isMarkdownNoteItem, noteToItemMeta, savedRevisionOf } = await import('@silentsuite/core')
        // Check before the lower store sees anything: a late call would run as the next account.
        if (!isCurrentAccountEpoch(accountEpoch)) return null
        const etebase = useEtebaseStore.getState()
        // Otherwise the shown revision is paired with the cached item it was read or saved
        // from; a cached item at any other revision cannot supply the copy's metadata.
        const cached = etebase.itemCache.get(id)
        if (!source && (!cached || savedRevisionOf(cached) !== revision)) throw new NoteMoveSourceChangedError()
        // A move is not an edit: the title and last-edit time travel with the note, and
        // every other field, including those other clients wrote, stays as it was.
        const meta = movedNoteMeta(source ?? cached, noteToItemMeta(shown), isMarkdownNoteItem)
        const movedId = await etebase.moveItem('notes', id, shown.content, notebookId, shown.notebookId, meta, {
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
        showErrorToast(err instanceof NoteMoveRefusedError ? err.toast : 'Failed to move note. Please try again.')
        return null
      }
    },

    saveNoteCopy: (id, held) => {
      const running = getNoteCopyInFlight(id)
      if (running) return running
      const accountEpoch = getAccountEpoch()
      // Held before the first await: an editor closing now leaves its text here.
      const record: HeldNoteDraft = { ...held, copy: 'running' }
      holdNoteDraft(id, record)
      const settled: Promise<NoteCopyResult> = runNoteCopy(id, record, accountEpoch, get, set).then((result) => {
        if (result.kind === 'copied') releaseHeldNoteDraft(id, record)
        else if (result.kind === 'failed') replaceHeldNoteDraft(id, record, { ...record, copy: result.reason })
        if (noteCopiesInFlight.get(id)?.running === settled) noteCopiesInFlight.delete(id)
        syncUnloadGuard()
        return result
      })
      noteCopiesInFlight.set(id, { running: settled, accountEpoch })
      syncUnloadGuard()
      return settled
    },

    canWriteNote: (note) => {
      if (!useAuthStore.getState().canWrite()) return false
      const notebook = useNotebookStore.getState().lists.find((list) => list.id === note.notebookId)
      return canWriteNotebook(notebook)
    },

    syncFromRemote: (remoteNotes) => {
      // A note the server no longer lists stays shown while its open editor holds unsaved typing (#744),
      // or while its text is held after a failed save (#1113 D1).
      const remoteIds = new Set(remoteNotes.map((n) => n.id))
      const kept = get().notes.filter((n) => !remoteIds.has(n.id) && hasUnsavedNoteText(n.id))
      set({ notes: [...remoteNotes, ...kept], syncStatus: 'synced' })
    },
  }),
)

export type { NewNote }
