'use client'

import { create } from 'zustand'
import type { ItemMeta, Note, SyncStatus } from '@silentsuite/core'
import {
  MAX_NOTE_COPY_REVISIONS,
  deleteHeldNoteRecord,
  hasOutstandingNoteCustody,
  loadNoteCopyItem,
  noteEditorMatches,
  openHeldNoteRecords,
  prepareNoteCopyItem,
  proveLiveNoteBase,
  proveNoteRevision,
  publishFetchedNoteItem,
  readLiveNote,
  reviseNoteCopyItem,
  storeNoteCopyItem,
  uploadNoteCopyItem,
  useEtebaseStore,
  writeHeldNoteRecord,
  type HeldNoteRecordRef,
  type LiveNoteRead,
  type ReopenedHeldNote,
  type SealedEditingBase,
  type SealedNoteCopy,
} from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { AccountBoundaryChangedError, getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { NoteNotCreatedError, type NoteNotCreatedReason } from '@/app/lib/note-not-created'
import { clearNotePreviewVerdict } from '@/app/lib/note-preview-verdict'
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
  /** The editor's current text; used to tell whether its held record already holds it. */
  draft?: () => { title: string; content: string }
}

/**
 * Why a note save was refused (#1113 D1): the note proved to have changed since
 * the text's base, or this browser could not prove that it did not.
 */
export type NoteRefusal = 'changed' | 'unproved'

/** Why a Save as a copy did not make a copy. */
export type NoteCopyFailure = 'offline' | 'unconfirmed' | 'deleted' | 'changed' | 'read-only' | 'no-notebook'

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
 * with the held text it was made for. The item is also stored with the held
 * text's sealed record before each upload, and reopened with it after a reload.
 */
interface NoteCopyAttempt {
  /** Null for an attempt reopened from a held record, until its stored item is loaded. */
  item: any
  /** The item as stored with the held record; matches `item` once stored. */
  stored?: SealedNoteCopy
  collectionUid: string
  title: string
  content: string
  createdAt: Date
  /**
   * Every revision of the copy sent so far, oldest first, with the text it holds;
   * null for one sent before a reload (the record keeps only its revision).
   */
  sent: { revision: string; text: NoteText | null }[]
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
// The held note record (#1113 D1) this page wrote or reopened for a note's held text, at its revision.
// `stored` is the text the record holds, or null when the record could not be updated and may hold older text.
const heldNoteRecords = new Map<string, { ref: HeldNoteRecordRef; collectionUid: string; stored: NoteText | null; accountEpoch: number }>()
// Per note, the chain of writes that make its held record match its held text, in order.
const heldRecordWrites = new Map<string, Promise<HeldTextDurability>>()
// List rows for reopened held text, used when the note list loads without the note.
const reopenedHeldRows = new Map<string, { row: StoredNote; accountEpoch: number }>()

/**
 * Per note, what this page's own accepted writes of it left behind. Etebase revisions
 * are random and never come back, and a note's history is one line, so a revision that
 * existed before one of this page's writes of the note was sent is older than the
 * revision that write was accepted at: a row at it can only come from a sync that read
 * the note before the write landed. The same holds for the live version Show newer version
 * reads. Revisions only, never note text.
 */
const ownNoteWrites = new Map<string, {
  /** Revisions this page's accepted writes moved past, oldest first. */
  superseded: string[]
  /**
   * The revision this page's last accepted save of the note was accepted at, or the version
   * Show newer version last put in its row; null after its delete.
   */
  committed: string | null
  accountEpoch: number
}>()
// A sync snapshot is seconds old; the oldest revisions of a note saved all session are dropped.
const MAX_SUPERSEDED_REVISIONS = 64

function getOwnNoteWrites(id: string) {
  const entry = ownNoteWrites.get(id)
  if (!entry) return undefined
  if (!isCurrentAccountEpoch(entry.accountEpoch)) {
    ownNoteWrites.delete(id)
    return undefined
  }
  return entry
}

/**
 * This page's own write of the note was accepted at `committed` (null for a delete), and
 * every revision in `older` existed before that write was sent. So did the revision of
 * this page's previous accepted save of the note, even when the write went over another
 * device's version (Show newer version). Show newer version also records the live version
 * it put in the row as `committed`, over the row's revision. Returns every revision this
 * page has moved past for the note.
 */
function noteWriteAccepted(id: string, committed: string | null, older: (string | null | undefined)[]): ReadonlySet<string> {
  const previous = getOwnNoteWrites(id)
  const superseded = previous?.superseded.filter((revision) => revision !== committed) ?? []
  for (const revision of [previous?.committed, ...older]) {
    if (revision && revision !== committed && !superseded.includes(revision)) superseded.push(revision)
  }
  superseded.splice(0, Math.max(0, superseded.length - MAX_SUPERSEDED_REVISIONS))
  ownNoteWrites.set(id, { superseded, committed, accountEpoch: getAccountEpoch() })
  return new Set(superseded)
}

/**
 * The record a save made here shows in place of the row it started from, while it runs and,
 * once queued offline, after; mapped to that row (what the save's rollback restores). Held
 * only as long as the record itself.
 */
const optimisticNoteRecords = new WeakMap<StoredNote, StoredNote>()

/** For the record of a save made here, the row the first such save started from; any other row as it is. */
function rowBeforeRunningSaves(row: StoredNote): StoredNote {
  let current = row
  // Each record maps to a row that existed before it, so the walk ends.
  for (let earlier = optimisticNoteRecords.get(current); earlier; earlier = optimisticNoteRecords.get(current)) current = earlier
  return current
}

/** Whether a sync read the row before one of this page's own writes of the note landed. */
function readBeforeOwnWrite(row: StoredNote, shown: StoredNote | undefined): boolean {
  // A row from the display cache has no revision. It never replaces the record of a save
  // made here (running, or queued offline), which only that save replaces or rolls back.
  if (row.revision === null && shown && optimisticNoteRecords.has(shown)) return true
  const entry = getOwnNoteWrites(row.id)
  if (!entry) return false
  // Nor does it replace the row of this page's own accepted save, or bring back a note this
  // page deleted (`committed` is null only then).
  if (row.revision === null) return entry.committed === null || shown?.revision === entry.committed
  return entry.superseded.includes(row.revision)
}

/**
 * A sync that read the note at `staleRevision`, before this page's own save at `revision`
 * landed, also cached the SDK item it read (refreshCollection replaces cached items), while
 * the row and the editor's base stay at `revision`. A save checks the cached item's revision,
 * offline too, and Move takes its metadata, so the item at `revision` is read afresh and
 * cached in place of that older item, only while the cache still holds it. An edit typed
 * meanwhile saves from `revision` too, so its running record does not stop this. Online
 * only; any failed or different read changes nothing.
 */
async function recacheOwnNoteItem(id: string, notebookId: string | undefined, staleRevision: string, revision: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  const accountEpoch = getAccountEpoch()
  const cached = useEtebaseStore.getState().itemCache.get(id)
  if (cached === undefined) return
  const { savedRevisionOf } = await import('@silentsuite/core')
  if (!isCurrentAccountEpoch(accountEpoch) || savedRevisionOf(cached) !== staleRevision) return
  const read = await readLiveNote(id, notebookId)
  if (!isCurrentAccountEpoch(accountEpoch) || read.kind !== 'note' || read.revision !== revision) return
  publishFetchedNoteItem(id, cached, read.item)
}

/**
 * Where a note's held text is: in its sealed record; only in this page; or 'blocked',
 * when a record of it exists that this page could not update.
 */
type HeldTextDurability = 'stored' | 'page-only' | 'blocked'

type NoteText = { title: string; content: string }

const sameText = (a: NoteText, b: NoteText) => a.title === b.title && a.content === b.content

let unloadGuard: ((event: BeforeUnloadEvent) => void) | null = null

function getHeldNoteRecord(id: string): { ref: HeldNoteRecordRef; collectionUid: string; stored: NoteText | null } | undefined {
  const entry = heldNoteRecords.get(id)
  if (!entry) return undefined
  if (!isCurrentAccountEpoch(entry.accountEpoch)) {
    heldNoteRecords.delete(id)
    return undefined
  }
  return entry
}

/**
 * Makes the note's held record match its held text as it is now (#1113 D1): writes
 * it (with the copy attempt's stored item) while text is held, and deletes the record
 * this page knows, at its revision, once the text is released. A record this page
 * neither wrote nor reopened is never deleted. Never rejects.
 */
async function writeHeldRecordNow(id: string, accountEpoch: number): Promise<HeldTextDurability> {
  try {
    if (!isCurrentAccountEpoch(accountEpoch)) return 'page-only'
    const held = getHeldNoteDraft(id)
    const known = getHeldNoteRecord(id)
    if (!held) {
      if (known) {
        await deleteHeldNoteRecord(known.ref)
        if (heldNoteRecords.get(id)?.ref === known.ref) heldNoteRecords.delete(id)
      }
      return 'page-only'
    }
    const collectionUid = known?.collectionUid ?? useNoteStore.getState().notes.find((n) => n.id === id)?.notebookId
    if (!collectionUid) return 'page-only'
    // Text the server has not confirmed without refusing it (a save that failed, or text
    // carried to a copy) is held as not confirmed, so it is saved again once it reopens.
    const reason = held.failed === 'changed' || held.failed === 'unproved' ? 'base-changed' : 'retry-exhausted'
    const ref = await writeHeldNoteRecord(id, collectionUid, held.draft, held.base, getNoteCopyAttempt(id)?.stored, known?.ref, reason)
    if (!isCurrentAccountEpoch(accountEpoch)) return 'page-only'
    if (ref === 'blocked') {
      // The record still exists and may hold older text or another copy: it stays known, so no copy
      // goes out without it, and the text counts as only in this page.
      if (known && heldNoteRecords.get(id)?.ref === known.ref) heldNoteRecords.set(id, { ...known, stored: null, accountEpoch })
      return 'blocked'
    }
    if (!ref) {
      if (known && heldNoteRecords.get(id)?.ref === known.ref) heldNoteRecords.delete(id)
      return 'page-only'
    }
    heldNoteRecords.set(id, { ref, collectionUid, stored: held.draft, accountEpoch })
    return 'stored'
  } catch (err) {
    if (isCurrentAccountEpoch(accountEpoch) && !(err instanceof AccountBoundaryChangedError)) {
      console.error('[note-store] Failed to store held note text', getSafeErrorDetails(err))
    }
    return 'page-only'
  } finally {
    syncUnloadGuard()
  }
}

/** Queues a write of the note's held record behind the earlier ones; resolves where the text is. */
function storeHeldText(id: string): Promise<HeldTextDurability> {
  const accountEpoch = getAccountEpoch()
  const earlier = heldRecordWrites.get(id) ?? Promise.resolve<HeldTextDurability>('page-only')
  const next = earlier.then(() => writeHeldRecordNow(id, accountEpoch))
  heldRecordWrites.set(id, next)
  void next.then(() => {
    if (heldRecordWrites.get(id) === next) heldRecordWrites.delete(id)
  })
  return next
}

/** Whether the note's record holds exactly this text. */
function recordHolds(id: string, text: NoteText): boolean {
  const stored = getHeldNoteRecord(id)?.stored
  return stored != null && sameText(stored, text)
}

/**
 * Notes with text that exists only in this page: held text its record does not hold,
 * an open editor's typing its record does not hold (waiting for its autosave or with
 * its save running), a closing save.
 */
function noteTextOnlyInPage(): Set<string> {
  const ids = new Set<string>()
  for (const id of [...heldNoteDrafts.keys()]) {
    const held = getHeldNoteDraft(id)
    if (held && !recordHolds(id, held.draft)) ids.add(id)
  }
  for (const id of [...mountedEditors.keys()]) {
    const editor = getMountedNoteEditor(id)
    if (!editor || editor.isClean()) continue
    const record = getHeldNoteRecord(id)
    const typed = editor.draft?.()
    if (!record || !typed || !recordHolds(id, typed)) ids.add(id)
  }
  for (const id of closingNoteSaves.keys()) ids.add(id)
  return ids
}

/** Whether an open editor has typing not yet saved, or a save still running. */
function editorHasUnsavedWork(): boolean {
  for (const id of [...mountedEditors.keys()]) {
    const editor = getMountedNoteEditor(id)
    if (editor && (!editor.isClean() || !editor.chainIdle())) return true
  }
  return false
}

/**
 * While held text, a held record, a closing save, a running copy, or an open editor's
 * unsaved typing or running save exists, a leave listener is installed; it asks only
 * when, at that moment, some text exists only in this page (held text or typing its
 * record does not hold, a closing save, a copy).
 */
function syncUnloadGuard(): void {
  if (typeof window === 'undefined') return
  const needed = heldNoteDrafts.size > 0 || heldNoteRecords.size > 0 || closingNoteSaves.size > 0 || noteCopiesInFlight.size > 0
    || editorHasUnsavedWork()
  if (needed && !unloadGuard) {
    unloadGuard = (event) => {
      if (noteCopiesInFlight.size === 0 && noteTextOnlyInPage().size === 0) return
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
  void holdNoteText(id, held)
}

/** Holds the note's text; resolves where its record write left it. */
function holdNoteText(id: string, held: HeldNoteDraft): Promise<HeldTextDurability> {
  heldNoteDrafts.set(id, { held, accountEpoch: getAccountEpoch() })
  syncUnloadGuard()
  // Held text also goes to its sealed record, so it outlives a reload (#1113 D1).
  return storeHeldText(id)
}

/**
 * Drops the note's held text once it is saved or no longer differs from the saved
 * text; with `only`, just when that exact record is still the one held. The held
 * record this page knows for it is deleted too.
 */
export function releaseHeldNoteDraft(id: string, only?: HeldNoteDraft): void {
  if (only && heldNoteDrafts.get(id)?.held !== only) return
  // The text a copy attempt was made for is saved or gone: a later refusal gets a new copy.
  noteCopyAttempts.delete(id)
  const released = heldNoteDrafts.delete(id)
  if (released) syncUnloadGuard()
  if (released || heldNoteRecords.has(id)) void storeHeldText(id)
}

/**
 * The banner's Discard deleted a held note record (#1113 D1): the page no longer
 * counts it as holding the note's text, so text still held here counts as only in
 * this page again (leave prompt, Log out count).
 */
export function heldNoteRecordDiscarded(id: string, recordId: string): void {
  if (heldNoteRecords.get(id)?.ref.id !== recordId) return
  heldNoteRecords.delete(id)
  syncUnloadGuard()
}

/** Replaces the held record only while it is still `current`. */
function replaceHeldNoteDraft(id: string, current: HeldNoteDraft, next: HeldNoteDraft): void {
  const entry = heldNoteDrafts.get(id)
  if (entry?.held !== current) return
  heldNoteDrafts.set(id, { held: next, accountEpoch: entry.accountEpoch })
  void storeHeldText(id)
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
 * A fresh, read-only look at the note's server copy (#1113 D1). The version read
 * becomes the note's list row and cached SDK item together, as a sync of that one
 * note would, only while the note's text is unsaved here (so no editor adopts it)
 * and only over the exact row and cached item the read started from. A row with no
 * known revision (a running save's optimistic record, or one not yet paired with
 * its cached item) is left to the save or sync that pairs it.
 */
export async function readNewerNoteVersion(id: string): Promise<NewerNoteVersion> {
  const accountEpoch = getAccountEpoch()
  const shown = useNoteStore.getState().notes.find((n) => n.id === id)
  const cached = useEtebaseStore.getState().itemCache.get(id)
  const read = await readLiveNote(id, shown?.notebookId)
  if (
    read.kind === 'note' && read.revision && shown && shown.revision !== null && read.revision !== shown.revision
    && isCurrentAccountEpoch(accountEpoch) && hasUnsavedNoteText(id)
    && useNoteStore.getState().notes.includes(shown)
    && publishFetchedNoteItem(id, cached, read.item)
  ) {
    const { title, content, revision, updatedAt } = read
    // The version read is the live one, read after the row's revision and after this page's
    // writes, so it descends from them: a sync row at one of them is older, as after a write.
    noteWriteAccepted(id, revision, [shown.revision])
    useNoteStore.setState((state) => ({
      notes: state.notes.map((n) => (n === shown ? { ...n, title, content, revision, updated_at: updatedAt } : n)),
    }))
  }
  return read
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
    if (attempt && !attempt.item) {
      // Reopened from the held record after a reload: the stored item, as it may have been sent.
      const loaded = attempt.stored ? await loadNoteCopyItem(attempt.collectionUid, attempt.stored) : null
      if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
      // Never replaced by a new UID: the stored copy may already be on the server.
      if (!loaded || !attempt.stored) return failed('unconfirmed')
      // The revisions sent before the reload, any of which may be the one that landed.
      const earlier = attempt.stored.sent.slice(0, -1).map((revision) => ({ revision, text: null }))
      attempt = {
        ...attempt,
        item: loaded.item,
        title: loaded.title,
        content: loaded.content,
        createdAt: loaded.mtime !== null ? new Date(loaded.mtime) : attempt.createdAt,
        sent: [...earlier, { revision: loaded.item.etag, text: { title: loaded.title, content: loaded.content } }],
      }
      noteCopyAttempts.set(id, { attempt, accountEpoch })
    }
    const title = conflictCopyTitle(held.draft.title)
    const content = held.draft.content
    // Once a copy was sent with the most revisions, newer text goes onto it after it is confirmed.
    const revisable = !attempt || attempt.sent.length < MAX_NOTE_COPY_REVISIONS
    if (!attempt || (revisable && (attempt.title !== title || attempt.content !== content))) {
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
      attempt.sent = [...attempt.sent, { revision: attempt.item.etag, text: { title: attempt.title, content: attempt.content } }]
    }
    if (attempt.stored?.revision !== attempt.item.etag) {
      attempt.stored = storeNoteCopyItem(attempt.collectionUid, attempt.item, attempt.sent.map((sent) => sent.revision)) ?? undefined
    }
    const hadRecord = getHeldNoteRecord(id) !== undefined
    noteCopyAttempts.set(id, { attempt, accountEpoch })
    // The copy goes into the held text's record before it is sent (#1113 D1), so a lost
    // response and a reload still re-send this same item. Text kept in its record is
    // never copied with an item the record does not hold.
    const where = await storeHeldText(id)
    if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
    if (where === 'stored' ? !attempt.stored : hadRecord) return failed('unconfirmed')
    const upload = await uploadNoteCopyItem(attempt.collectionUid, attempt.item, { title: attempt.title, content: attempt.content })
    if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
    if (upload.kind === 'deleted') {
      if (getNoteCopyAttempt(id) === attempt) noteCopyAttempts.delete(id)
      return failed('deleted')
    }
    if (upload.kind === 'refused') return failed('read-only')
    if (upload.kind !== 'copied') return failed(upload.kind)
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
    // The server held another revision of the copy (a 409).
    if (upload.title !== title || upload.content !== content) {
      const ours = attempt.sent.find((sent) => sent.revision === upload.revision)
      if (!ours) {
        // Another device changed the copy since it landed. When every revision this tab sent
        // holds this text, the one that landed did too, and the copy is confirmed. Otherwise
        // nothing shows this text reached the server: it stays held here, and its record drops
        // the copy, so the next Save as a copy makes a new one.
        if (!attempt.sent.every((sent) => sent.text !== null && sameText(sent.text, { title, content }))) {
          if (getNoteCopyAttempt(id) === attempt) noteCopyAttempts.delete(id)
          await storeHeldText(id)
          if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
          return failed('changed')
        }
      } else {
        // An earlier revision this tab sent: the current text goes onto it as an edit of that
        // revision. Text the copy already holds here (typing in it, or its own failed save)
        // is never replaced.
        if (hasUnsavedNoteText(copyId)) return failed('unconfirmed')
        // The revision holds the text it was sent with, which the server just returned.
        const sentText = ours.text ?? { title: upload.title, content: upload.content }
        const carried: HeldNoteDraft = { draft: { title, content }, base: { ...sentText, revision: ours.revision } }
        // The newer text stays recoverable until the server confirms it: it goes into the
        // copy's own record before this note's record is released. Stored text whose copy
        // record cannot be written stays held here, and a retry carries it again.
        const kept = await holdNoteText(copyId, carried)
        if (!isCurrentAccountEpoch(accountEpoch)) return { kind: 'stale' }
        if (kept !== 'stored' && where === 'stored') {
          releaseHeldNoteDraft(copyId, carried)
          return failed('unconfirmed')
        }
      }
    }
    if (getNoteCopyAttempt(id) === attempt) noteCopyAttempts.delete(id)
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
    syncUnloadGuard()
  }
}

/** An open editor's typing or save state changed: the leave prompt follows it. */
export function noteEditorStateChanged(): void {
  syncUnloadGuard()
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
  // The records stay on the device: sign-out deletes them only after its own count and confirmation.
  heldNoteRecords.clear()
  heldRecordWrites.clear()
  reopenedHeldRows.clear()
  ownNoteWrites.clear()
  heldTextReopen = null
  // The preview keeps the last body it parsed in time, the last body the reader chose
  // to format anyway and the last one whose forced parse failed: all decrypted text.
  clearNotePreviewVerdict()
  useNoteStore.setState({ closingNoteIds: [], heldTextReopen: 'idle' })
  syncUnloadGuard()
}

let heldTextReopen: { accountEpoch: number; running: Promise<void> | null; done: boolean; tries: number } | null = null
// A reopen that found the key not ready tries again a few times; the records stay as they are meanwhile.
const REOPEN_TRIES = 5
const REOPEN_RETRY_MS = 2000
// A queue that does not answer (a blocked database) keeps notes closed no longer than this.
const REOPEN_TIMEOUT_MS = 5000

/** Takes reopened held texts into this page, unless the page already holds newer text for the note. */
function adoptReopenedHeldNotes(records: ReopenedHeldNote[], accountEpoch: number): void {
  const rows: StoredNote[] = []
  for (const record of records) {
    const id = record.itemUid
    if (getHeldNoteDraft(id)) continue
    // Typing in an open editor, or a closing editor's save, is newer than the record; the
    // record stays as custody, for the banner and the next load.
    if (getMountedNoteEditor(id)?.isClean() === false || closingNoteSaves.has(id)) continue
    heldNoteDrafts.set(id, {
      held: {
        draft: record.draft,
        // Only the base's revision and digest were stored: the reopened text always counts as unsaved.
        base: { title: '', content: '', revision: record.base.revision, digestOnly: record.base.digest },
        // Failed text saves again when its editor opens; refused text waits for an edit or a copy.
        failed: record.reason === 'retry-exhausted' ? 'error' : 'unproved',
        ...(record.copy ? { copy: 'unconfirmed' as const } : {}),
      },
      accountEpoch,
    })
    heldNoteRecords.set(id, { ref: record.ref, collectionUid: record.collectionUid, stored: record.draft, accountEpoch })
    if (record.copy) {
      noteCopyAttempts.set(id, {
        attempt: {
          item: null,
          stored: record.copy,
          collectionUid: record.collectionUid,
          title: '',
          content: '',
          createdAt: new Date(record.mtime),
          sent: [],
        },
        accountEpoch,
      })
    }
    const row = heldNoteRow(id, record.collectionUid, record.draft, record.mtime)
    reopenedHeldRows.set(id, { row, accountEpoch })
    rows.push(row)
  }
  if (rows.length === 0) return
  // A held note the loaded list does not show is listed from its record, as a held note the server
  // stops listing stays listed; before the list loads, the load lists it (syncFromRemote).
  if (useEtebaseStore.getState().domainLoadState.notes === 'loaded') {
    useNoteStore.setState((state) => ({
      notes: [...state.notes, ...rows.filter((row) => !state.notes.some((n) => n.id === row.id))],
    }))
  }
  useNoteStore.setState((state) => ({ heldTextReopenGen: state.heldTextReopenGen + 1 }))
  syncUnloadGuard()
}

function heldNoteRow(id: string, notebookId: string, draft: { title: string; content: string }, mtime: number): StoredNote {
  const at = new Date(Number.isFinite(mtime) ? mtime : 0)
  return { id, uid: id, title: draft.title, content: draft.content, notebookId, created_at: at, updated_at: at, revision: null }
}

/**
 * Reopens this account's held note text (#1113 D1) once per account: each note's
 * editor then starts from its text, with the reason and Save as a copy, and a copy
 * attempt stored with it is re-sent rather than made again. While this runs, the
 * notes page opens no editor. When the key is not available yet, nothing is
 * reopened, and it tries again up to REOPEN_TRIES times in all, REOPEN_RETRY_MS
 * apart; the records stay as they are.
 */
export function reopenHeldNoteText(): Promise<void> {
  const accountEpoch = getAccountEpoch()
  if (heldTextReopen?.accountEpoch === accountEpoch) {
    if (heldTextReopen.done) return Promise.resolve()
    if (heldTextReopen.running) return heldTextReopen.running
  }
  const tries = heldTextReopen?.accountEpoch === accountEpoch ? heldTextReopen.tries + 1 : 1
  const reopen = { accountEpoch, running: null as Promise<void> | null, done: false, tries }
  heldTextReopen = reopen
  useNoteStore.setState({ heldTextReopen: 'running' })
  reopen.running = (async () => {
    let done = false
    // Past the time limit the reopen stops for this page: notes open, the records stay
    // in the queue (the banner lists them) and the next load reopens them.
    let gaveUp = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const opening = openHeldNoteRecords()
      opening.catch(() => {})
      const timedOut = new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), REOPEN_TIMEOUT_MS) })
      const records = await Promise.race([opening, timedOut])
      if (records === 'timed-out') {
        gaveUp = true
        return
      }
      if (!isCurrentAccountEpoch(accountEpoch) || records === 'not-ready') return
      adoptReopenedHeldNotes(records, accountEpoch)
      done = true
    } catch (err) {
      if (isCurrentAccountEpoch(accountEpoch) && !(err instanceof AccountBoundaryChangedError)) {
        console.error('[note-store] Failed to reopen held note text', getSafeErrorDetails(err))
      }
    } finally {
      clearTimeout(timer)
      if (heldTextReopen === reopen) {
        reopen.running = null
        reopen.done = done || gaveUp
        useNoteStore.setState({ heldTextReopen: done ? 'done' : 'idle' })
        if (!done && !gaveUp && tries < REOPEN_TRIES) {
          setTimeout(() => {
            if (heldTextReopen === reopen && isCurrentAccountEpoch(accountEpoch)) void reopenHeldNoteText()
          }, REOPEN_RETRY_MS)
        }
      }
    }
  })()
  return reopen.running
}

/**
 * Notes whose unsaved text exists only in this page: held text not in its record,
 * an open editor's unsaved typing, a closing save.
 */
export function noteIdsWithTextOnlyInPage(): ReadonlySet<string> {
  return noteTextOnlyInPage()
}

/** How many notes have text only in this page (noteIdsWithTextOnlyInPage). */
export function countNoteTextOnlyInPage(): number {
  return noteTextOnlyInPage().size
}

/**
 * Saves what the open note editors hold and waits for the held records to be
 * written, so a count taken afterwards sees them (sign-out Sync now).
 */
export async function settleNoteTextForCount(): Promise<void> {
  const editors = [...mountedEditors.keys()].map((id) => getMountedNoteEditor(id)).filter((editor) => editor !== undefined)
  await Promise.all(editors.map((editor) => editor.flushAndWait().catch(() => undefined)))
  await Promise.all([...heldRecordWrites.values()])
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
  /** Reopening this account's held note text (#1113 D1): no editor opens while it runs. */
  heldTextReopen: 'idle' | 'running' | 'done'
  /** Moves on when reopened held text was taken in, so an editor opened earlier starts again from it. */
  heldTextReopenGen: number
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
  /**
   * Replaces the list with a sync's rows. Returns, for the display cache, the listed rows
   * as saved: a row read before this page's own write of the note landed is replaced by
   * this page's saved row, or left out for a note this page deleted.
   */
  syncFromRemote: (notes: StoredNote[]) => StoredNote[]
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
    heldTextReopen: 'idle',
    heldTextReopenGen: 0,

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
      // Why no note was added, once known. The page words it; no generic toast is shown here.
      // Without a reason from createItem, the session was there but a queue guard or the collection was not.
      let refusal: NoteNotCreatedReason = 'unavailable'
      try {
        const { noteToItemMeta, savedRevisionOf } = await import('@silentsuite/core')
        // Check before the lower store sees anything: a late call would run as the next account.
        if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
        const etebase = useEtebaseStore.getState()
        if (!etebase.account) refusal = 'no-session'
        itemUid = etebase.account
          ? await etebase.createItem('notes', draft.content, undefined, notebookId, noteToItemMeta(draft), (item) => {
            // Content and revision come from the same committed SDK object.
            if (isCurrentAccountEpoch(accountEpoch)) committedRevision = savedRevisionOf(item)
          }, {
            // The page words the failure itself; a refusal is not a "try again".
            suppressErrorToast: true,
            onRefused: (reason) => { refusal = reason },
            onQueued: () => { refusal = 'queued' },
          })
          : null
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) {
          throw new AccountBoundaryChangedError()
        }
        console.error('[note-store] Failed to sync new note to Etebase', getSafeErrorDetails(err))
        refusal = 'failed'
      }
      if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
      if (!itemUid) throw new NoteNotCreatedError(refusal)

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
        optimisticNoteRecords.set(pending, existing)
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
            onSaved: (etag, replaced) => {
              if (!isCurrentAccountEpoch(accountEpoch)) return
              // The base, the row the save started from and the revision it replaced are all
              // older than this save: a row at one of them, read by a sync while the save ran,
              // gives way to the save's own record.
              const older = noteWriteAccepted(id, etag, [capture.base.revision, existing.revision, replaced])
              const saved: StoredNote = { ...pending, revision: etag }
              const givesWay = (n: StoredNote) => n === pending || (n.id === id && n.revision !== null && older.has(n.revision))
              set((state) => ({ notes: state.notes.map((n) => (givesWay(n) ? saved : n)) }))
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
        // Deleted on the server at that revision: a sync that read the note before stays without it.
        // A queued delete has not reached the server, which still lists the note.
        if (outcome === 'remote') noteWriteAccepted(id, null, [revision, shown.revision])
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
      const shown = new Map(get().notes.map((n) => [n.id, n]))
      const rows: StoredNote[] = []
      const saved: StoredNote[] = []
      for (const row of remoteNotes) {
        if (!readBeforeOwnWrite(row, shown.get(row.id))) {
          rows.push(row)
          saved.push(row)
          continue
        }
        // A row read before this page's own write of the note landed gives way to the row
        // this page holds, and a note this page deleted stays away.
        const own = shown.get(row.id)
        if (!own) continue
        rows.push(own)
        if (row.revision !== null && own.revision !== null) {
          void recacheOwnNoteItem(row.id, own.notebookId, row.revision, own.revision).catch(() => {})
        }
        // The display cache gets saved text only: not the text of a save still running, which
        // may yet be refused, and not a note this page deleted that typing keeps shown.
        if (getOwnNoteWrites(row.id)?.committed !== null) saved.push(rowBeforeRunningSaves(own))
      }
      // A note the server no longer lists stays shown while its open editor holds unsaved typing (#744),
      // or while its text is held after a failed save (#1113 D1).
      const remoteIds = new Set(rows.map((n) => n.id))
      const kept = get().notes.filter((n) => !remoteIds.has(n.id) && hasUnsavedNoteText(n.id))
      // Held text reopened from its record before the list loaded, for a note the list does not show.
      const listed = new Set([...remoteIds, ...kept.map((n) => n.id)])
      const reopened: StoredNote[] = []
      for (const [id, entry] of [...reopenedHeldRows]) {
        if (!isCurrentAccountEpoch(entry.accountEpoch)) reopenedHeldRows.delete(id)
        else if (!listed.has(id) && getHeldNoteDraft(id)) reopened.push(entry.row)
      }
      set({ notes: [...rows, ...kept, ...reopened], syncStatus: 'synced' })
      return saved
    },
  }),
)

export type { NewNote }
