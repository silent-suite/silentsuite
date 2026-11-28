'use client'

import { create } from 'zustand'
import { BILLING_API_URL, ETEBASE_SERVER_URL } from '@/app/lib/config'
import { normalizeServerUrl } from '@/app/lib/server-url'
import { canDeleteCollection } from '@/app/lib/collection-access'
import { requestBirthdayReconcile } from '@/app/lib/birthday-calendar/trigger'
import { projectBirthdayMarkers, resetBirthdayMarkers } from '@/app/lib/birthday-calendar/markers'
import type {
  CollectionAccessLevel,
  CollectionType,
  ItemMeta,
  SyncChangeEvent,
} from '@silentsuite/core'
import {
  enqueue,
  casStub,
  getAll as getQueuedMutations,
  insertIfNoOutstanding,
  isLegacyEntry,
  isOfflineError,
  readOutstanding,
  replaceStub,
  remove as removeQueuedMutation,
  removeItemMutations as removeQueuedItemMutations,
  type ConfirmedRemoteMutation,
  type OfflineQueueAccountGuard,
  type QueueEntry,
  type ReplayCheckpoint,
  ReplayNotConfirmedError,
} from '@/app/lib/offline-queue'
import { secureGet } from '@/app/lib/secure-storage'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { logger } from '@/app/lib/logger'
import { parseVCard } from '@silentsuite/core/utils/vcard-parser'
import {
  ensureEncryptedEnvelope as cacheEnsureEncryptedEnvelope,
  ensureFingerprint as cacheEnsureFingerprint,
  putItem as cachePutItem,
  getItemsByType as cacheGetItemsByType,
  openQueuePayload as cacheOpenQueuePayload,
  sealQueuePayload as cacheSealQueuePayload,
  sealedPayloadDigest as cacheSealedPayloadDigest,
} from '@/app/lib/data-cache'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { RestoreDiagnosticsRecorder, classifySessionPersistence } from '@/app/lib/sync-restore-diagnostics'
import {
  AccountBoundaryChangedError,
  assertCurrentAccountEpoch,
  bumpAccountEpoch,
  establishLogoutGeneration,
  getAccountEpoch,
  isCurrentAccountEpoch,
  readLogoutGeneration,
  releaseLogoutGeneration,
} from '@/app/lib/account-epoch'
import { assertOfflineQueueAccountGuard, captureOfflineQueueAccountGuard } from '@/app/lib/offline-queue-account'

/**
 * Holds live Etebase SDK objects (Account, Collections, Items, SyncEngine).
 * These are non-serializable and must NOT go through Zustand persist.
 * This store is the bridge between the Etebase SDK and the UI data stores.
 */

// We dynamically import Etebase types to avoid SSR issues with the etebase WASM module.
// The actual Etebase SDK objects are stored as `any` in the store and typed at usage sites.

const DEFAULT_ETEBASE_SERVER_URL = ETEBASE_SERVER_URL

function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export { normalizeServerUrl }

/** Read the user's custom server URL from localStorage, falling back to the env default. */
function getServerUrl(): string {
  if (typeof window !== 'undefined') {
    const custom = localStorage.getItem('silentsuite-server-url')
    if (custom && custom.trim()) {
      const normalized = normalizeServerUrl(custom)
      if (isValidServerUrl(normalized)) return normalized
    }
  }
  return DEFAULT_ETEBASE_SERVER_URL
}

const COLLECTION_TYPE_CALENDAR = 'etebase.vevent'
const COLLECTION_TYPE_TASKS = 'etebase.vtodo'
const COLLECTION_TYPE_CONTACTS = 'etebase.vcard'
const COLLECTION_TYPE_NOTES = 'etebase.md.note'

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts' | 'notes' | 'preferences'
type VisibleCollectionTypeKey = Exclude<CollectionTypeKey, 'preferences'>
type DomainLoadStatus = 'unknown' | 'loaded' | 'failed'
type DomainLoadState = Record<CollectionTypeKey, DomainLoadStatus>
type CollectionMetaUpdates = { name?: string; description?: string; color?: string; mtime?: number }
type EtebaseCore = typeof import('@silentsuite/core')

/** `revision` is paired from the same SDK item as `content` by core `savedRevisionOf` (#744); null when unknown. */
type CachedContentItem = { uid: string; content: string; collectionUid: string; meta?: ItemMeta; revision: string | null }

/** One visible domain reaching a terminal state during initial restore. */
export type InitialVisibleDomainKey = VisibleCollectionTypeKey
export type InitialDomainLoadStatus = 'loaded' | 'failed'

/**
 * Privacy-safe notification emitted after a single visible domain finishes its
 * initial server enumeration. Carries only aggregate counts and coarse status
 * -- never item UIDs, collection UIDs, or decrypted content.
 */
export interface InitialDomainLoadEvent {
  type: InitialVisibleDomainKey
  status: InitialDomainLoadStatus
  itemCount: number
  pageCount: number
  collectionCount: number
}

export interface InitializeOptions {
  /**
   * Called after each visible domain reaches a terminal ('loaded'/'failed')
   * state and the store's maps + domainLoadState have been published. Lets a
   * fast domain (calendar) paint before slower domains finish enumerating.
   */
  onDomainLoaded?: (event: InitialDomainLoadEvent) => void | Promise<void>
}

const UNKNOWN_DOMAIN_LOAD_STATE: DomainLoadState = {
  calendar: 'unknown',
  tasks: 'unknown',
  contacts: 'unknown',
  notes: 'unknown',
  preferences: 'unknown',
}

function unknownDomainLoadState(): DomainLoadState {
  return { ...UNKNOWN_DOMAIN_LOAD_STATE }
}

function itemMetaOf(item: { getMeta?: () => ItemMeta } | null | undefined): ItemMeta | undefined {
  return typeof item?.getMeta === 'function' ? item.getMeta() : undefined
}

function incompleteLoadMessage(): string {
  return "This data hasn't finished loading yet. Retry sync, then try again."
}

const COLLECTION_DEFINITIONS: [VisibleCollectionTypeKey, string, string][] = [
  ['calendar', COLLECTION_TYPE_CALENDAR, 'Personal Calendar'],
  ['tasks', COLLECTION_TYPE_TASKS, 'Personal Tasks'],
  ['contacts', COLLECTION_TYPE_CONTACTS, 'Personal Contacts'],
  ['notes', COLLECTION_TYPE_NOTES, 'Personal Notes'],
]

function keyToCollectionType(type: CollectionTypeKey): string {
  if (type === 'calendar') return COLLECTION_TYPE_CALENDAR
  if (type === 'tasks') return COLLECTION_TYPE_TASKS
  if (type === 'contacts') return COLLECTION_TYPE_CONTACTS
  if (type === 'notes') return COLLECTION_TYPE_NOTES
  return 'silentsuite.preferences'
}

async function ensureCollectionsForAccount(
  account: any,
  core: EtebaseCore,
  accountEpoch?: number,
): Promise<Record<CollectionTypeKey, any[]>> {
  const collections: Record<CollectionTypeKey, any[]> = {
    calendar: [],
    tasks: [],
    contacts: [],
    notes: [],
    preferences: [],
  }

  // List every type before creating anything: a default is admitted only when
  // the whole discovery completed, never from a partial or failed listing.
  for (const [key, colType] of COLLECTION_DEFINITIONS) {
    const existing = await core.listCollections(account, colType)
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    collections[key] = existing
  }

  for (const [key, colType, defaultName] of COLLECTION_DEFINITIONS) {
    const existing = collections[key]
    if (existing.length > 0) {
      logger.debug(`[etebase-store] Found ${existing.length} existing ${key} collection(s)`)
    } else if (key !== 'notes') {
      if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
      const created = await core.createCollection(account, colType, { name: defaultName, mtime: Date.now() })
      if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
      collections[key] = [created]
      logger.debug(`[etebase-store] Created ${key} collection: ${created.uid}`)
    }
  }

  return collections
}

/** destroy() failed after invalidating the account boundary; `epoch` is the token it produced. */
export class EtebaseTeardownError extends Error {
  constructor(readonly epoch: number, readonly teardownError: unknown) {
    super('Etebase teardown failed after account invalidation')
    this.name = 'EtebaseTeardownError'
  }
}

/**
 * Account epoch whose initial collection discovery failed before the
 * SyncEngine was started. A later successful reconcile for the same epoch
 * starts that engine once; any other epoch ignores it.
 */
let pendingSyncEngineStartEpoch: number | null = null

/**
 * Construct, track, and start the SyncEngine for discovered collections.
 * Returns null (after stopping the engine) when the account boundary changed
 * while starting.
 */
async function startSyncEngine(
  core: EtebaseCore,
  account: any,
  serverUrl: string,
  collections: Record<CollectionTypeKey, any[]>,
  accountEpoch: number,
  diagnostics?: RestoreDiagnosticsRecorder,
): Promise<any | null> {
  const engine = new core.SyncEngine({
    serverUrl,
    pollIntervalMs: 30_000,
  })
  // The server refused this session's token (revoked or expired): nothing
  // syncs until the user signs in again, so show the existing unlock prompt.
  // Local data and queued edits stay as they are.
  engine.onAuthFailure?.(() => {
    if (!isCurrentAccountEpoch(accountEpoch)) return
    const current = useEtebaseStore.getState().syncEngine
    if (current && current !== engine) return
    useEtebaseStore.setState({ restoreBlocked: true })
  })

  try {
    return await trackAndStartSyncEngine(engine, account, collections, accountEpoch, diagnostics)
  } catch (err) {
    // A partially started engine may already hold a poll or reconnect timer.
    engine.stop()
    throw err
  }
}

async function trackAndStartSyncEngine(
  engine: any,
  account: any,
  collections: Record<CollectionTypeKey, any[]>,
  accountEpoch: number,
  diagnostics?: RestoreDiagnosticsRecorder,
): Promise<any | null> {
  // Track all collections
  diagnostics?.startPhase('syncEngineTrackCollections')
  for (const [key, colType] of COLLECTION_DEFINITIONS) {
    for (const collection of collections[key]) {
      await trackCollectionWithSyncEngine(engine, colType, collection.uid, accountEpoch)
      assertCurrentAccountEpoch(accountEpoch)
    }
  }
  diagnostics?.completePhase('syncEngineTrackCollections', {
    collectionCount: COLLECTION_DEFINITIONS.reduce((count, [key]) => count + collections[key].length, 0),
  })

  diagnostics?.startPhase('syncEngineStart')
  await engine.start(account)
  if (!isCurrentAccountEpoch(accountEpoch)) {
    engine.stop()
    return null
  }
  diagnostics?.completePhase('syncEngineStart')
  return engine
}

/**
 * List every item for a single visible domain into the shared cache maps.
 * Paginates each concrete collection to completion and skips tombstones.
 * Returns privacy-safe aggregate counts only (no UIDs, no content).
 */
async function loadInitialDomainItems(
  core: EtebaseCore,
  account: any,
  key: VisibleCollectionTypeKey,
  typedCollections: any[],
  maps: {
    itemCache: Map<string, any>
    itemTypeMap: Map<string, CollectionTypeKey>
    itemCollectionMap: Map<string, string>
  },
  accountEpoch: number,
): Promise<{ itemCount: number; pageCount: number }> {
  let itemCount = 0
  let pageCount = 0

  for (const collection of typedCollections) {
    let stoken: string | null = null
    let done = false

    while (!done) {
      const response = await core.listItems(account, collection, stoken)
      assertCurrentAccountEpoch(accountEpoch)
      pageCount += 1
      for (const item of response.items) {
        assertCurrentAccountEpoch(accountEpoch)
        if (item.isDeleted) continue
        // Etebase notes spec: only items with an empty `type` are notes.
        if (key === 'notes' && !core.isMarkdownNoteItem(itemMetaOf(item))) continue
        maps.itemCache.set(item.uid, item)
        maps.itemTypeMap.set(item.uid, key)
        maps.itemCollectionMap.set(item.uid, collection.uid)
        itemCount += 1
      }
      stoken = response.stoken
      done = response.done
    }
  }

  return { itemCount, pageCount }
}

function buildInitialDomainPublish(
  state: EtebaseState,
  key: VisibleCollectionTypeKey,
  loadedMaps: {
    itemCache: Map<string, any>
    itemTypeMap: Map<string, CollectionTypeKey>
    itemCollectionMap: Map<string, string>
  },
  domainLoadState: DomainLoadState,
  status: InitialDomainLoadStatus,
): Partial<EtebaseState> {
  const itemCache = new Map(state.itemCache)
  const itemTypeMap = new Map(state.itemTypeMap)
  const itemCollectionMap = new Map(state.itemCollectionMap)

  // Early-paint domains can be interacted with while slower domains are still
  // enumerating. Publish only the domain that just reached a terminal state;
  // otherwise a later tasks/contacts publish can overwrite calendar mutations
  // made against the live store with an older local snapshot.
  if (status === 'loaded') {
    for (const [uid, type] of itemTypeMap.entries()) {
      if (type !== key) continue
      itemCache.delete(uid)
      itemTypeMap.delete(uid)
      itemCollectionMap.delete(uid)
    }
    for (const [uid, item] of loadedMaps.itemCache.entries()) {
      itemCache.set(uid, item)
    }
    for (const [uid, type] of loadedMaps.itemTypeMap.entries()) {
      itemTypeMap.set(uid, type)
    }
    for (const [uid, collectionUid] of loadedMaps.itemCollectionMap.entries()) {
      itemCollectionMap.set(uid, collectionUid)
    }
  }

  return {
    itemCache,
    itemTypeMap,
    itemCollectionMap,
    domainLoadState: { ...state.domainLoadState, ...domainLoadState },
  }
}

async function trackCollectionWithSyncEngine(
  syncEngine: any | null,
  collectionType: string,
  collectionUid: string,
  accountEpoch?: number,
): Promise<void> {
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
  if (!syncEngine) return
  syncEngine.trackCollection(collectionType as CollectionType, collectionUid)
}

/**
 * Cached content for most types is the raw item content. Notes also carry
 * their title and mtime in item metadata, so their cache record is the
 * core `serializeNote` envelope holding both.
 */
async function toCacheContent(
  type: CollectionTypeKey,
  itemUid: string,
  collectionUid: string,
  content: string,
  meta?: ItemMeta,
): Promise<string> {
  if (type !== 'notes') return content
  const core = await import('@silentsuite/core')
  return core.serializeNote(core.noteFromEtebaseItem(itemUid, content, meta, collectionUid))
}

export type SealIntent = 'note' | 'favorite'

/**
 * The Save as a copy prepared for refused note text (#1113 D1): the copy's UID,
 * its revision, the SDK's cacheSave of the item, base64, and every revision of
 * the copy sent so far, oldest first (`revision` last). The cacheSave bytes are
 * Etebase ciphertext under the notebook's keys, never plaintext; revisions are
 * random IDs the server already holds for a copy that landed.
 */
export interface SealedNoteCopy {
  uid: string
  item: string
  revision: string
  sent: string[]
}

/** The most revisions one copy is sent with; newer text after that goes onto the copy once it is confirmed. */
export const MAX_NOTE_COPY_REVISIONS = 32

/**
 * v1: queued note custody (#744). v2: the same, written for note text whose save
 * was refused (held 'base-changed') or failed (held 'retry-exhausted') (#1113 D1),
 * with an optional prepared copy. Replay of
 * v2 ignores `copy`; a build that knows only v1 holds a v2 record as 'unreadable'.
 */
interface SealedNotePayload {
  v: 1 | 2
  kind: 'note'
  body: { content: string; meta: { name: string; mtime: number } }
  base: { revision: string | null; digest: string }
  prior: string[]
  copy?: SealedNoteCopy
}

const SEALED_DIGEST = /^[0-9a-f]{64}$/
const SEALED_COPY_ITEM = /^[A-Za-z0-9+/]+={0,2}$/

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}

/** Exact validation of an opened sealed note payload (#744 §2); anything else is unreadable. */
function parseSealedNotePayload(plaintext: string): SealedNotePayload | null {
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return null
  }
  const v1Keys = ['v', 'kind', 'body', 'base', 'prior']
  if (!hasExactKeys(value, v1Keys) && !hasExactKeys(value, [...v1Keys, 'copy'])) return null
  if (value.kind !== 'note') return null
  if (value.v === 1) {
    if ('copy' in value) return null
  } else if (value.v === 2) {
    if ('copy' in value) {
      const copy = value.copy
      if (!hasExactKeys(copy, ['uid', 'item', 'revision', 'sent'])) return null
      if (typeof copy.uid !== 'string' || copy.uid.length === 0) return null
      if (typeof copy.revision !== 'string' || copy.revision.length === 0) return null
      if (typeof copy.item !== 'string' || !SEALED_COPY_ITEM.test(copy.item)) return null
      const { sent } = copy
      if (!Array.isArray(sent) || sent.length === 0 || sent.length > MAX_NOTE_COPY_REVISIONS) return null
      if (!sent.every((revision: unknown) => typeof revision === 'string' && revision.length > 0)) return null
      if (sent[sent.length - 1] !== copy.revision) return null
    }
  } else {
    return null
  }
  const { body, base, prior } = value
  if (!hasExactKeys(body, ['content', 'meta']) || typeof body.content !== 'string') return null
  if (!hasExactKeys(body.meta, ['name', 'mtime']) || typeof body.meta.name !== 'string') return null
  if (typeof body.meta.mtime !== 'number' || !Number.isFinite(body.meta.mtime)) return null
  if (!hasExactKeys(base, ['revision', 'digest'])) return null
  if (base.revision !== null && !(typeof base.revision === 'string' && base.revision.length > 0)) return null
  if (typeof base.digest !== 'string' || !SEALED_DIGEST.test(base.digest)) return null
  if (!Array.isArray(prior) || prior.length > 32) return null
  if (!prior.every((digest: unknown) => typeof digest === 'string' && SEALED_DIGEST.test(digest))) return null
  return value as SealedNotePayload
}

/** The text an edit was typed on, with the server revision it was read at (null if unknown). */
export interface SealedEditingBase {
  title: string
  content: string
  revision: string | null
  /**
   * Set on a base reopened from a held note record (#1113 D1), which keeps only
   * the base text's digest: `title` and `content` are then not the base text, no
   * text comparison can prove this base, and only its revision can.
   */
  digestOnly?: string
}

function knownRevision(revision: unknown): revision is string {
  return typeof revision === 'string' && revision.length > 0
}

/** Live note equality with the editing base, after the producer title normalization. */
async function noteMatchesBase(
  core: EtebaseCore,
  item: any,
  itemUid: string,
  base: SealedEditingBase,
  assertGuard: () => void,
): Promise<boolean> {
  if (!item || item.isDeleted) return false
  // A digest-only base has no text to compare: never proved by text.
  if (base.digestOnly !== undefined) return false
  const raw = await item.getContent()
  assertGuard()
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
  const title = core.noteFromEtebaseItem(itemUid, '', item.getMeta()).title
  return title === core.noteFromEtebaseItem(itemUid, '', { name: base.title }).title && text === base.content
}

/**
 * Stub succession (#744 §4, §7 step 2). The new text may replace the note's
 * sealed record only if that record is its single outstanding custody, opens
 * and validates, and is the text this edit was typed on. The replacement
 * keeps the original base proof and appends the replaced body's digest to
 * `prior`; it never takes a cached or fetched server revision. Anything else
 * resolves false and leaves the accepted bytes untouched.
 */
async function replaceNoteStubWithDescendant(
  outstanding: QueueEntry[],
  itemUid: string,
  content: string,
  meta: ItemMeta | undefined,
  base: SealedEditingBase,
  offlineQueueGuard: OfflineQueueAccountGuard,
  accountEpoch: number,
  getState: () => EtebaseState,
): Promise<boolean> {
  const assertGuard = () => assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  const stub = outstanding[0]
  if (outstanding.length !== 1 || !stub || stub.type !== 'sealed-update' || !stub.sealed || typeof stub.rev !== 'number') return false
  if (typeof meta?.name !== 'string' || typeof meta.mtime !== 'number' || !Number.isFinite(meta.mtime)) return false
  // A digest-only base cannot show that this edit was typed on the stub's text.
  if (base.digestOnly !== undefined) return false
  const associatedData = `${offlineQueueGuard.accountFingerprint}|notes|${itemUid}`
  const opened = await cacheOpenQueuePayload(stub.sealed, associatedData, accountEpoch)
  assertGuard()
  if (opened.kind !== 'opened') return false
  const payload = parseSealedNotePayload(opened.plaintext)
  if (!payload) return false
  const core = await import('@silentsuite/core')
  assertGuard()
  const normTitle = (name: string) => core.noteFromEtebaseItem(itemUid, '', { name }).title
  // The declared causal relation: this edit was typed on the stub's own text.
  if (normTitle(payload.body.meta.name) !== normTitle(base.title) || payload.body.content !== base.content) return false
  const replacedDigest = await cacheSealedPayloadDigest(['note', normTitle(payload.body.meta.name), payload.body.content])
  assertGuard()
  // A v2 stub keeps its version and prepared copy (#1113 D1), so the copy id outlives the replacement.
  const successor: SealedNotePayload = {
    v: payload.v,
    kind: 'note',
    body: { content, meta: { name: meta.name, mtime: meta.mtime } },
    base: payload.base,
    prior: [...payload.prior, replacedDigest].slice(-32),
    ...(payload.copy ? { copy: payload.copy } : {}),
  }
  const sealed = await cacheSealQueuePayload(JSON.stringify(successor), associatedData, accountEpoch)
  assertGuard()
  if (!sealed) return false
  const replaced = await replaceStub({ collectionType: 'notes', itemUid }, { id: stub.id, rev: stub.rev }, sealed, offlineQueueGuard)
  assertGuard()
  if (!replaced) return false
  // Custody is durable; a failed display write does not revoke acceptance.
  try {
    const collectionUid = stub.collectionUid ?? ''
    const cacheContent = await toCacheContent('notes', itemUid, collectionUid, content, meta)
    assertGuard()
    await cachePutItem({ itemUid, collectionType: 'notes', collectionUid, content: cacheContent, lastModified: Date.now() }, accountEpoch)
  } catch (displayErr) {
    // Only a boundary this tab crossed revokes it; a display record another tab cleared does not.
    if (displayErr instanceof AccountBoundaryChangedError && !isCurrentAccountEpoch(accountEpoch)) throw displayErr
    logger.warn('[etebase-store] Display write after sealed succession failed', getSafeErrorDetails(displayErr))
  }
  assertGuard()
  return true
}

/**
 * How a note's held page text record is held (#1113 D1): 'base-changed' for text
 * whose save was refused, 'retry-exhausted' for text whose save failed otherwise.
 * Both are existing held reasons; replay never sends either until the user retries.
 */
export type HeldTextReason = 'base-changed' | 'retry-exhausted'

function isHeldTextReason(held: QueueEntry['held']): held is HeldTextReason {
  return held === 'base-changed' || held === 'retry-exhausted'
}

/**
 * Whether a note's outstanding custody is exactly its own held text (#1113 D1):
 * one sealed v2 note record held as 'base-changed' or 'retry-exhausted' that opens
 * and validates in this account. Anything else, including an unreadable record, is not.
 */
async function isHeldRefusedTextRecord(
  outstanding: QueueEntry[],
  itemUid: string,
  guard: OfflineQueueAccountGuard,
  accountEpoch: number,
): Promise<boolean> {
  const record = outstanding[0]
  if (outstanding.length !== 1 || !record || record.type !== 'sealed-update' || !record.sealed) return false
  if (!isHeldTextReason(record.held) || typeof record.rev !== 'number' || record.itemUid !== itemUid) return false
  const opened = await cacheOpenQueuePayload(record.sealed, `${guard.accountFingerprint}|notes|${itemUid}`, accountEpoch)
  if (opened.kind !== 'opened') return false
  return parseSealedNotePayload(opened.plaintext)?.v === 2
}

/** A held note record this page wrote or reopened: the queue record's id at its revision. */
export interface HeldNoteRecordRef {
  id: string
  rev: number
}

/** A refused note text reopened from its held record (#1113 D1). */
export interface ReopenedHeldNote {
  ref: HeldNoteRecordRef
  itemUid: string
  collectionUid: string
  draft: { title: string; content: string }
  mtime: number
  /** Only the base's revision and digest are stored; its text is not. */
  base: { revision: string | null; digest: string }
  /** Refused, or failed otherwise. */
  reason: HeldTextReason
  copy?: SealedNoteCopy
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Writes held note text as a sealed v2 record held for `reason` (#1113 D1):
 * an update of `known` at its revision when given, else a new record, inserted only
 * while the note has no outstanding custody. The record keeps the draft, the base
 * revision and digest, and the prepared copy, all inside the AES-GCM payload bound
 * to `<fingerprint>|notes|<itemUid>`. Replay never sends it until the user retries
 * it, and no display record is written. Resolves the record now holding this text;
 * null when nothing was written and `known`, if given, is gone; 'blocked' when
 * `known` still exists but could not be updated, so it may hold older text or copy.
 */
export async function writeHeldNoteRecord(
  itemUid: string,
  collectionUid: string,
  draft: { title: string; content: string },
  base: SealedEditingBase,
  copy: SealedNoteCopy | undefined,
  known: HeldNoteRecordRef | undefined,
  reason: HeldTextReason = 'base-changed',
): Promise<HeldNoteRecordRef | null | 'blocked'> {
  const accountEpoch = getAccountEpoch()
  const { account, accountFingerprint } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return null
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
  await cacheEnsureFingerprint(guard.accountFingerprint, accountEpoch)
  assertGuard()
  if (!await cacheEnsureEncryptedEnvelope(accountEpoch)) return null
  assertGuard()
  const core = await import('@silentsuite/core')
  assertGuard()
  const meta = core.noteToItemMeta({ title: draft.title, updated_at: new Date() })
  const digest = base.digestOnly ?? await cacheSealedPayloadDigest([
    'note',
    core.noteFromEtebaseItem(itemUid, '', { name: base.title }).title,
    base.content,
  ])
  assertGuard()
  const payload: SealedNotePayload = {
    v: 2,
    kind: 'note',
    body: { content: draft.content, meta: { name: String(meta.name), mtime: Number(meta.mtime) } },
    base: { revision: knownRevision(base.revision) ? base.revision : null, digest },
    prior: [],
    ...(copy ? { copy } : {}),
  }
  const sealed = await cacheSealQueuePayload(JSON.stringify(payload), `${guard.accountFingerprint}|notes|${itemUid}`, accountEpoch)
  assertGuard()
  if (!sealed) return null
  if (known) {
    const updated = await casStub(known.id, known.rev, { sealed, held: reason }, guard)
    assertGuard()
    if (updated) return { id: known.id, rev: known.rev + 1 }
    // The record moved on (the banner's Retry, replay holding it again): while it is still this
    // note's held v2 record, it is updated at its current revision. A record that is gone gets a
    // new one below; one that still exists in any other state blocks the write.
    const current = (await readOutstanding({ collectionType: 'notes', itemUid }, guard)).find((entry) => entry.id === known.id)
    assertGuard()
    if (current) {
      const ours = isHeldTextReason(current.held) && typeof current.rev === 'number'
        && await isHeldRefusedTextRecord([current], itemUid, guard, accountEpoch)
      assertGuard()
      if (!ours || !await casStub(current.id, current.rev, { sealed, held: reason }, guard)) return 'blocked'
      assertGuard()
      return { id: current.id, rev: (current.rev as number) + 1 }
    }
  }
  const inserted = await insertIfNoOutstanding(
    { type: 'sealed-update', collectionType: 'notes', collectionUid, itemUid, sealed, rev: 1, held: reason },
    guard,
  )
  assertGuard()
  if (!inserted) return null
  // The record just inserted is found by its own random IV.
  const outstanding = await readOutstanding({ collectionType: 'notes', itemUid }, guard)
  assertGuard()
  const ours = outstanding.find((entry) => (
    entry.sealed && typeof entry.rev === 'number'
    && entry.sealed.iv.length === sealed.iv.length && entry.sealed.iv.every((byte, i) => byte === sealed.iv[i])
  ))
  return ours && typeof ours.rev === 'number' ? { id: ours.id, rev: ours.rev } : null
}

/** Deletes a held note record at its revision only (#1113 D1); false when it moved on or is gone. */
export async function deleteHeldNoteRecord(known: HeldNoteRecordRef): Promise<boolean> {
  const { account, accountFingerprint } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return false
  const deleted = await casStub(known.id, known.rev, 'delete', guard)
  assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
  return deleted
}

/**
 * Opens this account's held refused-text records (#1113 D1): sealed v2 note records
 * held as 'base-changed' or 'retry-exhausted'. Only records of the current account fingerprint are read,
 * and each opens only under its own `<fingerprint>|notes|<itemUid>` binding. Each is
 * decoded on its own; one that does not open or validate is left as it is. Resolves
 * 'not-ready' when the key is not available yet, so nothing can be known.
 */
export async function openHeldNoteRecords(): Promise<ReopenedHeldNote[] | 'not-ready'> {
  const accountEpoch = getAccountEpoch()
  const { account, accountFingerprint } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return 'not-ready'
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
  const entries = await getQueuedMutations(guard)
  assertGuard()
  const reopened: ReopenedHeldNote[] = []
  for (const entry of entries) {
    if (entry.accountFingerprint !== guard.accountFingerprint) continue
    if (entry.type !== 'sealed-update' || entry.collectionType !== 'notes' || !isHeldTextReason(entry.held)) continue
    const reason = entry.held
    if (!entry.sealed || typeof entry.rev !== 'number' || !entry.itemUid || !entry.collectionUid) continue
    const opened = await cacheOpenQueuePayload(entry.sealed, `${guard.accountFingerprint}|notes|${entry.itemUid}`, accountEpoch)
    assertGuard()
    if (opened.kind === 'not-ready') return 'not-ready'
    if (opened.kind !== 'opened') continue
    const payload = parseSealedNotePayload(opened.plaintext)
    if (payload?.v !== 2) continue
    let rev = entry.rev
    if (opened.resealed) {
      // Opened with the previous key only: store the identical plaintext under the current key.
      if (!await casStub(entry.id, rev, { sealed: opened.resealed }, guard)) continue
      assertGuard()
      rev += 1
    }
    reopened.push({
      ref: { id: entry.id, rev },
      itemUid: entry.itemUid,
      collectionUid: entry.collectionUid,
      draft: { title: payload.body.meta.name, content: payload.body.content },
      mtime: payload.body.meta.mtime,
      base: payload.base,
      reason,
      ...(payload.copy ? { copy: payload.copy } : {}),
    })
  }
  return reopened
}

/**
 * The prepared copy as stored with its held text: the SDK's cacheSave, base64, with
 * the revisions sent so far, ending with this item's (#1113 D1).
 */
export function storeNoteCopyItem(collectionUid: string, item: any, sent: string[]): SealedNoteCopy | null {
  const { account, collections } = useEtebaseStore.getState()
  if (!account || !item?.uid || !item.etag) return null
  if (sent.length === 0 || sent.length > MAX_NOTE_COPY_REVISIONS || sent[sent.length - 1] !== item.etag) return null
  const collection = resolveCollection(collections, 'notes', collectionUid)
  if (!collection) return null
  const saved = account.getCollectionManager().getItemManager(collection).cacheSave(item)
  return { uid: item.uid, item: bytesToBase64(saved), revision: item.etag, sent: [...sent] }
}

/**
 * Loads a stored prepared copy (#1113 D1), with the title and text of its revision
 * decrypted locally. Null when it does not load as the same UID at the same revision
 * or cannot be decrypted; nothing is sent.
 */
export async function loadNoteCopyItem(
  collectionUid: string,
  copy: SealedNoteCopy,
): Promise<{ item: any; title: string; content: string; mtime: number | null } | null> {
  const { account, collections } = useEtebaseStore.getState()
  if (!account) return null
  const collection = resolveCollection(collections, 'notes', collectionUid)
  if (!collection) return null
  try {
    const item = account.getCollectionManager().getItemManager(collection).cacheLoad(base64ToBytes(copy.item))
    if (item.uid !== copy.uid || item.etag !== copy.revision) return null
    const meta = item.getMeta()
    const raw = await item.getContent()
    const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    const mtime = typeof meta?.mtime === 'number' && Number.isFinite(meta.mtime) ? meta.mtime : null
    return { item, title: typeof meta?.name === 'string' ? meta.name : '', content, mtime }
  } catch {
    return null
  }
}

type UpdateItemOptions = NonNullable<Parameters<EtebaseActions['updateItem']>[3]>

/**
 * A sealed-intent note save (#744 §7). It dispatches only at the captured
 * base revision, through a clone, and never borrows the cached item's own
 * revision. On a conflict or an unknown revision it rebinds once to a fresh,
 * live copy that still equals the base. A known conflict is never admitted
 * offline; any other network failure goes through checked admission.
 */
async function updateNoteAtCapturedBase(
  itemUid: string,
  content: string,
  options: UpdateItemOptions,
  get: () => EtebaseState,
  set: (partial: Partial<EtebaseState>) => void,
): Promise<'remote' | 'queued' | false> {
  const accountEpoch = getAccountEpoch()
  const { account, collections, itemCache, itemCollectionMap, accountFingerprint } = get()
  const offlineQueueGuard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!offlineQueueGuard) return false
  // 'changed' only with proof that the note moved on from the base (#1113 D1).
  const refuse = (reason?: 'changed'): false => {
    if (isCurrentAccountEpoch(accountEpoch)) options.onRefused?.(reason)
    return false
  }
  const base = options.base
  if (!base) return refuse()
  const knownCollectionUid = itemCollectionMap.get(itemUid) ?? options.collectionUid
  if (!knownCollectionUid) return refuse()
  const collection = resolveCollection(collections, 'notes', knownCollectionUid)
  const cached = itemCache.get(itemUid)
  const meta = options.meta
  const assertGuard = () => assertOfflineQueueAccountGuard(offlineQueueGuard, get())
  let admissionRevision: string | null = knownRevision(base.revision) ? base.revision : null
  let sawConflict = false
  let proving = false
  let standIn = false
  const admitOffline = async (): Promise<'queued' | false> => {
    const queued = await queueOfflineUpdate(
      'notes',
      itemUid,
      collection?.uid ?? knownCollectionUid,
      content,
      meta,
      { ...options, admissionRevision },
      offlineQueueGuard,
      accountEpoch,
      get,
    )
    return queued === 'queued' ? 'queued' : refuse()
  }
  // Outstanding custody comes first (§7 step 2): no dispatch or admission runs
  // while this note has queued work, except a proved descendant of its stub.
  let outstanding: QueueEntry[]
  try {
    outstanding = await readOutstanding({ collectionType: 'notes', itemUid }, offlineQueueGuard)
    assertGuard()
  } catch (err) {
    if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
    return refuse()
  }
  // The note's own refused text, held as a v2 record (#1113 D1), is not queued work:
  // it never replays on its own, so the save goes on and an accepted one deletes it.
  let ownRefusedText = false
  if (outstanding.length > 0) {
    try {
      ownRefusedText = await isHeldRefusedTextRecord(outstanding, itemUid, offlineQueueGuard, accountEpoch)
      assertGuard()
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      ownRefusedText = false
    }
  }
  if (outstanding.length > 0 && !ownRefusedText) {
    options.onCustodyObserved?.()
    try {
      const merged = await replaceNoteStubWithDescendant(
        outstanding, itemUid, content, meta, base, offlineQueueGuard, accountEpoch, get,
      )
      return merged ? 'queued' : refuse()
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      logger.warn('[etebase-store] Sealed note succession failed', getSafeErrorDetails(err))
      return refuse()
    }
  }
  // No notebook object in memory (reload while offline): only checked admission is possible.
  // An obligated save can never be admitted offline, so it refuses.
  if (!collection) return options.obligated ? refuse() : admitOffline()
  try {
    const core = await import('@silentsuite/core')
    assertGuard()
    const dispatch = (source: any, etag: string) => core.updateItemIfUnchanged(account, collection, source, content, meta, {
      etagOverride: etag,
      beforeDispatch: assertGuard,
    })
    // `replaced` is the revision the write went over; null when the server already held the text.
    const publish = async (saved: { item: any; etag: string }, replaced: string | null): Promise<'remote'> => {
      assertGuard()
      const nextCache = new Map(get().itemCache)
      nextCache.set(itemUid, saved.item)
      set({ itemCache: nextCache })
      options.onSaved?.(saved.etag, replaced)
      return 'remote'
    }
    // An obligated save skips the revision dispatch: it writes only after the fresh proof below.
    // So does a save whose cached item is at another revision (a sync can leave an older one):
    // its metadata, merged into the write, would not be the metadata of the revision written over.
    // The fresh read then stands in for that dispatch, so a server error there shows the save
    // error, as one on the dispatch would.
    standIn = !options.obligated && Boolean(cached && admissionRevision) && core.savedRevisionOf(cached) !== admissionRevision
    if (!options.obligated && cached && admissionRevision && !standIn) {
      const first = await dispatch(cached, admissionRevision)
      assertGuard()
      if (first.kind === 'saved') return await publish(first, admissionRevision)
      sawConflict = true
    }
    // One rebind: a fresh, live copy that still equals the editing base.
    proving = true
    const fresh = await core.fetchItemFresh(account, collection, itemUid)
    assertGuard()
    // A missing copy is not proof of anything; a live or deleted one that differs is.
    if (!fresh) return refuse()
    // The server already holds exactly this text (the banner's Retry replayed this note's own
    // record, or the same edit was saved elsewhere): nothing is written, and the save is done
    // at that revision.
    const typedTitle = meta?.name
    if (typeof typedTitle === 'string' && await noteMatchesBase(core, fresh, itemUid, { title: typedTitle, content, revision: null }, assertGuard)) {
      const heldRevision = core.savedRevisionOf(fresh)
      if (heldRevision) return await publish({ item: fresh, etag: heldRevision }, null)
    }
    // A digest-only base cannot be compared, so a mismatch proves nothing about it.
    if (!await noteMatchesBase(core, fresh, itemUid, base, assertGuard)) return base.digestOnly !== undefined ? refuse() : refuse('changed')
    const freshRevision = core.savedRevisionOf(fresh)
    if (!freshRevision) return refuse()
    if (!admissionRevision) admissionRevision = freshRevision
    const second = await dispatch(fresh, freshRevision)
    assertGuard()
    if (second.kind === 'saved') return await publish(second, freshRevision)
    return refuse('changed')
  } catch (err) {
    if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
    if (!isOfflineError(err)) {
      console.error('[etebase-store] Failed to update notes item', getSafeErrorDetails(err))
      if (sawConflict || (proving && !standIn)) return refuse()
      if (!options.suppressErrorToast) showErrorToast(`Failed to save ${itemSaveNoun('notes')}. Please try again.`)
      return false
    }
    // A known conflict leaves reconciliation unproved; a pre-await snapshot cannot prove it.
    // An obligated save is never sealed offline.
    if (sawConflict || options.obligated) return refuse()
    return admitOffline()
  }
}

/**
 * T2 (#744): whether a note has outstanding queue custody in the current
 * account. An unreadable queue counts as outstanding, so the editor is obliged.
 */
export async function hasOutstandingNoteCustody(itemUid: string): Promise<boolean> {
  const accountEpoch = getAccountEpoch()
  const { account, accountFingerprint } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return false
  try {
    const outstanding = await readOutstanding({ collectionType: 'notes', itemUid }, guard)
    assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
    if (outstanding.length === 0) return false
    // The note's own refused text (#1113 D1) is not queued work, as in the save path.
    const own = await isHeldRefusedTextRecord(outstanding, itemUid, guard, accountEpoch)
    assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
    return !own
  } catch (err) {
    if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
    return true
  }
}

/**
 * Release proof (#744 §5): a fresh live copy of the note still equals `base`
 * (at its revision, when known) and the note has no outstanding custody,
 * before and after the read. Anything unproved resolves false.
 */
export async function proveLiveNoteBase(itemUid: string, base: SealedEditingBase): Promise<boolean> {
  const { account, accountFingerprint, collections, itemCollectionMap } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return false
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
  const collectionUid = itemCollectionMap.get(itemUid)
  const collection = collectionUid ? resolveCollection(collections, 'notes', collectionUid) : null
  if (!collection) return false
  const noCustody = async () => {
    const outstanding = await readOutstanding({ collectionType: 'notes', itemUid }, guard)
    assertGuard()
    return outstanding.length === 0
  }
  try {
    if (!await noCustody()) return false
    const core = await import('@silentsuite/core')
    assertGuard()
    const fresh = await core.fetchItemFresh(account, collection, itemUid)
    assertGuard()
    if (!fresh || !await noteMatchesBase(core, fresh, itemUid, base, assertGuard)) return false
    if (knownRevision(base.revision) && core.savedRevisionOf(fresh) !== base.revision) return false
    return await noCustody()
  } catch {
    return false
  }
}

/** A fresh live note copy that equals the shown note, with its own saved revision. */
export interface ProvedNote {
  revision: string
  /** The fresh SDK item the proof read; never published to the item cache. */
  item: any
}

/**
 * #744 §9 proof for a destructive note path: a fresh live copy that equals
 * `base`, returning that copy with its own saved revision. Any error, or an
 * unknown revision, is not proved.
 */
export async function proveNoteRevision(itemUid: string, base: SealedEditingBase): Promise<ProvedNote | null> {
  const { account, accountFingerprint, collections, itemCollectionMap } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return null
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
  const collectionUid = itemCollectionMap.get(itemUid)
  const collection = collectionUid ? resolveCollection(collections, 'notes', collectionUid) : null
  if (!collection) return null
  try {
    const core = await import('@silentsuite/core')
    assertGuard()
    const fresh = await core.fetchItemFresh(account, collection, itemUid)
    assertGuard()
    if (!fresh || !await noteMatchesBase(core, fresh, itemUid, base, assertGuard)) return null
    const revision = core.savedRevisionOf(fresh)
    return revision ? { revision, item: fresh } : null
  } catch {
    return null
  }
}

/** What a read of a note's live server copy found (#1113 D1). */
export type LiveNoteRead =
  | { kind: 'note'; title: string; content: string; revision: string | null; updatedAt: Date; item: unknown }
  /** The server holds a tombstone: proof that the note was deleted. */
  | { kind: 'deleted' }
  | { kind: 'offline' }
  /** The copy could not be decrypted, or another app made it something other than a note. */
  | { kind: 'unreadable' }
  /** Anything else, including a missing copy, which is not proof of deletion. */
  | { kind: 'unknown' }

/**
 * A fresh read of a note's live server copy, decrypted in memory for display
 * only. It never touches the item cache, the note store or any editor.
 */
export async function readLiveNote(itemUid: string, collectionUid?: string): Promise<LiveNoteRead> {
  const { account, accountFingerprint, collections, itemCollectionMap } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return { kind: 'unknown' }
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
  const knownCollectionUid = itemCollectionMap.get(itemUid) ?? collectionUid
  const collection = knownCollectionUid ? resolveCollection(collections, 'notes', knownCollectionUid) : null
  if (!collection) return { kind: 'unknown' }
  let core: EtebaseCore
  let fresh: any
  try {
    core = await import('@silentsuite/core')
    assertGuard()
    fresh = await core.fetchItemFresh(account, collection, itemUid)
    assertGuard()
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) return { kind: 'unknown' }
    return isOfflineError(err) ? { kind: 'offline' } : { kind: 'unknown' }
  }
  if (!fresh) return { kind: 'unknown' }
  if (fresh.isDeleted) return { kind: 'deleted' }
  try {
    const meta = fresh.getMeta()
    if (!core.isMarkdownNoteItem(meta)) return { kind: 'unreadable' }
    const raw = await fresh.getContent()
    assertGuard()
    const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    const read = core.noteFromEtebaseItem(itemUid, content, meta)
    return { kind: 'note', title: read.title, content, revision: core.savedRevisionOf(fresh), updatedAt: read.updated_at, item: fresh }
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) return { kind: 'unknown' }
    return { kind: 'unreadable' }
  }
}

/**
 * Puts a note's freshly read SDK item into the item cache (#1113 D1), as a sync of
 * that one item would, only while the cache still holds `expected` for it. The
 * list row and the cached item then stay one revision, which the save and move
 * paths rely on. Only an existing entry is replaced, so its type and notebook maps
 * already hold it. Resolves false, changing nothing, when the cache moved on.
 */
export function publishFetchedNoteItem(itemUid: string, expected: unknown, fresh: unknown): boolean {
  const state = useEtebaseStore.getState()
  if (expected === undefined || state.itemCache.get(itemUid) !== expected) return false
  const itemCache = new Map(state.itemCache)
  itemCache.set(itemUid, fresh)
  useEtebaseStore.setState({ itemCache })
  return true
}

/**
 * Builds a Save as a copy item locally (#1113 D1): its UID and revision are
 * chosen here, before anything is sent. No network.
 */
export async function prepareNoteCopyItem(collectionUid: string, content: string, meta: ItemMeta): Promise<any | null> {
  const { account, collections } = useEtebaseStore.getState()
  if (!account) return null
  const collection = resolveCollection(collections, 'notes', collectionUid)
  if (!collection) return null
  return account.getCollectionManager().getItemManager(collection).create(meta, content)
}

/**
 * The same copy with newer text (#1113 D1): a new revision of the prepared
 * item, same UID, built locally. No network.
 */
export async function reviseNoteCopyItem(prepared: any, content: string, meta: ItemMeta): Promise<any> {
  const next = prepared._clone()
  next.setMeta(meta)
  await next.setContent(content)
  return next
}

/** What an upload of a prepared copy established (#1113 D1). */
export type NoteCopyUpload =
  /** The copy exists on the server and is published here; title and content are the server's. */
  | { kind: 'copied'; item: any; revision: string | null; title: string; content: string }
  /** The copy's UID holds a tombstone: it landed and was deleted, so a new copy needs a new UID. */
  | { kind: 'deleted' }
  /** Sent, but not confirmed: the copy may or may not exist. */
  | { kind: 'unconfirmed' }
  /** The server refused the write. */
  | { kind: 'refused' }
  | { kind: 'no-notebook' }

function sdkErrorNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name
}

/**
 * Uploads a prepared copy (#1113 D1). Every call sends a clone of the same item,
 * so a retry carries the same UID at the same revision, which the server answers
 * as a success when it already holds it. The upload is a transaction: a copy that
 * another device changed since it landed gets a 409, never an overwrite, and that
 * 409 counts as copied only once a fresh fetch of the UID finds the copy live,
 * still a note, and readable here. Only a confirmed copy is published to the item
 * cache and the display cache.
 */
export async function uploadNoteCopyItem(collectionUid: string, prepared: any, own: { title: string; content: string }): Promise<NoteCopyUpload> {
  const accountEpoch = getAccountEpoch()
  const { account, collections, accountFingerprint } = useEtebaseStore.getState()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return { kind: 'unconfirmed' }
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
  const collection = resolveCollection(collections, 'notes', collectionUid)
  if (!collection) return { kind: 'no-notebook' }
  const core = await import('@silentsuite/core')
  assertGuard()
  const itemManager = account.getCollectionManager().getItemManager(collection)
  let committed: any
  let fetched = false
  try {
    const clone = prepared._clone()
    // A clone reads as saved at its own revision; the copy goes out as a create, with no etag.
    clone.encryptedItem.lastEtag = null
    await itemManager.transaction([clone])
    assertGuard()
    committed = clone
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
    if (sdkErrorNamed(err, 'PermissionDeniedError')) return { kind: 'refused' }
    if (!sdkErrorNamed(err, 'ConflictError')) {
      logger.warn('[etebase-store] Note copy upload not confirmed', getSafeErrorDetails(err))
      return { kind: 'unconfirmed' }
    }
    try {
      committed = await core.fetchItemFresh(account, collection, prepared.uid)
      assertGuard()
    } catch (fetchErr) {
      if (fetchErr instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
      return { kind: 'unconfirmed' }
    }
    if (!committed) return { kind: 'unconfirmed' }
    if (committed.isDeleted) return { kind: 'deleted' }
    fetched = true
  }
  let { title, content } = own
  const revision = core.savedRevisionOf(committed)
  if (fetched) {
    // The copy landed earlier at a revision other than the one just sent: show the server's text.
    try {
      const meta = committed.getMeta()
      // Another app made it something other than a note: it is not published as one.
      if (!core.isMarkdownNoteItem(meta)) return { kind: 'unconfirmed' }
      const raw = await committed.getContent()
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      title = core.noteFromEtebaseItem(committed.uid, '', meta).title
      content = text
    } catch {
      // Unreadable here, so nothing shows which text the server holds: this tab's text stays held.
      return { kind: 'unconfirmed' }
    }
    assertGuard()
  }
  const state = useEtebaseStore.getState()
  const itemCache = new Map(state.itemCache)
  const itemTypeMap = new Map(state.itemTypeMap)
  const itemCollectionMap = new Map(state.itemCollectionMap)
  itemCache.set(committed.uid, committed)
  itemTypeMap.set(committed.uid, 'notes')
  itemCollectionMap.set(committed.uid, collection.uid)
  useEtebaseStore.setState({ itemCache, itemTypeMap, itemCollectionMap })
  assertGuard()
  return { kind: 'copied', item: committed, revision, title, content }
}

/** #744 §9 editor check: the mounted editor shows exactly the shown note, saved, with nothing in flight. */
export function noteEditorMatches(
  editor: { isClean: () => boolean; chainIdle: () => boolean; base: () => SealedEditingBase },
  note: { title: string; content: string; revision: string | null },
): boolean {
  if (!editor.isClean() || !editor.chainIdle()) return false
  const base = editor.base()
  return base.revision === note.revision && base.title === note.title && base.content === note.content
}

/**
 * #744 §9 bulk clear of a notebook or address book. Only the members shown at
 * the start are considered, each at its paired revision, so a child created
 * later is never swept. A member with custody, an unknown revision, an
 * obligation, a mismatched editor or a draft is protected; every other one is
 * deleted only at its snapshot revision. Local cleanup touches only members
 * that were deleted or queued.
 */
async function clearMembersConditionally(
  type: 'notes' | 'contacts',
  collection: any,
  guard: OfflineQueueAccountGuard,
  accountEpoch: number,
  get: () => EtebaseState,
  set: (partial: Partial<EtebaseState>) => void,
): Promise<number> {
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, get())
  const noteStore = type === 'notes' ? await import('@/app/stores/use-note-store') : null
  const contactStore = type === 'contacts' ? await import('@/app/stores/use-contact-store') : null
  assertGuard()
  // The displayed members and their paired revisions, before any network work.
  const shownNotes = noteStore ? noteStore.useNoteStore.getState().notes.filter((note) => note.notebookId === collection.uid) : []
  const members: { uid: string; revision: string | null }[] = noteStore
    ? shownNotes.map((note) => ({ uid: note.id, revision: note.revision }))
    : contactStore!.useContactStore.getState().contacts
      .filter((contact) => contact.listId === collection.uid)
      .map((contact) => ({ uid: contact.id, revision: contact.revision }))
  const core = await import('@silentsuite/core')
  assertGuard()
  const removed: string[] = []
  let protectedCount = 0
  // The editor period each member was authorized in; later typing keeps the member shown.
  const periods = new Map<string, number | undefined>()
  for (const member of members) {
    assertGuard()
    const outstanding = await readOutstanding({ collectionType: type, itemUid: member.uid }, guard)
    assertGuard()
    let isProtected = outstanding.length > 0 || !knownRevision(member.revision)
    if (!isProtected && noteStore) {
      const editor = noteStore.getMountedNoteEditor(member.uid)
      const shown = shownNotes.find((note) => note.id === member.uid)
      isProtected = Boolean(noteStore.getNoteObligation(member.uid))
        || Boolean(noteStore.getHeldNoteDraft(member.uid))
        || Boolean(editor && (!shown || !noteEditorMatches(editor, { ...shown, revision: member.revision })))
      periods.set(member.uid, editor?.periodGen())
    }
    if (!isProtected && contactStore) isProtected = Boolean(contactStore.useContactStore.getState().contactSaveStates[member.uid])
    const item = get().itemCache.get(member.uid)
    if (isProtected || !item || !knownRevision(member.revision)) {
      protectedCount += 1
      continue
    }
    try {
      const result = await core.deleteItemIfUnchanged(get().account, collection, item, { etagOverride: member.revision, beforeDispatch: assertGuard })
      assertGuard()
      if (result.kind === 'deleted') removed.push(member.uid)
      else protectedCount += 1
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return 0
      if (!isOfflineError(err)) {
        protectedCount += 1
        continue
      }
      const inserted = await insertIfNoOutstanding(
        { type: 'delete', collectionType: type, collectionUid: collection.uid, itemUid: member.uid, expectedEtag: member.revision },
        guard,
      )
      assertGuard()
      if (inserted) removed.push(member.uid)
      else protectedCount += 1
    }
  }
  // Typing or a draft begun on a member while the clear was in flight stays shown (#744).
  const retired = removed.filter((uid) => {
    if (contactStore) return !contactStore.useContactStore.getState().contactSaveStates[uid]
    if (noteStore!.getHeldNoteDraft(uid)) return false
    const editor = noteStore!.getMountedNoteEditor(uid)
    return !editor || (editor.isClean() && editor.periodGen() === periods.get(uid))
  })
  if (retired.length > 0) {
    const uidSet = new Set(retired)
    const itemCache = new Map(get().itemCache)
    const itemTypeMap = new Map(get().itemTypeMap)
    const itemCollectionMap = new Map(get().itemCollectionMap)
    for (const uid of uidSet) {
      itemCache.delete(uid)
      itemTypeMap.delete(uid)
      itemCollectionMap.delete(uid)
    }
    set({ itemCache, itemTypeMap, itemCollectionMap })
    await removeItemsFromDomainStore(type, collection.uid, retired, accountEpoch)
    assertGuard()
  }
  if (protectedCount > 0) {
    showErrorToast(`Deleted ${removed.length} of ${members.length} ${collectionItemNoun(type)}. Please try again to delete the rest.`)
  }
  return removed.length
}

/**
 * #744 §9 collection delete fence for a notebook or address book. Nothing local
 * may be owed for it (queued work, an obligation, an open editor that is not
 * clean and idle, a contact draft), and every live server child must be shown
 * here at its paired revision. The children are listed between two reads of
 * the collection at the same stoken S (two retries), local state is read again,
 * and the tombstone is sent only at S and the main item's fetched revision.
 * Anything unproved refuses; there is no unconditional or offline fallback.
 */
/**
 * Why a proved notebook or address book delete was refused (#1113 D1): this device
 * still owes work on it, or the server holds items or changes this context does not show.
 */
export type CollectionDeleteRefusal = 'unsaved' | 'changed'

async function deleteCollectionIfProved(
  type: 'notes' | 'contacts',
  collectionUid: string,
  get: () => EtebaseState,
): Promise<'deleted' | CollectionDeleteRefusal> {
  const { account, accountFingerprint } = get()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  // Without the account guard nothing owed here can be checked: an error, not a refusal.
  if (!guard) throw new Error('No account guard for a proved collection delete')
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, get())
  const noteStore = type === 'notes' ? await import('@/app/stores/use-note-store') : null
  const contactStore = type === 'contacts' ? await import('@/app/stores/use-contact-store') : null
  const core = await import('@silentsuite/core')
  assertGuard()
  const shownMembers = (): Map<string, string | null> => new Map(noteStore
    ? noteStore.useNoteStore.getState().notes.filter((note) => note.notebookId === collectionUid).map((note) => [note.id, note.revision] as const)
    : contactStore!.useContactStore.getState().contacts.filter((contact) => contact.listId === collectionUid).map((contact) => [contact.id, contact.revision] as const))
  const localWorkOwed = async (members: Map<string, string | null>): Promise<boolean> => {
    const entries = await getQueuedMutations(guard)
    assertGuard()
    if (entries.some((entry) => entry.collectionType === type && entry.collectionUid === collectionUid)) return true
    for (const uid of members.keys()) {
      if (noteStore) {
        const editor = noteStore.getMountedNoteEditor(uid)
        // An open editor must show exactly the shown note, saved and idle, not merely be clean.
        const shown = noteStore.useNoteStore.getState().notes.find((note) => note.id === uid)
        if (noteStore.getNoteObligation(uid) || noteStore.getHeldNoteDraft(uid) || (editor && (!shown || !noteEditorMatches(editor, shown)))) return true
      } else if (contactStore!.useContactStore.getState().contactSaveStates[uid]) {
        return true
      }
    }
    return false
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const members = shownMembers()
    if (await localWorkOwed(members)) return 'unsaved'
    const before = await core.getCollection(account, collectionUid)
    assertGuard()
    const stoken = before.stoken
    if (!stoken || before.isDeleted) return 'changed'
    let pageToken: string | null = null
    for (;;) {
      const page = await core.listItems(account, before, pageToken)
      assertGuard()
      for (const child of page.items) {
        if (child.isDeleted) continue
        if (type === 'notes' && !core.isMarkdownNoteItem(itemMetaOf(child))) return 'changed'
        const revision = members.get(child.uid)
        if (!knownRevision(revision) || core.savedRevisionOf(child) !== revision) return 'changed'
      }
      if (page.done) break
      pageToken = page.stoken
    }
    const after = await core.getCollection(account, collectionUid)
    assertGuard()
    // Something changed while the children were listed: list them again.
    if (after.stoken !== stoken) continue
    if (await localWorkOwed(shownMembers())) return 'unsaved'
    const result = await core.deleteCollectionIfUnchanged(account, after, stoken, { beforeDispatch: assertGuard })
    assertGuard()
    return result.kind === 'deleted' ? 'deleted' : 'changed'
  }
  return 'changed'
}

/** The record a contact edit was made on (#744 §8): its revision (null if unknown) and complete vCard. */
export interface ContactEditingBase {
  revision: string | null
  witness: string
}

interface SealedFavoritePayload {
  v: 1
  kind: 'favorite'
  body: { content: string }
  base: { revision: string | null; digest: string }
  prior: string[]
}

/** Exact validation of an opened sealed favorite payload; anything else is unreadable. */
function parseSealedFavoritePayload(plaintext: string): SealedFavoritePayload | null {
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!hasExactKeys(value, ['v', 'kind', 'body', 'base', 'prior'])) return null
  if (value.v !== 1 || value.kind !== 'favorite') return null
  const { body, base, prior } = value
  if (!hasExactKeys(body, ['content']) || typeof body.content !== 'string') return null
  if (!hasExactKeys(base, ['revision', 'digest'])) return null
  if (base.revision !== null && !(typeof base.revision === 'string' && base.revision.length > 0)) return null
  if (typeof base.digest !== 'string' || !SEALED_DIGEST.test(base.digest)) return null
  if (!Array.isArray(prior) || prior.length > 32) return null
  if (!prior.every((digest: unknown) => typeof digest === 'string' && SEALED_DIGEST.test(digest))) return null
  return value as SealedFavoritePayload
}

/**
 * A contact record is proved only by its complete vCard text (#744): the parsed
 * model drops fields it does not keep, so text that differs anywhere is a
 * different record, and a proof that cannot show equality refuses.
 */
function sameContact(a: string, b: string): boolean {
  return a === b
}

async function contactMatchesWitness(item: any, witness: string, assertGuard: () => void): Promise<boolean> {
  if (!item || item.isDeleted) return false
  const raw = await item.getContent()
  assertGuard()
  return sameContact(typeof raw === 'string' ? raw : new TextDecoder().decode(raw), witness)
}

/**
 * Favorite custody admission (#744 §8): the accepted vCard and the proof of the
 * record it was toggled on go into one sealed payload. Admission needs the
 * record's own revision and binds it to the item observed at the commit.
 */
async function queueSealedFavoriteUpdate(
  itemUid: string,
  collectionUid: string,
  content: string,
  base: ContactEditingBase,
  guard: OfflineQueueAccountGuard,
  accountEpoch: number,
  getState: () => EtebaseState,
): Promise<boolean> {
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, getState())
  if (!knownRevision(base.revision)) return false
  const admissionRevision = base.revision
  await cacheEnsureFingerprint(guard.accountFingerprint, accountEpoch)
  assertGuard()
  if (!await cacheEnsureEncryptedEnvelope(accountEpoch)) return false
  assertGuard()
  const core = await import('@silentsuite/core')
  assertGuard()
  const payload: SealedFavoritePayload = {
    v: 1,
    kind: 'favorite',
    body: { content },
    base: { revision: admissionRevision, digest: await cacheSealedPayloadDigest(['favorite', base.witness]) },
    prior: [],
  }
  assertGuard()
  const sealed = await cacheSealQueuePayload(JSON.stringify(payload), `${guard.accountFingerprint}|contacts|${itemUid}`, accountEpoch)
  assertGuard()
  if (!sealed) return false
  const admit = () => {
    if (!isCurrentAccountEpoch(accountEpoch)) return false
    const state = getState()
    if (!state.account || state.accountFingerprint !== guard.accountFingerprint) return false
    return core.savedRevisionOf(state.itemCache.get(itemUid)) === admissionRevision
  }
  const inserted = await insertIfNoOutstanding(
    { type: 'sealed-update', collectionType: 'contacts', collectionUid, itemUid, sealed, rev: 1 },
    guard,
    admit,
  )
  assertGuard()
  if (inserted) logger.warn(`[etebase-store] Queued sealed favorite for contacts/${itemUid}`)
  return inserted
}

/**
 * Favorite succession: a favorite may replace the contact's sealed record only
 * if that record is its single outstanding custody, opens as a favorite, and
 * holds the vCard this toggle was made on. The original base proof is kept.
 */
async function replaceFavoriteStubWithDescendant(
  outstanding: QueueEntry[],
  itemUid: string,
  content: string,
  base: ContactEditingBase,
  guard: OfflineQueueAccountGuard,
  accountEpoch: number,
  getState: () => EtebaseState,
): Promise<boolean> {
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, getState())
  const stub = outstanding[0]
  if (outstanding.length !== 1 || !stub || stub.type !== 'sealed-update' || !stub.sealed || typeof stub.rev !== 'number') return false
  const associatedData = `${guard.accountFingerprint}|contacts|${itemUid}`
  const opened = await cacheOpenQueuePayload(stub.sealed, associatedData, accountEpoch)
  assertGuard()
  if (opened.kind !== 'opened') return false
  const payload = parseSealedFavoritePayload(opened.plaintext)
  if (!payload) return false
  if (!sameContact(payload.body.content, base.witness)) return false
  const replacedDigest = await cacheSealedPayloadDigest(['favorite', payload.body.content])
  assertGuard()
  const successor: SealedFavoritePayload = {
    v: 1,
    kind: 'favorite',
    body: { content },
    base: payload.base,
    prior: [...payload.prior, replacedDigest].slice(-32),
  }
  const sealed = await cacheSealQueuePayload(JSON.stringify(successor), associatedData, accountEpoch)
  assertGuard()
  if (!sealed) return false
  const replaced = await replaceStub({ collectionType: 'contacts', itemUid }, { id: stub.id, rev: stub.rev }, sealed, guard)
  assertGuard()
  return replaced
}

/**
 * A contact save at its captured record base (#744 §8). Outstanding custody
 * refuses any ordinary or photo edit before anything is sent; only a favorite
 * may succeed its own sealed record. The save dispatches at the record's
 * revision through a clone of the item cached at dispatch, and on a conflict or
 * an unknown revision rebinds once to a fresh live copy equal to the witness.
 * A known conflict is never admitted offline; only a favorite is ever sealed.
 */
async function updateContactAtCapturedBase(
  itemUid: string,
  content: string,
  options: UpdateItemOptions,
  get: () => EtebaseState,
  set: (partial: Partial<EtebaseState>) => void,
): Promise<'remote' | 'queued' | false> {
  const accountEpoch = getAccountEpoch()
  const { account, collections, itemCollectionMap, accountFingerprint } = get()
  const guard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
  if (!guard) return false
  const refuse = (): false => {
    if (isCurrentAccountEpoch(accountEpoch)) options.onRefused?.()
    return false
  }
  const base = options.contactBase
  if (!base) return refuse()
  const favorite = options.sealIntent === 'favorite'
  const knownCollectionUid = itemCollectionMap.get(itemUid) ?? options.collectionUid
  if (!knownCollectionUid) return refuse()
  const collection = resolveCollection(collections, 'contacts', knownCollectionUid)
  const assertGuard = () => assertOfflineQueueAccountGuard(guard, get())
  const isBoundary = (err: unknown) => !isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError
  let outstanding: QueueEntry[]
  try {
    outstanding = await readOutstanding({ collectionType: 'contacts', itemUid }, guard)
    assertGuard()
  } catch (err) {
    if (isBoundary(err)) return false
    return refuse()
  }
  if (outstanding.length > 0) {
    if (!favorite) return refuse()
    try {
      return await replaceFavoriteStubWithDescendant(outstanding, itemUid, content, base, guard, accountEpoch, get) ? 'queued' : refuse()
    } catch (err) {
      if (isBoundary(err)) return false
      logger.warn('[etebase-store] Sealed favorite succession failed', getSafeErrorDetails(err))
      return refuse()
    }
  }
  if (!collection) return refuse()
  let sawConflict = false
  try {
    const core = await import('@silentsuite/core')
    assertGuard()
    const dispatch = (source: any, etag: string) => core.updateItemIfUnchanged(account, collection, source, content, undefined, {
      etagOverride: etag,
      beforeDispatch: assertGuard,
    })
    const publish = async (saved: { item: any; etag: string }): Promise<'remote'> => {
      assertGuard()
      const nextCache = new Map(get().itemCache)
      nextCache.set(itemUid, saved.item)
      set({ itemCache: nextCache })
      options.onSaved?.(saved.etag)
      return 'remote'
    }
    // The item cached at dispatch, written only at the record's own revision.
    const cached = get().itemCache.get(itemUid)
    if (cached && knownRevision(base.revision)) {
      const first = await dispatch(cached, base.revision)
      assertGuard()
      if (first.kind === 'saved') return await publish(first)
      sawConflict = true
    }
    // One rebind: a fresh, live copy that still equals the witness.
    const fresh = await core.fetchItemFresh(account, collection, itemUid)
    assertGuard()
    if (!fresh || !await contactMatchesWitness(fresh, base.witness, assertGuard)) return refuse()
    const freshRevision = core.savedRevisionOf(fresh)
    if (!freshRevision) return refuse()
    const second = await dispatch(fresh, freshRevision)
    assertGuard()
    if (second.kind === 'saved') return await publish(second)
    return refuse()
  } catch (err) {
    if (isBoundary(err)) return false
    if (isOfflineError(err) && favorite && !sawConflict) {
      try {
        return await queueSealedFavoriteUpdate(itemUid, collection.uid, content, base, guard, accountEpoch, get) ? 'queued' : refuse()
      } catch (queueErr) {
        if (isBoundary(queueErr)) return false
        logger.warn('[etebase-store] Sealed favorite admission failed', getSafeErrorDetails(queueErr))
        return refuse()
      }
    }
    if (!isOfflineError(err)) console.error('[etebase-store] Failed to update contacts item', getSafeErrorDetails(err))
    return refuse()
  }
}

/**
 * Sealed note custody admission (#744). The accepted text and the proof of
 * the editing base it was typed on go into one AES-GCM payload in the offline
 * queue, bound to the record identity. The queue record is the custody; the
 * display cache is written only afterwards and is never authority.
 */
async function queueSealedNoteUpdate(
  type: CollectionTypeKey,
  itemUid: string,
  collectionUid: string,
  content: string,
  meta: ItemMeta | undefined,
  options: { sealIntent?: SealIntent; base?: SealedEditingBase; admissionRevision?: string | null },
  offlineQueueGuard: OfflineQueueAccountGuard,
  accountEpoch: number,
  getState: () => EtebaseState,
): Promise<'queued' | false> {
  const base = options.base
  if (type !== 'notes' || options.sealIntent !== 'note' || !base) return false
  // Custody needs the base text's proof; a digest-only base is never admitted offline.
  if (base.digestOnly !== undefined) return false
  if (typeof meta?.name !== 'string' || typeof meta.mtime !== 'number' || !Number.isFinite(meta.mtime)) return false
  await cacheEnsureFingerprint(offlineQueueGuard.accountFingerprint, accountEpoch)
  assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  if (!await cacheEnsureEncryptedEnvelope(accountEpoch)) return false
  assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  const core = await import('@silentsuite/core')
  assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  // The same title normalization every note producer applies.
  const baseTitle = core.noteFromEtebaseItem(itemUid, '', { name: base.title }).title
  // r*: the captured base revision, or the revision of a fresh read proved equal
  // to the base. Never a cached or fetched revision that was not proved.
  const admissionRevision = options.admissionRevision !== undefined
    ? options.admissionRevision
    : (knownRevision(base.revision) ? base.revision : null)
  const payload = {
    v: 1,
    kind: 'note',
    body: { content, meta: { name: meta.name, mtime: meta.mtime } },
    base: {
      revision: admissionRevision,
      digest: await cacheSealedPayloadDigest(['note', baseTitle, base.content]),
    },
    prior: [] as string[],
  }
  assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  const sealed = await cacheSealQueuePayload(
    JSON.stringify(payload),
    `${offlineQueueGuard.accountFingerprint}|${type}|${itemUid}`,
    accountEpoch,
  )
  assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  if (!sealed) return false
  // Admission binds the observation current at the commit, not a pre-await snapshot.
  const observed = getState().itemCache.get(itemUid)
  if (!admissionRevision && observed !== undefined) {
    const matches = await noteMatchesBase(core, observed, itemUid, base, () => assertOfflineQueueAccountGuard(offlineQueueGuard, getState()))
    if (!matches) return false
  }
  const admit = () => {
    if (!isCurrentAccountEpoch(accountEpoch)) return false
    const state = getState()
    if (!state.account || state.accountFingerprint !== offlineQueueGuard.accountFingerprint) return false
    const current = state.itemCache.get(itemUid)
    return admissionRevision ? core.savedRevisionOf(current) === admissionRevision : current === observed
  }
  const inserted = await insertIfNoOutstanding(
    { type: 'sealed-update', collectionType: type, collectionUid, itemUid, sealed, rev: 1 },
    offlineQueueGuard,
    admit,
  )
  assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  if (!inserted) return false
  // Custody is durable; a failed display write does not revoke acceptance.
  try {
    const cacheContent = await toCacheContent(type, itemUid, collectionUid, content, meta)
    assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
    await cachePutItem({
      itemUid,
      collectionType: type,
      collectionUid,
      content: cacheContent,
      lastModified: Date.now(),
    }, accountEpoch)
  } catch (displayErr) {
    // Only a boundary this tab crossed revokes it; a display record another tab cleared does not.
    if (displayErr instanceof AccountBoundaryChangedError && !isCurrentAccountEpoch(accountEpoch)) throw displayErr
    logger.warn('[etebase-store] Display write after sealed custody failed', getSafeErrorDetails(displayErr))
  }
  assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
  logger.warn(`[etebase-store] Queued sealed update for ${type}/${itemUid}`)
  return 'queued'
}

/**
 * Queues an update for replay when it cannot be applied now. With
 * `persistEncryptedOfflineContent` the body goes to the encrypted local cache
 * and the queue entry stays content free; otherwise the content rides in the
 * entry. Used both when the server is unreachable and when no item object is
 * in memory, for example after a reload while offline.
 */
async function queueOfflineUpdate(
  type: CollectionTypeKey,
  itemUid: string,
  collectionUid: string,
  content: string,
  meta: ItemMeta | undefined,
  options: {
    suppressErrorToast?: boolean
    persistEncryptedOfflineContent?: boolean
    sealIntent?: SealIntent
    base?: SealedEditingBase
    admissionRevision?: string | null
  } | undefined,
  offlineQueueGuard: OfflineQueueAccountGuard,
  accountEpoch: number,
  getState: () => EtebaseState,
): Promise<'queued' | false> {
  try {
    assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
    if (options?.sealIntent) {
      return await queueSealedNoteUpdate(type, itemUid, collectionUid, content, meta, options, offlineQueueGuard, accountEpoch, getState)
    }
    if (options?.persistEncryptedOfflineContent) {
      await cacheEnsureFingerprint(offlineQueueGuard.accountFingerprint, accountEpoch)
      assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
      // The encrypted envelope commit validates the account fingerprint
      // meta record. Seed that record first so a cold, flag-disabled
      // cache can safely persist this content-free replay payload.
      const encryptedEnvelopeReady = await cacheEnsureEncryptedEnvelope(accountEpoch)
      assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
      if (!encryptedEnvelopeReady) return false
      const cacheContent = await toCacheContent(type, itemUid, collectionUid, content, meta)
      assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
      await cachePutItem({
        itemUid,
        collectionType: type,
        collectionUid,
        content: cacheContent,
        lastModified: Date.now(),
      }, accountEpoch)
      assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
      const cachedItems = await cacheGetItemsByType(type)
      assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
      const persisted = cachedItems.find((cached) => cached.itemUid === itemUid)
      if (persisted?.content !== cacheContent || persisted.collectionUid !== collectionUid) {
        return false
      }
      assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
      await enqueue({ type: 'update', collectionType: type, collectionUid, itemUid }, offlineQueueGuard)
    } else {
      await enqueue({ type: 'update', collectionType: type, collectionUid, content, itemUid }, offlineQueueGuard)
    }
    assertOfflineQueueAccountGuard(offlineQueueGuard, getState())
    logger.warn(`[etebase-store] Queued update for ${type}/${itemUid}`)
    return 'queued'
  } catch (queueErr) {
    if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return false
    console.error('[etebase-store] Failed to enqueue update', getSafeErrorDetails(queueErr))
    if (!options?.suppressErrorToast) {
      showErrorToast(`Failed to save ${itemSaveNoun(type)} for offline sync. Please try again.`)
    }
    return false
  }
}

function resolveCollection(
  collections: Record<CollectionTypeKey, any[]>,
  type: CollectionTypeKey,
  collectionUid?: string,
): any | null {
  const typedCollections = collections[type] ?? []
  if (collectionUid && collectionUid !== 'default' && collectionUid !== 'all') {
    const match = typedCollections.find((collection) => collection.uid === collectionUid)
    if (match) return match
    logger.warn(`[etebase-store] Unknown ${type} collection ${collectionUid}`)
    return null
  }
  return typedCollections[0] ?? null
}

const SHARING_PUBLIC_KEY_LENGTH = 32

export type PendingCollectionInvite = Readonly<{
  type: CollectionTypeKey
  collectionUid: string
  username: string
  accessLevel: CollectionAccessLevel
  fingerprint: string
}>

export type IncomingInvitationView = Readonly<{
  uid: string
  senderName: string | null
  accessLevel: number
  senderFingerprint: string | null
}>

interface SharingBoundary {
  accountEpoch: number
  account: any
  accountFingerprint: string | null
}

interface PendingInviteBinding extends SharingBoundary {
  collection: any
  pubkey: Uint8Array
}

interface IncomingInvitationBinding extends SharingBoundary {
  invitation: any
  confirmedFromPubkey: Uint8Array | null
  used: boolean
}

// Key bytes and SDK objects stay module-private; React only receives frozen tokens.
const pendingInviteBindings = new WeakMap<PendingCollectionInvite, PendingInviteBinding>()
const incomingInvitationBindings = new WeakMap<IncomingInvitationView, IncomingInvitationBinding>()

function copySharingPublicKey(value: unknown): Uint8Array | null {
  if (!(value instanceof Uint8Array) || value.length !== SHARING_PUBLIC_KEY_LENGTH) return null
  return value.slice()
}

/** Sharing targets must match an exact uid; unlike resolveCollection there is no default fallback. */
function findExactSharingCollection(
  collections: Record<CollectionTypeKey, any[]>,
  type: CollectionTypeKey,
  collectionUid: string,
): any | null {
  if (!collectionUid || collectionUid === 'default' || collectionUid === 'all') return null
  return (collections[type] ?? []).find((collection) => collection.uid === collectionUid) ?? null
}

function isCurrentSharingBoundary(
  boundary: SharingBoundary,
  state: { account: any; accountFingerprint: string | null },
): boolean {
  return isCurrentAccountEpoch(boundary.accountEpoch)
    && state.account === boundary.account
    && state.accountFingerprint === boundary.accountFingerprint
}

function getCollectionName(collection: any, fallback: string): string {
  try {
    const meta = collection?.getMeta?.()
    return meta?.name || fallback
  } catch {
    return fallback
  }
}

function getCollectionColor(collection: any): string | undefined {
  try {
    return collection?.getMeta?.()?.color
  } catch {
    return undefined
  }
}

function getCollectionAccessLevel(collection: any): number | undefined {
  return typeof collection?.accessLevel === 'number' ? collection.accessLevel : undefined
}

async function hydrateListStores(
  collections: Record<CollectionTypeKey, any[]>,
  accountEpoch = getAccountEpoch(),
): Promise<void> {
  const [calendarListStore, taskListStore, contactListStore, notebookStore] = await Promise.all([
    import('@/app/stores/use-calendar-list-store'),
    import('@/app/stores/use-task-list-store'),
    import('@/app/stores/use-contact-list-store'),
    import('@/app/stores/use-notebook-store'),
  ])
  assertCurrentAccountEpoch(accountEpoch)

  // Mark active Birthdays calendars (from their encrypted content marker) before they
  // are listed, so a managed calendar is never shown as editable. Never throws.
  const fingerprint = useEtebaseStore.getState().accountFingerprint
  if (fingerprint) {
    await projectBirthdayMarkers({
      epoch: accountEpoch,
      fingerprint,
      isCurrent: () => isCurrentAccountEpoch(accountEpoch) && useEtebaseStore.getState().accountFingerprint === fingerprint,
    }, collections.calendar)
    assertCurrentAccountEpoch(accountEpoch)
  }

  calendarListStore.useCalendarListStore.getState().replaceCalendarsFromRemote(
    collections.calendar.map((collection, index) => ({
      id: collection.uid,
      name: getCollectionName(collection, index === 0 ? 'Personal' : `Calendar ${index + 1}`),
      color: getCollectionColor(collection) || calendarListStore.DEFAULT_CALENDAR_COLORS[index % calendarListStore.DEFAULT_CALENDAR_COLORS.length],
      visible: true,
      accessLevel: getCollectionAccessLevel(collection),
    })),
  )
  taskListStore.useTaskListStore.getState().replaceListsFromRemote(
    collections.tasks.map((collection, index) => ({
      id: collection.uid,
      name: getCollectionName(collection, index === 0 ? 'My Tasks' : `Task List ${index + 1}`),
      color: getCollectionColor(collection) || taskListStore.DEFAULT_TASK_LIST_COLORS[index % taskListStore.DEFAULT_TASK_LIST_COLORS.length],
      visible: true,
      accessLevel: getCollectionAccessLevel(collection),
    })),
  )
  contactListStore.useContactListStore.getState().replaceListsFromRemote(
    collections.contacts.map((collection, index) => ({
      id: collection.uid,
      name: getCollectionName(collection, index === 0 ? 'My Contacts' : `Contacts ${index + 1}`),
      color: getCollectionColor(collection) || contactListStore.DEFAULT_CONTACT_LIST_COLORS[index % contactListStore.DEFAULT_CONTACT_LIST_COLORS.length],
      visible: true,
      accessLevel: getCollectionAccessLevel(collection),
    })),
  )
  notebookStore.useNotebookStore.getState().replaceListsFromRemote(
    collections.notes.map((collection, index) => ({
      id: collection.uid,
      name: getCollectionName(collection, index === 0 ? 'Personal Notes' : `Notebook ${index + 1}`),
      color: getCollectionColor(collection) || notebookStore.DEFAULT_NOTEBOOK_COLORS[index % notebookStore.DEFAULT_NOTEBOOK_COLORS.length],
      visible: true,
      accessLevel: getCollectionAccessLevel(collection),
    })),
  )
  // A complete collection refresh (including the last address book going away) may change birthdays.
  requestBirthdayReconcile(accountEpoch)
}

async function removeItemsFromDomainStore(type: CollectionTypeKey, collectionUid: string, itemUids?: string[], accountEpoch?: number): Promise<number> {
  if (type === 'preferences') return 0
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)

  const itemUidSet = itemUids ? new Set(itemUids) : null

  if (type === 'calendar') {
    const { useCalendarStore } = await import('@/app/stores/use-calendar-store')
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    let removed = 0
    useCalendarStore.setState((state) => {
      const events = state.events.filter((event) => {
        const shouldRemove = itemUidSet
          ? itemUidSet.has(event.id)
          : (event.calendarId ?? 'default') === collectionUid
        if (shouldRemove) removed++
        return !shouldRemove
      })
      const selectedEventId = state.selectedEventId && (itemUidSet
        ? itemUidSet.has(state.selectedEventId)
        : state.events.some((event) => event.id === state.selectedEventId && (event.calendarId ?? 'default') === collectionUid))
        ? null
        : state.selectedEventId
      return { events, selectedEventId }
    })
    return removed
  }
  if (type === 'tasks') {
    const { useTaskStore } = await import('@/app/stores/use-task-store')
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    let removed = 0
    useTaskStore.setState((state) => ({
      tasks: state.tasks.filter((task) => {
        const shouldRemove = itemUidSet
          ? itemUidSet.has(task.id)
          : (task.listId ?? 'default') === collectionUid
        if (shouldRemove) removed++
        return !shouldRemove
      }),
    }))
    return removed
  }
  if (type === 'notes') {
    const { useNoteStore, hasUnsavedNoteText, getNoteObligation } = await import('@/app/stores/use-note-store')
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    let removed = 0
    useNoteStore.setState((state) => ({
      notes: state.notes.filter((note) => {
        // Every removal keeps a note with unsaved typing, held text (#1113 D1) or an owed
        // reconciliation, read here at the removal itself, after any earlier await (#744).
        const owned = hasUnsavedNoteText(note.id) || Boolean(getNoteObligation(note.id))
        const shouldRemove = !owned && (itemUidSet
          ? itemUidSet.has(note.id)
          : (note.notebookId ?? 'default') === collectionUid)
        if (shouldRemove) removed++
        return !shouldRemove
      }),
    }))
    return removed
  }
  const { useContactStore, hasContactFieldDraft } = await import('@/app/stores/use-contact-store')
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
  let removed = 0
  useContactStore.setState((state) => ({
    contacts: state.contacts.filter((contact) => {
      // Every removal keeps a contact with a draft or unsaved field typing, read here at the
      // removal itself, after any earlier await (#744).
      const owned = Boolean(state.contactSaveStates?.[contact.id]) || hasContactFieldDraft(contact.id)
      const shouldRemove = !owned && (itemUidSet
        ? itemUidSet.has(contact.id)
        : (contact.listId ?? 'default') === collectionUid)
      if (shouldRemove) removed++
      return !shouldRemove
    }),
  }))
  return removed
}

async function removeQueuedMutationsForCollection(
  type: CollectionTypeKey,
  collectionUid: string,
  includeDeletes: boolean,
  accountEpoch: number,
  accountFingerprint: string | null,
): Promise<number> {
  if (!accountFingerprint) return 0
  try {
    const guard = { accountEpoch, accountFingerprint: accountFingerprint }
    assertCurrentAccountEpoch(accountEpoch)
    const entries = await getQueuedMutations(guard)
    assertCurrentAccountEpoch(accountEpoch)
    const matching = entries.filter((entry) => (
      entry.collectionType === type
      && entry.collectionUid === collectionUid
      && (includeDeletes || entry.type !== 'delete')
      // Sealed custody and legacy entries (#744) are never pruned with their collection.
      && !entry.sealed
      && !isLegacyEntry(entry)
    ))
    for (const entry of matching) {
      assertCurrentAccountEpoch(accountEpoch)
      await removeQueuedMutation(entry.id, guard)
      assertCurrentAccountEpoch(accountEpoch)
    }
    return matching.length
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
    logger.warn(`[etebase-store] Failed to prune queued mutations for ${type}/${collectionUid}`, err)
    return 0
  }
}

function collectionItemNoun(type: CollectionTypeKey): string {
  if (type === 'calendar') return 'events'
  if (type === 'tasks') return 'tasks'
  if (type === 'notes') return 'notes'
  if (type === 'preferences') return 'preferences'
  return 'contacts'
}

function collectionDisplayName(type: CollectionTypeKey): string {
  if (type === 'calendar') return 'calendar'
  if (type === 'tasks') return 'task list'
  if (type === 'contacts') return 'address book'
  if (type === 'notes') return 'notebook'
  return 'preferences'
}

/**
 * Why `createItem` neither created nor queued an item: the offline queue refused
 * it ('queue-refused', as it does for a note's text), or the request or the queue
 * failed another way ('failed').
 */
export type CreateItemRefusal = 'queue-refused' | 'failed'

function itemSaveNoun(type: CollectionTypeKey): string {
  if (type === 'calendar') return 'event'
  if (type === 'tasks') return 'task'
  if (type === 'contacts') return 'contact'
  if (type === 'notes') return 'note'
  return 'preferences'
}

function isDomainLoadedForBulkMutation(domainLoadState: DomainLoadState, type: CollectionTypeKey): boolean {
  return domainLoadState[type] === 'loaded'
}

// ── File contact import uploads (opt-in) ──

/** Attempts per batch for a file import, with 1 s, 2 s and 4 s backoff between them. */
export const FILE_IMPORT_ATTEMPTS = 4
/** No single file-import request (upload, collection read or page) may wait longer. */
export const FILE_IMPORT_TIMEOUT_MS = 60_000

export type FileImportOutcome = 'saved' | 'notSent' | 'refused' | 'uncertain'
export interface FileImportResult {
  outcome: FileImportOutcome
  /** The SDK item created or replayed for this content, null if none was created. */
  item: any | null
}
export interface FileImportUpload {
  /** SDK items from an earlier uncertain upload, replayed as they are, by content index. */
  replay?: ReadonlyMap<number, any>
  onProgress?: (saved: number, total: number) => void
  /** Receives one result per content index once the upload has settled. */
  onSettled?: (results: FileImportResult[]) => void
}

export class FileImportTimeoutError extends Error {
  constructor() {
    super('Request timed out')
    this.name = 'FileImportTimeoutError'
  }
}

/** Rejects after `ms`; the underlying request is left to finish on its own. */
function withFileImportTimeout<T>(request: Promise<T>, ms = FILE_IMPORT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FileImportTimeoutError()), ms)
  })
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer))
}

/** A refusal the server made in full: its batch transaction did not commit, and resending
 * the same request cannot succeed. Everything else (network, timeout, 5xx, 408, 429,
 * unknown) may have committed and is retried. */
function isDefinitiveRefusal(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'UnauthorizedError' || name === 'PermissionDeniedError' || name === 'ConflictError' || name === 'NotFoundError') return true
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function createItemsForFileImport(
  get: () => EtebaseState,
  set: (partial: Partial<EtebaseState>) => void,
  type: CollectionTypeKey,
  contents: { content: string; tempId: string }[],
  collectionUid: string | undefined,
  onCommitted: ((tempId: string, item: any) => void) | undefined,
  upload: FileImportUpload,
): Promise<(string | null)[]> {
  const accountEpoch = getAccountEpoch()
  const { account, collections, syncEngine } = get()
  // A replayed item already had an attempt whose outcome is unknown.
  const ambiguous = contents.map((_, index) => upload.replay?.has(index) === true)
  const results: FileImportResult[] = contents.map((_, index) => ({
    outcome: ambiguous[index] ? 'uncertain' : 'notSent',
    item: upload.replay?.get(index) ?? null,
  }))
  const settle = () => upload.onSettled?.(results)
  const collection = account ? resolveCollection(collections, type, collectionUid) : null
  if (!account || !collection) {
    settle()
    return contents.map(() => null)
  }
  const noun = type === 'calendar' ? 'events' : type === 'tasks' ? 'tasks' : type === 'contacts' ? 'contacts' : 'preferences'
  syncEngine?.pause()
  try {
    const itemManager = account.getCollectionManager().getItemManager(collection)
    const items: any[] = []
    for (let i = 0; i < contents.length; i++) {
      const item = results[i]!.item ?? await itemManager.create({}, contents[i]!.content)
      assertCurrentAccountEpoch(accountEpoch)
      results[i]!.item = item
      items.push(item)
      if (i > 0 && i % 25 === 0) {
        await sleep(0)
        assertCurrentAccountEpoch(accountEpoch)
      }
    }

    let saved = 0
    let failure: unknown = null
    upload.onProgress?.(0, items.length)
    batches: for (let start = 0; start < items.length; start += 20) {
      const positions = items.slice(start, start + 20).map((_, offset) => start + offset)
      for (let attempt = 1; ; attempt++) {
        try {
          assertCurrentAccountEpoch(accountEpoch)
          await withFileImportTimeout(itemManager.batch(positions.map((position) => items[position])))
          assertCurrentAccountEpoch(accountEpoch)
          for (const position of positions) results[position]!.outcome = 'saved'
          saved += positions.length
          upload.onProgress?.(saved, items.length)
          break
        } catch (err) {
          if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
          if (isDefinitiveRefusal(err)) {
            for (const position of positions) results[position]!.outcome = ambiguous[position] ? 'uncertain' : 'refused'
            failure = err
            break batches
          }
          for (const position of positions) {
            ambiguous[position] = true
            results[position]!.outcome = 'uncertain'
          }
          if (attempt >= FILE_IMPORT_ATTEMPTS) {
            failure = err
            break batches
          }
          logger.warn(`[etebase-store] File import batch ${start / 20 + 1} failed (attempt ${attempt}/${FILE_IMPORT_ATTEMPTS}), retrying`)
          await sleep(1000 * 2 ** (attempt - 1))
          assertCurrentAccountEpoch(accountEpoch)
        }
      }
    }

    // Publish exactly what the server acknowledged, with the content that was uploaded.
    const itemCache = new Map(get().itemCache)
    const itemTypeMap = new Map(get().itemTypeMap)
    const itemCollectionMap = new Map(get().itemCollectionMap)
    const uids: (string | null)[] = []
    for (let i = 0; i < items.length; i++) {
      if (results[i]!.outcome !== 'saved') {
        uids.push(null)
        continue
      }
      const item = items[i]
      itemCache.set(item.uid, item)
      itemTypeMap.set(item.uid, type)
      itemCollectionMap.set(item.uid, collection.uid)
      uids.push(item.uid)
    }
    assertCurrentAccountEpoch(accountEpoch)
    set({ itemCache, itemTypeMap, itemCollectionMap })
    for (let i = 0; i < items.length; i++) {
      assertCurrentAccountEpoch(accountEpoch)
      if (results[i]!.outcome === 'saved') onCommitted?.(contents[i]!.tempId, items[i])
    }
    if (failure) {
      console.error('[etebase-store] File import failed', getSafeErrorDetails(failure))
      showErrorToast(saved > 0 ? `Imported ${saved} of ${items.length} ${noun}. Please try again to import the rest.` : `Failed to import ${noun}. Please try again.`)
    }
    settle()
    return uids
  } catch (err) {
    settle()
    if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return contents.map(() => null)
    console.error(`[etebase-store] Failed to file-import ${type} items`, getSafeErrorDetails(err))
    showErrorToast(`Failed to import ${noun}. Please try again.`)
    return contents.map(() => null)
  } finally {
    if (isCurrentAccountEpoch(accountEpoch) && get().syncEngine === syncEngine) syncEngine?.resume()
  }
}

interface EtebaseState {
  // The live Account object (null until session restored)
  account: any | null
  // Stable account public-key fingerprint for cross-device verification.
  accountFingerprint: string | null
  // Collection references keyed by type; each type may have multiple collections.
  collections: Record<CollectionTypeKey, any[]>
  // Item cache: itemUid -> Etebase.Item (needed for update/delete which require the Item object)
  itemCache: Map<string, any>
  // Tracks which collection type each item belongs to
  itemTypeMap: Map<string, CollectionTypeKey>
  // Tracks the concrete collection UID each item belongs to for update/delete routing
  itemCollectionMap: Map<string, string>
  // Whether initial data load from server is complete
  isInitialized: boolean
  // True when the encrypted session could not be restored on this browser
  // (missing/invalid/corrupt local session) and re-unlocking would help.
  // Not set for offline errors or post-restore listing/sync failures.
  restoreBlocked: boolean
  // Per-domain post-restore load outcome. 'loaded' means the app has a
  // complete server view of the domain; 'failed'/'unknown' means bulk
  // destructive operations must not trust the in-memory view.
  domainLoadState: DomainLoadState
  // SyncEngine reference
  syncEngine: any | null
}

interface EtebaseActions {
  /**
   * Restore Etebase session from localStorage, initialize collections,
   * load all items into data stores, and start the SyncEngine.
   *
   * Visible domains are enumerated one at a time; options.onDomainLoaded is
   * invoked after each reaches a terminal state so callers can paint a fast
   * domain (calendar) before slower domains finish.
   */
  initialize: (options?: InitializeOptions) => Promise<void>

  /**
   * Create an item in the given collection type.
   * Returns the item UID.
   * @param tempId - optional temp ID from the domain store, used for offline queue mapping
   */
  createItem: (
    type: CollectionTypeKey,
    content: string,
    tempId?: string,
    collectionUid?: string,
    meta?: ItemMeta,
    /** Receives the committed SDK item synchronously, after it is published and before the cache write (#744). */
    onCommitted?: (item: any) => void,
    /** Opt-in for a caller that words its own failure message; other callers keep the default toasts. */
    options?: {
      /** Skip the generic "Please try again." toasts when the item was neither created nor queued. */
      suppressErrorToast?: boolean
      /** Called once when the create request or the queue failed. Not called for a missing session or collection, an account change, or a queued create. */
      onRefused?: (reason: CreateItemRefusal) => void
      /** Called once when the create was queued for replay instead of created now. The call still resolves null. */
      onQueued?: () => void
    },
  ) => Promise<string | null>

  /** Execute a queued mutation remotely without ordinary offline fallback/requeue behavior. */
  replayQueuedMutation: (entry: QueueEntry, guard: OfflineQueueAccountGuard, checkpoint?: ReplayCheckpoint) => Promise<ConfirmedRemoteMutation>

  /**
   * Create a new Etebase collection for the given type.
   */
  createCollection: (type: CollectionTypeKey, name: string, color?: string) => Promise<string | null>

  /**
   * Delete an Etebase collection and remove its cached items locally.
   */
  /**
   * `onRefused` (#1113 D1, notes and contacts): a refused proved delete reports its
   * reason there instead of the generic toast, so the caller can say why.
   */
  deleteCollection: (
    type: CollectionTypeKey,
    collectionUid: string,
    options?: { onRefused?: (reason: CollectionDeleteRefusal) => void },
  ) => Promise<boolean>

  /**
   * Update Etebase collection metadata and refresh local list stores.
   */
  updateCollectionMeta: (type: CollectionTypeKey, collectionUid: string, updates: CollectionMetaUpdates) => Promise<boolean>

  /**
   * Re-list remote collections and reconcile local state with active collections.
   */
  reconcileCollections: () => Promise<void>

  /**
   * List pending incoming sharing invitations as key-free views bound to private list-time snapshots.
   */
  listIncomingInvitations: () => Promise<IncomingInvitationView[]>

  /**
   * List pending outgoing sharing invitations for the current account.
   */
  listOutgoingInvitations: () => Promise<any[]>

  /**
   * Cancel an outgoing sharing invitation before it is accepted.
   */
  cancelOutgoingInvitation: (invitation: any) => Promise<boolean>

  /**
   * Accept the list-time snapshot behind a view after the user confirmed its displayed sender fingerprint,
   * then reconcile collections so the shared collection appears. Single-use.
   */
  acceptInvitation: (invitation: IncomingInvitationView, displayedFingerprint: string) => Promise<boolean>

  /**
   * Reject an incoming sharing invitation. Single-use.
   */
  rejectInvitation: (invitation: IncomingInvitationView) => Promise<boolean>

  /**
   * Fetch the recipient's public key once and return a frozen token carrying its fingerprint for comparison.
   * Nothing is sent until confirmCollectionInvite.
   */
  prepareCollectionInvite: (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => Promise<PendingCollectionInvite | null>

  /**
   * Send a prepared invite with the exact key captured at prepare time. Single-use.
   */
  confirmCollectionInvite: (pending: PendingCollectionInvite) => Promise<boolean>

  /**
   * Drop a prepared invite without sending it.
   */
  discardCollectionInvite: (pending: PendingCollectionInvite) => void

  /**
   * List members for a collection.
   */
  listCollectionMembers: (type: CollectionTypeKey, collectionUid: string) => Promise<any[]>

  /**
   * Remove a member from a collection.
   */
  removeCollectionMember: (type: CollectionTypeKey, collectionUid: string, username: string) => Promise<boolean>

  /**
   * Leave a shared collection as the current account.
   */
  leaveCollection: (type: CollectionTypeKey, collectionUid: string) => Promise<boolean>

  /**
   * Change a member's access level.
   */
  modifyCollectionMemberAccess: (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => Promise<boolean>

  /**
   * Delete every item inside a collection while keeping the collection itself.
   */
  deleteItemsInCollection: (type: CollectionTypeKey, collectionUid: string) => Promise<number>

  /**
   * Create multiple items in a single batch upload.
   * Returns an array of item UIDs (null for any that failed).
   */
  createItemsBatch: (
    type: CollectionTypeKey,
    contents: { content: string; tempId: string }[],
    collectionUid?: string,
    /** Receives each acknowledged SDK item with its temp id, after it is published (#744). */
    onCommitted?: (tempId: string, item: any) => void,
    /** File contact import only: bounded requests, retry policy, progress, per-item outcomes. */
    options?: { fileImport?: FileImportUpload },
  ) => Promise<(string | null)[]>

  /** The concrete collection uid an alias such as 'default' resolves to, or null. */
  resolveCollectionUid: (type: CollectionTypeKey, collectionUid?: string) => string | null

  /**
   * vCard UIDs of every item in one concrete collection, read from the server with a
   * bounded wait per request. Read-only: no store or cache writes, no cached fallback.
   * Null on any error, timeout, unreadable item, or a changed account.
   */
  readCollectionVCardUids: (type: CollectionTypeKey, collectionUid: string) => Promise<Set<string> | null>

  /**
   * Update an existing item by UID.
   */
  updateItem: (
    type: CollectionTypeKey,
    itemUid: string,
    content: string,
    options?: {
      suppressErrorToast?: boolean
      persistEncryptedOfflineContent?: boolean
      meta?: ItemMeta
      /**
       * Owning collection for an item that is not in memory, such as one known
       * only from the local cache after a reload while offline. The edit is then
       * queued by UID and applied when the item can be fetched.
       */
      collectionUid?: string
      /** The only operations that may be sealed into offline custody (#744). */
      sealIntent?: SealIntent
      /** The editing base the content was typed on; required with `sealIntent`. */
      base?: SealedEditingBase
      /**
       * Called with the saved etag right after a conditional save is published; a note save
       * also passes the revision its write replaced, or null when nothing was written.
       */
      onSaved?: (etag: string, replaced?: string | null) => void
      /**
       * Called when the save is refused because reconciliation is unproved; a note
       * save passes 'changed' when the note proved to have moved on (#1113 D1).
       */
      onRefused?: (reason?: 'changed') => void
      /** The note owes a reconciliation proof: write only through a proved fresh copy, never offline (#744 §7). */
      obligated?: boolean
      /** Called when the save gate observes outstanding custody for this note (#744 T1). */
      onCustodyObserved?: () => void
      /** A contact save's captured record base (#744 §8); contacts save only through it. */
      contactBase?: ContactEditingBase
    },
  ) => Promise<'remote' | 'queued' | false>

  /**
   * Move an existing item to another concrete collection by recreating it there.
   * Returns the new item UID, or the original UID if the target is unchanged.
   */
  moveItem: (
    type: CollectionTypeKey,
    itemUid: string,
    content: string,
    targetCollectionUid: string,
    sourceCollectionUid?: string,
    meta?: ItemMeta,
    /**
     * #744 §9: remove the source only at `sourceRevision`. On a conflict the copy is
     * taken back; offline, the source delete is admitted only conditionally.
     */
    options?: { sourceRevision?: string; offlineAllowed?: boolean },
  ) => Promise<string | null>

  /**
   * Delete an item by UID.
   */
  /** `collectionUid` names the owner when the item is not in memory; the delete is then queued by UID. */
  deleteItem: (
    type: CollectionTypeKey,
    itemUid: string,
    options?: {
      collectionUid?: string
      /** #744 §9: delete only at `expectedRevision`; a conflict or an unknown revision refuses. */
      conditional?: boolean
      expectedRevision?: string | null
      /** Synchronous check repeated inside the offline admission transaction. */
      admit?: () => boolean
      /** False when the delete may never be admitted offline (an obligated note). */
      offlineAllowed?: boolean
    },
  ) => Promise<'remote' | 'queued' | false>

  /**
   * Fetch all items from the local cache for a collection type.
   */
  fetchAllItems: (type: CollectionTypeKey, accountEpoch?: number) => Promise<CachedContentItem[]>

  /**
   * Re-fetch all items from the Etebase server for a collection type.
   * Updates the local cache and returns fresh content.
   * This is what the sync change handler should call.
   * `report.unreadable` counts server items left out because their content could not be read.
   */
  refreshCollection: (type: CollectionTypeKey, collectionUid?: string, report?: { unreadable: number }) => Promise<CachedContentItem[]>

  /**
   * Clean up on logout -- stop sync engine, clear all state.
   * Returns the account epoch this teardown produced (not one observed after
   * re-entrant callbacks); throws EtebaseTeardownError carrying it on failure.
   */
  destroy: () => number

  /**
   * Register a handler for sync change events from the SyncEngine.
   * Returns an unsubscribe function.
   */
  onSyncChange: (handler: (event: SyncChangeEvent) => void) => (() => void) | null

  /**
   * Register a handler for sync status changes.
   */
  onStatusChange: (handler: (status: string) => void) => (() => void) | null
}

export const useEtebaseStore = create<EtebaseState & EtebaseActions>((set, get) => ({
  account: null,
  accountFingerprint: null,
  collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
  itemCache: new Map(),
  itemTypeMap: new Map(),
  itemCollectionMap: new Map(),
  isInitialized: false,
  restoreBlocked: false,
  domainLoadState: unknownDomainLoadState(),
  syncEngine: null,

  initialize: async (options?: InitializeOptions) => {
    const accountEpoch = getAccountEpoch()
    const serverUrl = getServerUrl()
    const diagnostics = new RestoreDiagnosticsRecorder({
      source: 'restore',
      etebaseServerUrl: serverUrl,
      billingApiUrl: BILLING_API_URL,
    })
    // Clear any stale blocked state from a prior attempt before re-trying.
    set({ restoreBlocked: false })
    // Read before the session, so a logout elsewhere during the restore is never adopted.
    const logoutGenerationAtStart = readLogoutGeneration()

    try {
      diagnostics.startPhase('sessionRead')
      const savedSession = await secureGet('etebase_session')
      diagnostics.completePhase('sessionRead', {
        session: classifySessionPersistence(savedSession),
      })
      if (!savedSession) {
        diagnostics.skipPhase('restoreSession')
        diagnostics.persist()
        // Authenticated (initialize only runs under ProtectedRoute) but no local
        // vault to unlock -- re-entering credentials re-persists the session.
        assertCurrentAccountEpoch(accountEpoch)
        set({ restoreBlocked: true })
        logger.debug('[etebase-store] No saved session, restore blocked')
        return
      }

      // Dynamic import to avoid SSR issues with etebase WASM
      const core = await import('@silentsuite/core')

      // 1. Restore the Account
      logger.debug('[etebase-store] Restoring Etebase session...')
      diagnostics.startPhase('restoreSession')
      const account = await core.restoreSession(serverUrl, savedSession)
      const accountFingerprint = core.getAccountFingerprint(account)
      diagnostics.completePhase('restoreSession')
      assertCurrentAccountEpoch(accountEpoch)
      set({ account, accountFingerprint })
      establishLogoutGeneration(logoutGenerationAtStart)
      logger.debug('[etebase-store] Session restored')
      // Learn a login name changed elsewhere (hosted only; never blocks the restore).
      void import('@/app/lib/login-email-change').then((m) => m.syncLoginIdentity()).catch(() => undefined)

      // Local-cache fingerprint check: if a different account previously
      // hydrated this browser, wipe before reseeding. Belt-and-braces against
      // the Android-style stale-cache contamination bug.
      //
      // The encrypted envelope is restored on every session: offline edits keep
      // their replay payload in that envelope (the queue entries themselves are
      // content-free), and it must still be readable after a reload.
      try {
        await cacheEnsureFingerprint(accountFingerprint, accountEpoch)
        assertCurrentAccountEpoch(accountEpoch)
        await cacheEnsureEncryptedEnvelope(accountEpoch)
        assertCurrentAccountEpoch(accountEpoch)
      } catch (err) {
        if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) {
          throw new AccountBoundaryChangedError()
        }
        logger.warn('[etebase-store] Cache fingerprint check failed', err)
      }

      // 2. Discover existing collections. Only core domains get automatic defaults;
      // the first Notes notebook is created by the explicit Experimental opt-in.
      diagnostics.startPhase('ensureCollections')
      let collections: Record<CollectionTypeKey, any[]>
      try {
        collections = await ensureCollectionsForAccount(account, core, accountEpoch)
      } catch (err) {
        if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) {
          throw new AccountBoundaryChangedError()
        }
        // The session restored fine; only discovery failed (offline or server).
        // Report every visible domain as failed through the per-domain contract
        // so the existing Retry path can recover, without publishing any partial
        // discovery or touching cached data and pending local work.
        diagnostics.failActivePhase(err)
        diagnostics.persist()
        logger.warn('[etebase-store] Collection discovery failed', getSafeErrorDetails(err))
        pendingSyncEngineStartEpoch = accountEpoch
        const failedState: Partial<DomainLoadState> = {}
        for (const [key] of COLLECTION_DEFINITIONS) failedState[key] = 'failed'
        set((state) => ({
          domainLoadState: { ...state.domainLoadState, ...failedState },
          isInitialized: true,
          // A refused token needs a new sign-in; any other failure can be retried.
          restoreBlocked: core.isUnauthorizedError(err),
        }))
        for (const [key] of COLLECTION_DEFINITIONS) {
          await options?.onDomainLoaded?.({
            type: key,
            status: 'failed',
            itemCount: 0,
            pageCount: 0,
            collectionCount: get().collections[key].length,
          })
          assertCurrentAccountEpoch(accountEpoch)
        }
        return
      }
      assertCurrentAccountEpoch(accountEpoch)
      diagnostics.completePhase('ensureCollections', {
        collectionCount: COLLECTION_DEFINITIONS.reduce((count, [key]) => count + collections[key].length, 0),
      })

      assertCurrentAccountEpoch(accountEpoch)
      set({ collections })
      diagnostics.startPhase('hydrateLists')
      await hydrateListStores(collections, accountEpoch)
      assertCurrentAccountEpoch(accountEpoch)
      diagnostics.completePhase('hydrateLists')

      // 3. Load items from each visible collection into the cache, one domain
      // at a time. After each domain reaches a terminal state we publish that
      // domain into the current live maps and notify the caller, so a fast
      // domain (calendar comes first in COLLECTION_DEFINITIONS) can paint
      // before slower domains finish enumerating without later stale snapshots
      // overwriting user mutations made during that exposed window.
      let totalLoadedItemCount = 0

      const domainLoadState = unknownDomainLoadState()

      for (const [key] of COLLECTION_DEFINITIONS) {
        const phase = `listItems:${key}` as const
        diagnostics.startPhase(phase)
        const typedCollections = collections[key]
        let itemCount = 0
        let pageCount = 0
        let status: InitialDomainLoadStatus
        const loadedMaps = {
          itemCache: new Map<string, any>(),
          itemTypeMap: new Map<string, CollectionTypeKey>(),
          itemCollectionMap: new Map<string, string>(),
        }

        try {
          const counts = await loadInitialDomainItems(core, account, key, typedCollections, {
            itemCache: loadedMaps.itemCache,
            itemTypeMap: loadedMaps.itemTypeMap,
            itemCollectionMap: loadedMaps.itemCollectionMap,
          }, accountEpoch)
          itemCount = counts.itemCount
          pageCount = counts.pageCount
          totalLoadedItemCount += itemCount
          domainLoadState[key] = 'loaded'
          status = 'loaded'
          diagnostics.completePhase(phase, {
            collectionType: key,
            collectionCount: typedCollections.length,
            itemCount,
            pageCount,
          })
        } catch (err) {
          if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) {
            throw new AccountBoundaryChangedError()
          }
          domainLoadState[key] = 'failed'
          status = 'failed'
          diagnostics.failActivePhase(err)
          logger.warn(`[etebase-store] Failed to load ${key} items`, getSafeErrorDetails(err))
        }

        // Publish incrementally using the current live maps. Do not overwrite
        // previously painted domains with the snapshot from earlier awaits.
        assertCurrentAccountEpoch(accountEpoch)
        set((state) => buildInitialDomainPublish(state, key, loadedMaps, domainLoadState, status))

        await options?.onDomainLoaded?.({
          type: key,
          status,
          itemCount,
          pageCount,
          collectionCount: typedCollections.length,
        })
        assertCurrentAccountEpoch(accountEpoch)
      }

      logger.debug(`[etebase-store] Loaded ${totalLoadedItemCount} items into cache`)

      // 4. Start SyncEngine
      const engine = await startSyncEngine(core, account, serverUrl, collections, accountEpoch, diagnostics)
      if (!engine) return
      // The boundary can change after the helper's own check; teardown never
      // saw this unpublished engine, so stop it here instead of publishing.
      if (!isCurrentAccountEpoch(accountEpoch)) {
        engine.stop()
        return
      }
      set({ syncEngine: engine, isInitialized: true })
      diagnostics.persist()
      logger.debug('[etebase-store] SyncEngine started')
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch)) return
      if (err instanceof AccountBoundaryChangedError) return
      diagnostics.failActivePhase(err)
      diagnostics.persist()
      console.error('[etebase-store] Initialization failed', getSafeErrorDetails(err))
      // Don't clear the session -- the user might be offline
      // They can retry on next page load
      // Only a session-restore failure (missing/invalid/corrupt local session)
      // is recoverable by re-unlocking. Offline errors and post-restore
      // listing/sync failures are NOT unlock cases (Slice 3 territory).
      const failedPhase = diagnostics.snapshot().failedPhase
      const isSessionRestoreFailure =
        !isOfflineError(err) && (failedPhase === 'sessionRead' || failedPhase === 'restoreSession')
      set({ isInitialized: true, restoreBlocked: isSessionRestoreFailure })
      if (!isOfflineError(err)) {
        showErrorToast('Failed to restore session. Please try signing in again.')
      }
    }
  },

  createCollection: async (type: CollectionTypeKey, name: string, color?: string) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, syncEngine } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot create collection: no account')
      return null
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      const colType = keyToCollectionType(type)
      const collection = await core.createCollection(account, colType, { name, color, mtime: Date.now() })
      assertCurrentAccountEpoch(accountEpoch)
      const newCollections = {
        ...collections,
        [type]: [...collections[type], collection],
      }
      syncEngine?.trackCollection(colType as CollectionType, collection.uid)
      set({ collections: newCollections })
      await hydrateListStores(newCollections, accountEpoch)
      return collection.uid
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return null
      console.error(`[etebase-store] Failed to create ${type} collection`, getSafeErrorDetails(err))
      showErrorToast(`Failed to create ${collectionDisplayName(type)}. Please try again.`)
      return null
    }
  },

  deleteCollection: async (type: CollectionTypeKey, collectionUid: string, options) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, domainLoadState, syncEngine, accountFingerprint } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot delete ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }
    if (!isDomainLoadedForBulkMutation(domainLoadState, type)) {
      showErrorToast(incompleteLoadMessage())
      logger.warn(`[etebase-store] Refusing to delete ${type} collection before domain load completes`)
      return false
    }
    if (collections[type].length <= 1) {
      showErrorToast(`Create another ${collectionDisplayName(type)} before deleting this one.`)
      return false
    }
    if (!canDeleteCollection(collection)) {
      showErrorToast(`Only an admin of this shared ${collectionDisplayName(type)} can delete it.`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      if (type === 'notes' || type === 'contacts') {
        // #744 §9: only a proved, unchanged collection with nothing owed here is tombstoned.
        const deleted = await deleteCollectionIfProved(type, collection.uid, get)
        assertCurrentAccountEpoch(accountEpoch)
        if (deleted !== 'deleted') {
          if (options?.onRefused) options.onRefused(deleted)
          else showErrorToast(`Failed to delete ${collectionDisplayName(type)}. Please try again.`)
          return false
        }
      } else {
        await core.deleteCollection(account, collection)
      }
      assertCurrentAccountEpoch(accountEpoch)

      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)
      for (const [uid, mappedCollectionUid] of newItemCollectionMap.entries()) {
        if (mappedCollectionUid === collection.uid) {
          newItemCache.delete(uid)
          newItemTypeMap.delete(uid)
          newItemCollectionMap.delete(uid)
        }
      }

      const newCollections = {
        ...get().collections,
        [type]: get().collections[type].filter((existing) => existing.uid !== collection.uid),
      }
      syncEngine?.untrackCollection(collection.uid)
      set({
        collections: newCollections,
        itemCache: newItemCache,
        itemTypeMap: newItemTypeMap,
        itemCollectionMap: newItemCollectionMap,
      })
      assertCurrentAccountEpoch(accountEpoch)
      await removeQueuedMutationsForCollection(type, collection.uid, true, accountEpoch, accountFingerprint)
      assertCurrentAccountEpoch(accountEpoch)
      await removeItemsFromDomainStore(type, collection.uid, undefined, accountEpoch)
      assertCurrentAccountEpoch(accountEpoch)
      await hydrateListStores(newCollections, accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error(`[etebase-store] Failed to delete ${type} collection`, getSafeErrorDetails(err))
      showErrorToast(`Failed to delete ${collectionDisplayName(type)}. Please try again.`)
      return false
    }
  },

  updateCollectionMeta: async (type: CollectionTypeKey, collectionUid: string, updates: CollectionMetaUpdates) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot update ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      const currentMeta = collection?.getMeta?.() ?? {}
      const updatedMeta: CollectionMetaUpdates = {}
      if (updates.name !== undefined) updatedMeta.name = updates.name
      else if (currentMeta.name !== undefined) updatedMeta.name = currentMeta.name
      if (updates.description !== undefined) updatedMeta.description = updates.description
      else if (currentMeta.description !== undefined) updatedMeta.description = currentMeta.description
      if (updates.color !== undefined) updatedMeta.color = updates.color
      else if (currentMeta.color !== undefined) updatedMeta.color = currentMeta.color
      updatedMeta.mtime = Date.now()
      const updatedCollection = await core.updateCollectionMeta(account, collection, updatedMeta)
      assertCurrentAccountEpoch(accountEpoch)
      const newCollections = {
        ...get().collections,
        [type]: get().collections[type].map((existing) =>
          existing.uid === collection.uid ? updatedCollection : existing,
        ),
      }
      set({ collections: newCollections })
      await hydrateListStores(newCollections, accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error(`[etebase-store] Failed to update ${type} collection`, getSafeErrorDetails(err))
      showErrorToast(`Failed to update ${collectionDisplayName(type)}. Please try again.`)
      return false
    }
  },

  reconcileCollections: async () => {
    const accountEpoch = getAccountEpoch()
    const { account, syncEngine, accountFingerprint } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot reconcile collections: no account')
      return
    }

    syncEngine?.pause?.()
    try {
      const core = await import('@silentsuite/core')
      const previousCollections = get().collections
      const activeCollections = await ensureCollectionsForAccount(account, core, accountEpoch)
      assertCurrentAccountEpoch(accountEpoch)
      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)
      const cleanupPromises: Promise<unknown>[] = []
      let removedCollectionCount = 0

      for (const [type, colType] of COLLECTION_DEFINITIONS) {
        const activeUids = new Set(activeCollections[type].map((collection) => collection.uid))
        const previousUids = new Set(previousCollections[type].map((collection) => collection.uid))
        const removedUids = new Set<string>()

        for (const collection of previousCollections[type]) {
          if (!activeUids.has(collection.uid)) removedUids.add(collection.uid)
        }

        for (const [itemUid, mappedCollectionUid] of newItemCollectionMap.entries()) {
          if (newItemTypeMap.get(itemUid) === type && !activeUids.has(mappedCollectionUid)) {
            removedUids.add(mappedCollectionUid)
          }
        }

        for (const collectionUid of removedUids) {
          assertCurrentAccountEpoch(accountEpoch)
          removedCollectionCount++
          syncEngine?.untrackCollection(collectionUid)
          for (const [itemUid, mappedCollectionUid] of Array.from(newItemCollectionMap.entries())) {
            if (mappedCollectionUid !== collectionUid) continue
            newItemCache.delete(itemUid)
            newItemTypeMap.delete(itemUid)
            newItemCollectionMap.delete(itemUid)
          }
          cleanupPromises.push(removeQueuedMutationsForCollection(type, collectionUid, true, accountEpoch, accountFingerprint))
          cleanupPromises.push(removeItemsFromDomainStore(type, collectionUid, undefined, accountEpoch))
        }

        for (const collection of activeCollections[type]) {
          if (!previousUids.has(collection.uid)) {
            await trackCollectionWithSyncEngine(syncEngine, colType, collection.uid, accountEpoch)
          }
        }
      }

      // A visible type with no collections is completely discovered; types with
      // collections reach 'loaded' through their item refresh.
      const emptyDomainState: Partial<DomainLoadState> = {}
      for (const [type] of COLLECTION_DEFINITIONS) {
        if (activeCollections[type].length === 0) emptyDomainState[type] = 'loaded'
      }

      assertCurrentAccountEpoch(accountEpoch)
      set((state) => ({
        collections: activeCollections,
        itemCache: newItemCache,
        itemTypeMap: newItemTypeMap,
        itemCollectionMap: newItemCollectionMap,
        domainLoadState: { ...state.domainLoadState, ...emptyDomainState },
      }))
      await Promise.all(cleanupPromises)
      assertCurrentAccountEpoch(accountEpoch)
      await hydrateListStores(activeCollections, accountEpoch)

      // Initial discovery failed before the SyncEngine started: start it once
      // now that discovery succeeded for the same account.
      if (pendingSyncEngineStartEpoch === accountEpoch && !get().syncEngine) {
        pendingSyncEngineStartEpoch = null
        try {
          const engine = await startSyncEngine(core, account, getServerUrl(), activeCollections, accountEpoch)
          if (!engine) throw new AccountBoundaryChangedError()
          if (!isCurrentAccountEpoch(accountEpoch)) {
            engine.stop()
            throw new AccountBoundaryChangedError()
          }
          set({ syncEngine: engine })
        } catch (err) {
          if (isCurrentAccountEpoch(accountEpoch) && !get().syncEngine) pendingSyncEngineStartEpoch = accountEpoch
          throw err
        }
      }
      logger.debug(`[etebase-store] Reconciled collections (${removedCollectionCount} removed)`)
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return
      console.error('[etebase-store] Failed to reconcile collections', getSafeErrorDetails(err))
      throw err
    } finally {
      if (isCurrentAccountEpoch(accountEpoch) && get().syncEngine === syncEngine) syncEngine?.resume?.()
    }
  },

  listIncomingInvitations: async () => {
    const accountEpoch = getAccountEpoch()
    const { account, accountFingerprint } = get()
    if (!account) return []
    const boundary: SharingBoundary = { accountEpoch, account, accountFingerprint }

    try {
      const core = await import('@silentsuite/core')
      const invitations = await core.listIncomingInvitations(account)
      if (!isCurrentSharingBoundary(boundary, get())) throw new AccountBoundaryChangedError()
      return invitations.map((invitation: any) => {
        let snapshot: any = null
        let confirmedFromPubkey: Uint8Array | null = null
        let senderFingerprint: string | null = null
        try {
          snapshot = core.snapshotInvitation(invitation)
          confirmedFromPubkey = copySharingPublicKey(snapshot?.fromPubkey)
          senderFingerprint = confirmedFromPubkey ? core.getPublicKeyFingerprint(confirmedFromPubkey) : null
        } catch {
          senderFingerprint = null
        }
        if (!snapshot || !confirmedFromPubkey || !senderFingerprint) {
          // Malformed invitations stay rejectable but can never be accepted.
          snapshot = null
          confirmedFromPubkey = null
          senderFingerprint = null
        }
        const source = snapshot ?? invitation
        const fromUsername = typeof source?.fromUsername === 'string' ? source.fromUsername.trim() : ''
        const view: IncomingInvitationView = Object.freeze({
          uid: typeof source?.uid === 'string' ? source.uid : '',
          senderName: fromUsername || null,
          accessLevel: typeof source?.accessLevel === 'number' ? source.accessLevel : -1,
          senderFingerprint,
        })
        incomingInvitationBindings.set(view, {
          ...boundary,
          invitation: snapshot ?? { ...invitation },
          confirmedFromPubkey,
          used: false,
        })
        return view
      })
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return []
      console.error('[etebase-store] Failed to list incoming invitations', getSafeErrorDetails(err))
      showErrorToast('Failed to load sharing invitations. Please try again.')
      return []
    }
  },

  listOutgoingInvitations: async () => {
    const accountEpoch = getAccountEpoch()
    const { account } = get()
    if (!account) return []

    try {
      const core = await import('@silentsuite/core')
      const invitations = await core.listOutgoingInvitations(account)
      assertCurrentAccountEpoch(accountEpoch)
      return invitations
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return []
      console.error('[etebase-store] Failed to list outgoing invitations', getSafeErrorDetails(err))
      showErrorToast('Failed to load sent sharing invitations. Please try again.')
      return []
    }
  },

  cancelOutgoingInvitation: async (invitation: any) => {
    const accountEpoch = getAccountEpoch()
    const { account } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot cancel outgoing invitation: no account')
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      await core.cancelOutgoingInvitation(account, invitation)
      assertCurrentAccountEpoch(accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error('[etebase-store] Failed to cancel outgoing invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to cancel sharing invitation. Please try again.')
      return false
    }
  },

  acceptInvitation: async (view: IncomingInvitationView, displayedFingerprint: string) => {
    const binding = incomingInvitationBindings.get(view)
    if (
      !binding || binding.used || !binding.confirmedFromPubkey
      || !view.senderFingerprint || displayedFingerprint !== view.senderFingerprint
    ) {
      logger.warn('[etebase-store] Cannot accept invitation: confirmation is missing, mismatched, or already used')
      return false
    }
    binding.used = true
    const { accountEpoch, account } = binding
    const confirmedFromPubkey = binding.confirmedFromPubkey

    try {
      const core = await import('@silentsuite/core')
      if (core.getPublicKeyFingerprint(confirmedFromPubkey) !== view.senderFingerprint) {
        throw new Error('Sender fingerprint changed before accept')
      }
      if (!isCurrentSharingBoundary(binding, get())) throw new AccountBoundaryChangedError()
      await core.acceptInvitation(account, binding.invitation, confirmedFromPubkey)
      assertCurrentAccountEpoch(accountEpoch)
      await get().reconcileCollections()
      assertCurrentAccountEpoch(accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error('[etebase-store] Failed to accept invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to accept sharing invitation. Please try again.')
      return false
    }
  },

  rejectInvitation: async (view: IncomingInvitationView) => {
    const binding = incomingInvitationBindings.get(view)
    if (!binding || binding.used) {
      logger.warn('[etebase-store] Cannot reject invitation: unknown or already used')
      return false
    }
    binding.used = true
    const { accountEpoch, account } = binding

    try {
      const core = await import('@silentsuite/core')
      if (!isCurrentSharingBoundary(binding, get())) throw new AccountBoundaryChangedError()
      await core.rejectInvitation(account, binding.invitation)
      assertCurrentAccountEpoch(accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error('[etebase-store] Failed to reject invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to reject sharing invitation. Please try again.')
      return false
    }
  },

  prepareCollectionInvite: async (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const collection = findExactSharingCollection(collections, type, collectionUid)
    const recipient = username.trim()
    if (!account || !collection || !recipient) {
      logger.warn(`[etebase-store] Cannot prepare ${type} invite: missing account, exact collection, or username`)
      return null
    }
    const boundary: SharingBoundary = { accountEpoch, account, accountFingerprint }
    const isCurrentTarget = () => isCurrentSharingBoundary(boundary, get())
      && findExactSharingCollection(get().collections, type, collectionUid) === collection

    try {
      const core = await import('@silentsuite/core')
      if (!isCurrentTarget()) throw new AccountBoundaryChangedError()
      const profile = await core.fetchUserProfile(account, recipient)
      if (!isCurrentTarget()) throw new AccountBoundaryChangedError()
      const pubkey = copySharingPublicKey(profile?.pubkey)
      if (!pubkey) throw new Error('Recipient sharing key is missing or malformed')
      const fingerprint = core.getPublicKeyFingerprint(pubkey)
      const pending: PendingCollectionInvite = Object.freeze({ type, collectionUid, username: recipient, accessLevel, fingerprint })
      pendingInviteBindings.set(pending, { ...boundary, collection, pubkey })
      return pending
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return null
      console.error('[etebase-store] Failed to fetch sharing profile', getSafeErrorDetails(err))
      showErrorToast('Could not fetch the security fingerprint for that account. Please verify the username and try again.')
      return null
    }
  },

  confirmCollectionInvite: async (pending: PendingCollectionInvite) => {
    const binding = pendingInviteBindings.get(pending)
    // Single-use: the token is spent before any await, so a second confirm can never dispatch.
    pendingInviteBindings.delete(pending)
    if (!binding) {
      logger.warn('[etebase-store] Cannot send invite: confirmation is unknown, discarded, or already used')
      return false
    }
    const { accountEpoch, account, collection, pubkey } = binding

    try {
      const core = await import('@silentsuite/core')
      if (core.getPublicKeyFingerprint(pubkey) !== pending.fingerprint) {
        throw new Error('Recipient fingerprint changed before invite')
      }
      const state = get()
      if (
        !isCurrentSharingBoundary(binding, state)
        || findExactSharingCollection(state.collections, pending.type, pending.collectionUid) !== collection
      ) {
        throw new AccountBoundaryChangedError()
      }
      await core.inviteToCollection(account, collection, pending.username, pubkey, pending.accessLevel)
      assertCurrentAccountEpoch(accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error('[etebase-store] Failed to create sharing invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to create sharing invitation. Invite again to fetch and compare a fresh fingerprint.')
      return false
    }
  },

  discardCollectionInvite: (pending: PendingCollectionInvite) => {
    pendingInviteBindings.delete(pending)
  },

  listCollectionMembers: async (type: CollectionTypeKey, collectionUid: string) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) return []

    try {
      const core = await import('@silentsuite/core')
      const members = await core.listCollectionMembers(account, collection)
      assertCurrentAccountEpoch(accountEpoch)
      return members
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return []
      console.error('[etebase-store] Failed to list collection members', getSafeErrorDetails(err))
      showErrorToast('Failed to load collection members. Please try again.')
      return []
    }
  },

  removeCollectionMember: async (type: CollectionTypeKey, collectionUid: string, username: string) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot remove member from ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      await core.removeCollectionMember(account, collection, username)
      assertCurrentAccountEpoch(accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error('[etebase-store] Failed to remove collection member', getSafeErrorDetails(err))
      showErrorToast('Failed to remove collection member. Please try again.')
      return false
    }
  },

  leaveCollection: async (type: CollectionTypeKey, collectionUid: string) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot leave ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      await core.leaveCollection(account, collection)
      assertCurrentAccountEpoch(accountEpoch)
      await get().reconcileCollections()
      assertCurrentAccountEpoch(accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error('[etebase-store] Failed to leave collection', getSafeErrorDetails(err))
      showErrorToast('Failed to leave shared collection. Please try again.')
      return false
    }
  },

  modifyCollectionMemberAccess: async (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot modify member access for ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      await core.modifyCollectionMemberAccess(account, collection, username, accessLevel)
      assertCurrentAccountEpoch(accountEpoch)
      return true
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      console.error('[etebase-store] Failed to change collection member access', getSafeErrorDetails(err))
      showErrorToast('Failed to update collection member access. Please try again.')
      return false
    }
  },

  deleteItemsInCollection: async (type: CollectionTypeKey, collectionUid: string) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, domainLoadState, itemCache, itemCollectionMap, accountFingerprint } = get()
    const offlineQueueGuard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
    if (!offlineQueueGuard) return 0
    const collection = resolveCollection(collections, type, collectionUid)
    if (!collection) {
      logger.warn(`[etebase-store] Cannot clear ${type} collection ${collectionUid}: missing account or collection`)
      return 0
    }
    if (!isDomainLoadedForBulkMutation(domainLoadState, type)) {
      showErrorToast(incompleteLoadMessage())
      logger.warn(`[etebase-store] Refusing to clear ${type} collection before domain load completes`)
      return 0
    }
    // Notes and contacts clear only proved, unprotected snapshot members (#744 §9).
    if (type === 'notes' || type === 'contacts') {
      try {
        return await clearMembersConditionally(type, collection, offlineQueueGuard, accountEpoch, get, set)
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return 0
        throw err
      }
    }

    const removeCachedItems = (uids: string[]) => {
      if (uids.length === 0) return
      assertCurrentAccountEpoch(accountEpoch)
      const uidSet = new Set(uids)
      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)
      for (const uid of uidSet) {
        newItemCache.delete(uid)
        newItemTypeMap.delete(uid)
        newItemCollectionMap.delete(uid)
      }
      assertCurrentAccountEpoch(accountEpoch)
      set({ itemCache: newItemCache, itemTypeMap: newItemTypeMap, itemCollectionMap: newItemCollectionMap })
    }

    const itemEntries = Array.from(itemCollectionMap.entries())
      .filter(([, mappedCollectionUid]) => mappedCollectionUid === collection.uid)
      .map(([uid]) => ({ uid, item: itemCache.get(uid) }))
      .filter((entry): entry is { uid: string; item: any } => Boolean(entry.item))

    if (itemEntries.length === 0) {
      try {
        await removeQueuedMutationsForCollection(type, collection.uid, true, accountEpoch, accountFingerprint)
        return await removeItemsFromDomainStore(type, collection.uid, undefined, accountEpoch)
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return 0
        throw err
      }
    }

    const successfulUids: string[] = []

    try {
      const collectionManager = account.getCollectionManager()
      const itemManager = collectionManager.getItemManager(collection)
      const BATCH_SIZE = 20

      for (let i = 0; i < itemEntries.length; i += BATCH_SIZE) {
        const batchEntries = itemEntries.slice(i, i + BATCH_SIZE)
        const batchItems = batchEntries.map(({ item }) => item)
        for (const item of batchItems) item.delete()
        assertCurrentAccountEpoch(accountEpoch)
        await itemManager.batch(batchItems)
        assertCurrentAccountEpoch(accountEpoch)
        successfulUids.push(...batchEntries.map(({ uid }) => uid))
      }

      removeCachedItems(successfulUids)
      await removeQueuedMutationsForCollection(type, collection.uid, true, accountEpoch, accountFingerprint)
      const removedLocal = await removeItemsFromDomainStore(type, collection.uid, undefined, accountEpoch)
      assertCurrentAccountEpoch(accountEpoch)
      return Math.max(successfulUids.length, removedLocal)
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return 0
      try {
        if (isOfflineError(err)) {
          assertCurrentAccountEpoch(accountEpoch)
          await removeQueuedMutationsForCollection(type, collection.uid, false, accountEpoch, accountFingerprint)
          const alreadyDeleted = new Set(successfulUids)
          for (const { uid } of itemEntries) {
            if (alreadyDeleted.has(uid)) continue
            try {
              assertOfflineQueueAccountGuard(offlineQueueGuard, get())
              await enqueue({ type: 'delete', collectionType: type, collectionUid: collection.uid, itemUid: uid }, offlineQueueGuard)
              assertOfflineQueueAccountGuard(offlineQueueGuard, get())
            } catch (queueErr) {
              if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return 0
              console.error('[etebase-store] Failed to enqueue collection item delete', getSafeErrorDetails(queueErr))
            }
          }
          removeCachedItems(itemEntries.map(({ uid }) => uid))
          const removedLocal = await removeItemsFromDomainStore(type, collection.uid, undefined, accountEpoch)
          assertCurrentAccountEpoch(accountEpoch)
          return Math.max(itemEntries.length, removedLocal)
        }

        console.error(`[etebase-store] Failed to clear ${type} collection`, getSafeErrorDetails(err))
        if (successfulUids.length > 0) {
          removeCachedItems(successfulUids)
          await removeItemsFromDomainStore(type, collection.uid, successfulUids, accountEpoch)
          assertCurrentAccountEpoch(accountEpoch)
          showErrorToast(`Deleted ${successfulUids.length} of ${itemEntries.length} ${collectionItemNoun(type)}. Please try again to delete the rest.`)
        } else {
          showErrorToast(`Failed to delete ${collectionItemNoun(type)}. Please try again.`)
        }
        return 0
      } catch (cleanupErr) {
        if (!isCurrentAccountEpoch(accountEpoch) || cleanupErr instanceof AccountBoundaryChangedError) return 0
        throw cleanupErr
      }
    }
  },

  replayQueuedMutation: async (entry, guard, checkpoint = async () => {}) => {
    assertOfflineQueueAccountGuard(guard, get())
    const { account, collections, itemCache, itemCollectionMap } = get()
    if (!account) throw new ReplayNotConfirmedError('Replay requires an active Etebase account')

    const requireCollection = (uid: string | undefined, role: string) => {
      if (!uid) throw new ReplayNotConfirmedError(`Replay requires a ${role} collection UID`)
      const resolved = resolveCollection(collections, entry.collectionType, uid)
      if (!resolved || resolved.uid !== uid) throw new ReplayNotConfirmedError(`Replay ${role} collection is unavailable`)
      return resolved
    }

    const core = await import('@silentsuite/core')
    assertOfflineQueueAccountGuard(guard, get())

    const logicalUid = (content: string): string | null => {
      if (entry.collectionType !== 'calendar' && entry.collectionType !== 'tasks' && entry.collectionType !== 'contacts') return null
      const unfolded = content.replace(/\r?\n[ \t]/g, '')
      const match = unfolded.match(/^UID(?:;[^:]*)?:(.*)$/im)
      return match?.[1]?.trim() || null
    }
    const findRemoteItem = async (collection: any, wantedContent: string, confirmedUid?: string) => {
      const wantedLogicalUid = logicalUid(wantedContent)
      if (!wantedLogicalUid && !confirmedUid && !wantedContent) {
        throw new ReplayNotConfirmedError('Replay create cannot be reconciled without content identity')
      }
      let stoken: string | null | undefined
      do {
        assertOfflineQueueAccountGuard(guard, get())
        const response = await core.listItems(account, collection, stoken)
        assertOfflineQueueAccountGuard(guard, get())
        for (const candidate of response.items) {
          if (candidate.isDeleted) continue
          if (confirmedUid && candidate.uid === confirmedUid) return candidate
          const rawCandidateContent = await candidate.getContent()
          assertOfflineQueueAccountGuard(guard, get())
          const candidateContent = typeof rawCandidateContent === 'string' ? rawCandidateContent : new TextDecoder().decode(rawCandidateContent)
          if (wantedLogicalUid ? logicalUid(candidateContent) === wantedLogicalUid : candidateContent === wantedContent) return candidate
        }
        if (response.done) return null
        stoken = response.stoken
      } while (true)
    }
    const findRemoteItemByUid = async (collection: any, uid: string) => {
      let stoken: string | null | undefined
      do {
        assertOfflineQueueAccountGuard(guard, get())
        const response = await core.listItems(account, collection, stoken)
        assertOfflineQueueAccountGuard(guard, get())
        const found = response.items.find((candidate: any) => !candidate.isDeleted && candidate.uid === uid)
        if (found) return found
        if (response.done) return null
        stoken = response.stoken
      } while (true)
    }

    const publishConfirmedReplayItem = (
      item: any,
      itemUid: string,
      collectionUid: string,
      removeUid?: string,
    ) => {
      assertOfflineQueueAccountGuard(guard, get())
      const current = get()
      const nextItemCache = new Map(current.itemCache)
      const nextItemTypeMap = new Map(current.itemTypeMap)
      const nextItemCollectionMap = new Map(current.itemCollectionMap)
      if (removeUid && removeUid !== itemUid) {
        nextItemCache.delete(removeUid)
        nextItemTypeMap.delete(removeUid)
        nextItemCollectionMap.delete(removeUid)
      }
      nextItemCache.set(itemUid, item)
      nextItemTypeMap.set(itemUid, entry.collectionType)
      nextItemCollectionMap.set(itemUid, collectionUid)
      assertOfflineQueueAccountGuard(guard, get())
      set({
        itemCache: nextItemCache,
        itemTypeMap: nextItemTypeMap,
        itemCollectionMap: nextItemCollectionMap,
      })
    }

    // Resolves null only after a complete listing of the live owning collection
    // has no live item with this UID; any failed read throws.
    const findItem = async () => {
      if (!entry.itemUid) throw new ReplayNotConfirmedError('Replay requires an item UID')
      if (!entry.collectionUid) throw new ReplayNotConfirmedError('Replay item collection ownership is unavailable')
      const cached = itemCache.get(entry.itemUid)
      if (cached) {
        if (itemCollectionMap.get(entry.itemUid) !== entry.collectionUid) {
          throw new ReplayNotConfirmedError('Replay item collection ownership is unavailable')
        }
        return cached
      }
      // Nothing in memory, for example after a reload while offline whose queue
      // outlived the item maps: fetch the item from its owning collection.
      const collection = requireCollection(entry.collectionUid, 'owner')
      const remote = await findRemoteItemByUid(collection, entry.itemUid)
      if (!remote) return null
      publishConfirmedReplayItem(remote, entry.itemUid, collection.uid)
      return remote
    }
    const requireItem = async () => {
      const item = await findItem()
      if (!item) throw new ReplayNotConfirmedError('Replay item is unavailable')
      return item
    }

    switch (entry.type) {
      case 'create': {
        if (typeof entry.content !== 'string') throw new ReplayNotConfirmedError('Replay create content is unavailable')
        const collection = requireCollection(entry.collectionUid, 'target')
        let created = await findRemoteItem(collection, entry.content, entry.confirmedTargetUid)
        if (!created) {
          assertOfflineQueueAccountGuard(guard, get())
          created = await core.createItem(account, collection, entry.content)
        }
        const createdUid = created?.uid
        if (!createdUid) throw new ReplayNotConfirmedError('Replay create did not return a server UID')
        await checkpoint({ replayPhase: 'target-confirmed', confirmedTargetUid: createdUid })
        assertOfflineQueueAccountGuard(guard, get())
        publishConfirmedReplayItem(created, createdUid, collection.uid, entry.tempId)
        return { remoteMutationConfirmed: true, itemUid: createdUid }
      }
      case 'update': {
        let content = entry.content
        let itemMeta: ItemMeta | undefined
        if (typeof content !== 'string' && entry.itemUid) {
          assertOfflineQueueAccountGuard(guard, get())
          const cachedItems = await cacheGetItemsByType(entry.collectionType)
          assertOfflineQueueAccountGuard(guard, get())
          content = cachedItems.find((cached) => cached.itemUid === entry.itemUid)?.content
          if (entry.collectionType === 'notes' && typeof content === 'string') {
            // Notes cache an envelope carrying the title/mtime alongside the body.
            const note = core.deserializeNote(content, entry.itemUid)
            content = note.content
            itemMeta = core.noteToItemMeta(note)
          }
        }
        if (typeof content !== 'string') throw new ReplayNotConfirmedError('Replay update content is unavailable')
        const collection = requireCollection(entry.collectionUid, 'owner')
        const item = await requireItem()
        assertOfflineQueueAccountGuard(guard, get())
        await core.updateItem(account, collection, item, content, itemMeta)
        assertOfflineQueueAccountGuard(guard, get())
        return { remoteMutationConfirmed: true }
      }
      case 'sealed-update': {
        // #744 sealed replay (§12): write the accepted text only while the
        // server still holds the editing base it was typed on; otherwise hold.
        let rev = entry.rev
        const hold = async (reason: NonNullable<QueueEntry['held']>): Promise<never> => {
          assertOfflineQueueAccountGuard(guard, get())
          await casStub(entry.id, rev, { held: reason }, guard)
          assertOfflineQueueAccountGuard(guard, get())
          throw new ReplayNotConfirmedError(`Sealed custody held: ${reason}`)
        }
        const itemUid = entry.itemUid
        // Closed world: a note record carries a note payload, a contact record a favorite payload.
        const kind = entry.collectionType === 'notes' ? 'note' : entry.collectionType === 'contacts' ? 'favorite' : null
        if (!kind || !itemUid || !entry.collectionUid) return hold('unreadable')
        const opened = await cacheOpenQueuePayload(
          entry.sealed,
          `${guard.accountFingerprint}|${entry.collectionType}|${itemUid}`,
          guard.accountEpoch,
        )
        assertOfflineQueueAccountGuard(guard, get())
        if (opened.kind === 'not-ready') throw new ReplayNotConfirmedError('Sealed custody key is not ready')
        if (opened.kind === 'unreadable') return hold('unreadable')
        const payload: SealedNotePayload | SealedFavoritePayload | null = kind === 'note'
          ? parseSealedNotePayload(opened.plaintext)
          : parseSealedFavoritePayload(opened.plaintext)
        if (!payload) return hold('unreadable')
        const noteMeta = payload.kind === 'note' ? payload.body.meta : undefined
        if (opened.resealed) {
          // Old-key-only open: store the identical plaintext under the current key first.
          const resealed = await casStub(entry.id, rev, { sealed: opened.resealed }, guard)
          assertOfflineQueueAccountGuard(guard, get())
          if (!resealed) throw new ReplayNotConfirmedError('Sealed custody changed during replay')
          rev = (rev ?? 0) + 1
        }
        // One text's digest in this payload's own kind: a note by title and body, a
        // contact by its complete vCard text, never a lossy parsed model.
        const digestOf = async (text: string, meta: { name?: string } | undefined): Promise<string | null> => {
          if (kind === 'note') return cacheSealedPayloadDigest(['note', core.noteFromEtebaseItem(itemUid, '', meta ?? {}).title, text])
          return cacheSealedPayloadDigest(['favorite', text])
        }
        const bodyDigest = await digestOf(payload.body.content, noteMeta ? { name: noteMeta.name } : undefined)
        assertOfflineQueueAccountGuard(guard, get())
        // The child is proved against the original base only, never against a fresher revision.
        const proves = async (child: any): Promise<boolean> => {
          if (child.isDeleted) return false
          if (payload.base.revision !== null && core.savedRevisionOf(child) === payload.base.revision) return true
          const raw = await child.getContent()
          assertOfflineQueueAccountGuard(guard, get())
          const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
          const digest = await digestOf(text, kind === 'note' ? child.getMeta() : undefined)
          assertOfflineQueueAccountGuard(guard, get())
          if (digest === null) return false
          return digest === payload.base.digest || payload.prior.includes(digest) || digest === bodyDigest
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          let collection: any
          try {
            assertOfflineQueueAccountGuard(guard, get())
            collection = await core.getCollection(account, entry.collectionUid)
          } catch (err) {
            if (err instanceof Error && err.name === 'NotFoundError') return hold('target-missing')
            throw err
          }
          assertOfflineQueueAccountGuard(guard, get())
          if (collection.isDeleted) return hold('target-missing')
          let child: any = null
          let stoken: string | null | undefined
          do {
            assertOfflineQueueAccountGuard(guard, get())
            const response = await core.listItems(account, collection, stoken)
            assertOfflineQueueAccountGuard(guard, get())
            child = response.items.find((candidate: any) => candidate.uid === itemUid) ?? null
            if (child || response.done) break
            stoken = response.stoken
          } while (true)
          if (!child) return hold('target-missing')
          // Deleted elsewhere: the item is gone, not changed (#744).
          if (child.isDeleted) return hold('target-missing')
          if (!await proves(child)) return hold('base-changed')
          const provedRevision = core.savedRevisionOf(child)
          if (!provedRevision) throw new ReplayNotConfirmedError('Sealed custody target revision is unknown')
          // After the proof, right before the write: this exact record must still be the item's
          // only, unheld custody at this revision. A successor that replaced it, or was already
          // written and acknowledged meanwhile, is never overwritten by these older bytes.
          const current = await readOutstanding({ collectionType: entry.collectionType, itemUid }, guard)
          assertOfflineQueueAccountGuard(guard, get())
          const live = current.length === 1 ? current[0] : undefined
          if (!live?.sealed || live.id !== entry.id || live.rev !== rev || live.held) {
            throw new ReplayNotConfirmedError('Sealed custody changed during replay')
          }
          const written = await core.updateItemIfUnchanged(account, collection, child, payload.body.content, noteMeta, {
            etagOverride: provedRevision,
            deps: [collection.item],
            beforeDispatch: () => assertOfflineQueueAccountGuard(guard, get()),
          })
          assertOfflineQueueAccountGuard(guard, get())
          // Nothing is published locally; the next refresh brings the server copy and its paired revision.
          // A contact write obliges no note editor; once this exact record is acknowledged, its queued overlay retires.
          if (written.kind === 'saved' && kind === 'favorite') {
            const { contactSealedFavoriteAcknowledged } = await import('@/app/stores/use-contact-store')
            assertOfflineQueueAccountGuard(guard, get())
            const onAcknowledged = () => {
              if (getAccountEpoch() === guard.accountEpoch) contactSealedFavoriteAcknowledged(itemUid)
            }
            return { remoteMutationConfirmed: true, acknowledgeRev: rev, onAcknowledged }
          }
          if (written.kind === 'saved') {
            // T3 (#744): this context's own proved write obliges a mounted editor of
            // the note, but only once the queue acknowledged this exact record.
            const { noteSealedWriteAccepted } = await import('@/app/stores/use-note-store')
            assertOfflineQueueAccountGuard(guard, get())
            const onAcknowledged = () => {
              if (getAccountEpoch() === guard.accountEpoch) noteSealedWriteAccepted(itemUid)
            }
            return { remoteMutationConfirmed: true, acknowledgeRev: rev, onAcknowledged }
          }
          // 409: the child or its collection changed after the proof; fetch and prove again.
        }
        throw new ReplayNotConfirmedError('Sealed custody target kept changing')
      }
      case 'delete': {
        if (entry.expectedEtag !== undefined) {
          // #744 §9: a conditional delete removes the item only at the revision it was authorized at.
          if (!entry.itemUid || !entry.collectionUid) throw new ReplayNotConfirmedError('Replay delete requires an item UID')
          const restored = (child: any) => {
            let title: string | undefined
            try {
              if (entry.collectionType === 'notes' && child) title = core.noteFromEtebaseItem(child.uid, '', child.getMeta()).title
            } catch {
              title = undefined
            }
            showErrorToast(`Couldn't delete "${title ?? itemSaveNoun(entry.collectionType)}" because it changed after you deleted it. It's been restored.`)
          }
          if (!knownRevision(entry.expectedEtag)) {
            restored(null)
            return { remoteMutationConfirmed: true }
          }
          let owner: any
          try {
            assertOfflineQueueAccountGuard(guard, get())
            owner = await core.getCollection(account, entry.collectionUid)
          } catch (err) {
            if (err instanceof Error && err.name === 'NotFoundError') return { remoteMutationConfirmed: true }
            throw err
          }
          assertOfflineQueueAccountGuard(guard, get())
          if (owner.isDeleted) return { remoteMutationConfirmed: true }
          const child = await findRemoteItemByUid(owner, entry.itemUid)
          assertOfflineQueueAccountGuard(guard, get())
          if (!child || child.isDeleted) return { remoteMutationConfirmed: true }
          const result = await core.deleteItemIfUnchanged(account, owner, child, {
            etagOverride: entry.expectedEtag,
            beforeDispatch: () => assertOfflineQueueAccountGuard(guard, get()),
          })
          assertOfflineQueueAccountGuard(guard, get())
          if (result.kind === 'conflict') {
            if (entry.collectionType === 'contacts') {
              let name: string | undefined
              try {
                const raw = await child.getContent()
                name = core.deserializeContact(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)).displayName
              } catch {
                name = undefined
              }
              // The name was read across an await: it is shown only while its own account is current.
              assertOfflineQueueAccountGuard(guard, get())
              showErrorToast(`Couldn't delete "${name ?? itemSaveNoun(entry.collectionType)}" because it changed after you deleted it. It's been restored.`)
            } else {
              restored(child)
            }
          }
          return { remoteMutationConfirmed: true }
        }
        const collection = requireCollection(entry.collectionUid, 'owner')
        const item = await findItem()
        assertOfflineQueueAccountGuard(guard, get())
        // Already gone on the server (deleted elsewhere, or an earlier delete
        // whose response was lost): the wanted end state holds.
        if (!item) return { remoteMutationConfirmed: true }
        await core.deleteItem(account, collection, item)
        assertOfflineQueueAccountGuard(guard, get())
        return { remoteMutationConfirmed: true }
      }
      case 'move': {
        if (typeof entry.content !== 'string') throw new ReplayNotConfirmedError('Replay move content is unavailable')
        const sourceCollection = requireCollection(entry.collectionUid, 'source')
        const targetCollection = requireCollection(entry.targetCollectionUid, 'target')
        if (!entry.itemUid) throw new ReplayNotConfirmedError('Replay move requires a source item UID')
        if (sourceCollection.uid === targetCollection.uid) {
          const item = await requireItem()
          assertOfflineQueueAccountGuard(guard, get())
          await core.updateItem(account, sourceCollection, item, entry.content)
          assertOfflineQueueAccountGuard(guard, get())
          return { remoteMutationConfirmed: true, itemUid: entry.itemUid }
        }

        // Copy first, checkpoint its opaque Etebase UID, then monotonically retry
        // source deletion. We intentionally never roll the target back: an
        // ambiguous rollback recreates the duplicate window this state machine
        // is designed to close.
        let targetItem = await findRemoteItem(targetCollection, entry.content, entry.confirmedTargetUid)
        if (!targetItem) {
          assertOfflineQueueAccountGuard(guard, get())
          targetItem = await core.createItem(account, targetCollection, entry.content)
        }
        const targetItemUid = targetItem?.uid
        if (!targetItemUid) throw new ReplayNotConfirmedError('Replay move create did not return a server UID')
        await checkpoint({ replayPhase: 'target-confirmed', confirmedTargetUid: targetItemUid })
        assertOfflineQueueAccountGuard(guard, get())

        const sourceItem = await findRemoteItemByUid(sourceCollection, entry.itemUid)
        if (sourceItem) {
          await core.deleteItem(account, sourceCollection, sourceItem)
          assertOfflineQueueAccountGuard(guard, get())
        }
        publishConfirmedReplayItem(targetItem, targetItemUid, targetCollection.uid, entry.itemUid)
        return { remoteMutationConfirmed: true, itemUid: targetItemUid }
      }
    }
  },

  createItem: async (type: CollectionTypeKey, content: string, tempId?: string, collectionUid?: string, meta?: ItemMeta, onCommitted?: (item: any) => void, options?) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const offlineQueueGuard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
    if (!offlineQueueGuard) return null
    const collection = resolveCollection(collections, type, collectionUid)
    if (!collection) {
      logger.warn(`[etebase-store] Cannot create item: no ${type} collection`)
      return null
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      const item = await core.createItem(account, collection, content, meta)
      assertCurrentAccountEpoch(accountEpoch)
      // Cache the item for future update/delete
      const itemCache = new Map(get().itemCache)
      const itemTypeMap = new Map(get().itemTypeMap)
      const itemCollectionMap = new Map(get().itemCollectionMap)
      itemCache.set(item.uid, item)
      itemTypeMap.set(item.uid, type)
      itemCollectionMap.set(item.uid, collection.uid)
      set({ itemCache, itemTypeMap, itemCollectionMap })
      // The committed SDK object, still under the account the item was created in.
      assertCurrentAccountEpoch(accountEpoch)
      onCommitted?.(item)
      return item.uid
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return null
      if (isOfflineError(err)) {
        const queueTempId = tempId ?? `pending-${Date.now()}`
        try {
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          await enqueue({ type: 'create', collectionType: type, collectionUid: collection.uid, content, tempId: queueTempId }, offlineQueueGuard)
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          logger.warn(`[etebase-store] Offline — queued create for ${type} (tempId: ${queueTempId})`)
          options?.onQueued?.()
        } catch (queueErr) {
          if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return null
          console.error('[etebase-store] Failed to enqueue create', getSafeErrorDetails(queueErr))
          if (!options?.suppressErrorToast) showErrorToast(`Failed to save ${itemSaveNoun(type)} for offline sync. Please try again.`)
          // The queue names its refusal by class name; this file does not import the class.
          options?.onRefused?.(queueErr instanceof Error && queueErr.name === 'OfflineQueueRefusedError' ? 'queue-refused' : 'failed')
        }
      } else {
        console.error(`[etebase-store] Failed to create ${type} item`, getSafeErrorDetails(err))
        if (!options?.suppressErrorToast) showErrorToast(`Failed to save ${itemSaveNoun(type)}. Please try again.`)
        options?.onRefused?.('failed')
      }
      return null
    }
  },

  resolveCollectionUid: (type: CollectionTypeKey, collectionUid?: string) =>
    resolveCollection(get().collections, type, collectionUid)?.uid ?? null,

  readCollectionVCardUids: async (type: CollectionTypeKey, collectionUid: string) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections } = get()
    const collection = (collections[type] ?? []).find((candidate: any) => candidate.uid === collectionUid)
    if (!account || !collection) return null
    try {
      const colManager = account.getCollectionManager()
      const fresh = await withFileImportTimeout(colManager.fetch(collection.uid))
      assertCurrentAccountEpoch(accountEpoch)
      const itemManager = colManager.getItemManager(fresh)
      const uids = new Set<string>()
      let stoken: string | undefined
      let done = false
      while (!done) {
        const page: { data: any[]; stoken: string | null; done: boolean } = await withFileImportTimeout(itemManager.list({ stoken }))
        assertCurrentAccountEpoch(accountEpoch)
        for (const item of page.data) {
          if (item.isDeleted) continue
          const raw = await item.getContent()
          assertCurrentAccountEpoch(accountEpoch)
          const uid = parseVCard(typeof raw === 'string' ? raw : new TextDecoder().decode(raw), { keepMissingUid: true }).uid
          if (uid) uids.add(uid)
        }
        stoken = page.stoken || undefined
        done = page.done
      }
      return uids
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
      console.error(`[etebase-store] Failed to read ${type} before import`, getSafeErrorDetails(err))
      return null
    }
  },

  createItemsBatch: async (type: CollectionTypeKey, contents: { content: string; tempId: string }[], collectionUid?: string, onCommitted?: (tempId: string, item: any) => void, options?: { fileImport?: FileImportUpload }) => {
    if (options?.fileImport) return createItemsForFileImport(get, set, type, contents, collectionUid, onCommitted, options.fileImport)
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const offlineQueueGuard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
    if (!offlineQueueGuard) return contents.map(() => null)
    const collection = resolveCollection(collections, type, collectionUid)
    if (!collection) {
      logger.warn(`[etebase-store] Cannot create items: no ${type} collection`)
      return contents.map(() => null)
    }

    /** Queues unacknowledged creates under the captured owner; false once the account boundary moved. */
    const enqueueCreates = async (pending: typeof contents): Promise<boolean> => {
      for (const { content, tempId } of pending) {
        try {
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          await enqueue({ type: 'create', collectionType: type, collectionUid: collection.uid, content, tempId }, offlineQueueGuard)
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
        } catch (queueErr) {
          if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return false
          console.error('[etebase-store] Failed to enqueue create', getSafeErrorDetails(queueErr))
        }
      }
      return true
    }

    // Pause the sync engine for the duration of the import. The local-crypto
    // phase below blocks the main thread; without this, a 30s poll firing
    // mid-import would also decrypt freshly-imported items on the same thread,
    // freezing the UI long enough for the user to refresh and abort the import.
    const { syncEngine } = get()
    syncEngine?.pause()

    try {
      const core = await import('@silentsuite/core')
      const collectionManager = account.getCollectionManager()
      const itemManager = collectionManager.getItemManager(collection)

      // Create all item objects locally. Yield to the event loop every
      // YIELD_EVERY items so the UI stays responsive during 1000+ item imports.
      const YIELD_EVERY = 25
      const items: any[] = []
      for (let i = 0; i < contents.length; i++) {
        const item = await itemManager.create({}, contents[i]!.content)
        assertCurrentAccountEpoch(accountEpoch)
        items.push(item)
        if (i > 0 && i % YIELD_EVERY === 0) {
          await new Promise((r) => setTimeout(r, 0))
          assertCurrentAccountEpoch(accountEpoch)
        }
      }

      // Smaller batches finish each request faster, so a single slow batch is
      // less likely to cross a Cloudflare/proxy gateway timeout. Combined with
      // retry-with-backoff, this turns a transient batch failure from
      // "import aborted, ~100 items stuck" into "1-3s pause, then resume".
      const BATCH_SIZE = 20
      const MAX_BATCH_RETRIES = 3
      let lastSuccessfulItemIndex = -1
      let permanentFailure: unknown = null
      let offlineAfterAck = false

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        let attempt = 0
        let succeeded = false

        while (attempt < MAX_BATCH_RETRIES) {
          try {
            assertCurrentAccountEpoch(accountEpoch)
            await itemManager.batch(batch)
            assertCurrentAccountEpoch(accountEpoch)
            succeeded = true
            lastSuccessfulItemIndex = i + batch.length - 1
            break
          } catch (err) {
            if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
            // Offline errors are not retried on a known-down network. Before any
            // acknowledgement the outer catch queues everything; after one, the
            // acknowledged prefix is settled below and only the rest is queued.
            if (isOfflineError(err)) {
              if (lastSuccessfulItemIndex < 0) throw err
              offlineAfterAck = true
              break
            }
            attempt++
            if (attempt >= MAX_BATCH_RETRIES) {
              permanentFailure = err
              break
            }
            const backoffMs = 1000 * 2 ** (attempt - 1) // 1s, 2s, 4s
            logger.warn(
              `[etebase-store] Batch ${i / BATCH_SIZE + 1} failed (attempt ${attempt}/${MAX_BATCH_RETRIES}), retrying in ${backoffMs}ms:`,
              err,
            )
            await new Promise((r) => setTimeout(r, backoffMs))
            assertCurrentAccountEpoch(accountEpoch)
          }
        }

        if (!succeeded) break
      }

      // Update cache with whatever made it to the server. Items past
      // lastSuccessfulItemIndex never got an ack, so we can't claim them.
      const itemCache = new Map(get().itemCache)
      const itemTypeMap = new Map(get().itemTypeMap)
      const itemCollectionMap = new Map(get().itemCollectionMap)
      const uids: (string | null)[] = []
      for (let i = 0; i < items.length; i++) {
        if (i <= lastSuccessfulItemIndex) {
          const item = items[i]
          itemCache.set(item.uid, item)
          itemTypeMap.set(item.uid, type)
          itemCollectionMap.set(item.uid, collection.uid)
          uids.push(item.uid)
        } else {
          uids.push(null)
        }
      }
      assertCurrentAccountEpoch(accountEpoch)
      set({ itemCache, itemTypeMap, itemCollectionMap })
      // Each acknowledged SDK object, still under the account the batch was created in (#744).
      for (let i = 0; i <= lastSuccessfulItemIndex; i++) {
        assertCurrentAccountEpoch(accountEpoch)
        onCommitted?.(contents[i]!.tempId, items[i])
      }

      if (permanentFailure) {
        const succeeded = lastSuccessfulItemIndex + 1
        const total = items.length
        const noun = type === 'calendar' ? 'events' : type === 'tasks' ? 'tasks' : type === 'contacts' ? 'contacts' : 'preferences'
        console.error('[etebase-store] Batch import failed after retries', getSafeErrorDetails(permanentFailure))
        if (succeeded > 0) {
          showErrorToast(`Imported ${succeeded} of ${total} ${noun}. Please try again to import the rest.`)
        } else {
          showErrorToast(`Failed to import ${noun}. Please try again.`)
        }
      }

      // Went offline after an acknowledged chunk: the acknowledged items stay
      // published above; only the items never acknowledged go to the queue.
      if (offlineAfterAck && !await enqueueCreates(contents.slice(lastSuccessfulItemIndex + 1))) {
        return contents.map(() => null)
      }

      return uids
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return contents.map(() => null)
      if (isOfflineError(err)) {
        if (!await enqueueCreates(contents)) return contents.map(() => null)
      } else {
        console.error(`[etebase-store] Failed to batch create ${type} items`, getSafeErrorDetails(err))
        showErrorToast(`Failed to import ${type === 'calendar' ? 'events' : type === 'tasks' ? 'tasks' : type === 'contacts' ? 'contacts' : 'preferences'}. Please try again.`)
      }
      return contents.map(() => null)
    } finally {
      if (isCurrentAccountEpoch(accountEpoch) && get().syncEngine === syncEngine) syncEngine?.resume()
    }
  },

  updateItem: async (type: CollectionTypeKey, itemUid: string, content: string, options) => {
    // Sealed-intent note saves dispatch only at their captured editing base (#744 §7).
    if (options?.sealIntent === 'note') {
      if (type !== 'notes') {
        options.onRefused?.()
        return false
      }
      return updateNoteAtCapturedBase(itemUid, content, options, get, set)
    }
    // Contact saves dispatch only at their captured record base (#744 §8).
    if (type === 'contacts' && options?.contactBase) return updateContactAtCapturedBase(itemUid, content, options, get, set)
    if (options?.sealIntent === 'favorite') {
      options.onRefused?.()
      return false
    }
    const accountEpoch = getAccountEpoch()
    const { account, collections, itemCache, itemCollectionMap, accountFingerprint } = get()
    const offlineQueueGuard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
    if (!offlineQueueGuard) return false
    const knownCollectionUid = itemCollectionMap.get(itemUid) ?? options?.collectionUid
    const collection = resolveCollection(collections, type, knownCollectionUid)
    const item = itemCache.get(itemUid)
    if (!collection || !item) {
      if (!knownCollectionUid) {
        logger.warn(`[etebase-store] Cannot update item ${itemUid}: missing collection or item`)
        return false
      }
      // The item exists on the server and in the local cache but no item
      // object is in memory (a reload while offline): queue the edit by UID.
      return queueOfflineUpdate(type, itemUid, knownCollectionUid, content, options?.meta, options, offlineQueueGuard, accountEpoch, get)
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      const updated = await core.updateItem(account, collection, item, content, options?.meta)
      assertCurrentAccountEpoch(accountEpoch)
      const newCache = new Map(get().itemCache)
      newCache.set(itemUid, updated)
      set({ itemCache: newCache })
      assertCurrentAccountEpoch(accountEpoch)
      if (type === 'notes') {
        // A confirmed online save supersedes queued offline edits of this note;
        // replaying them later would resurrect the older cached body.
        try {
          await removeQueuedItemMutations(type, itemUid, offlineQueueGuard)
        } catch (queueErr) {
          if (queueErr instanceof AccountBoundaryChangedError) throw queueErr
          logger.warn('[etebase-store] Failed to drop superseded note queue entries', getSafeErrorDetails(queueErr))
        }
        assertCurrentAccountEpoch(accountEpoch)
      }
      return 'remote'
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      if (isOfflineError(err)) {
        return queueOfflineUpdate(type, itemUid, collection.uid, content, options?.meta ?? itemMetaOf(item), options, offlineQueueGuard, accountEpoch, get)
      } else {
        console.error(`[etebase-store] Failed to update ${type} item`, getSafeErrorDetails(err))
        if (!options?.suppressErrorToast) {
          showErrorToast(`Failed to save ${itemSaveNoun(type)}. Please try again.`)
        }
        return false
      }
    }
  },

  moveItem: async (type: CollectionTypeKey, itemUid: string, content: string, targetCollectionUid: string, sourceCollectionUid?: string, meta?: ItemMeta, options?: { sourceRevision?: string; offlineAllowed?: boolean }) => {
    const sourceRevision = options?.sourceRevision
    const accountEpoch = getAccountEpoch()
    const { account, collections, itemCache, itemCollectionMap, accountFingerprint } = get()
    const offlineQueueGuard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
    if (!offlineQueueGuard) return null
    const resolvedSourceCollectionUid = itemCollectionMap.get(itemUid) ?? sourceCollectionUid
    const sourceCollection = resolveCollection(collections, type, resolvedSourceCollectionUid)
    const targetCollection = resolveCollection(collections, type, targetCollectionUid)
    const item = itemCache.get(itemUid)
    if (!sourceCollection || !targetCollection || !item) {
      logger.warn(`[etebase-store] Cannot move item ${itemUid}: missing source collection, target collection, or item`)
      return null
    }

    try {
      if (sourceCollection.uid === targetCollection.uid) {
        await get().updateItem(type, itemUid, content)
        assertCurrentAccountEpoch(accountEpoch)
        return itemUid
      }

      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      const created = await core.createItem(account, targetCollection, content, meta)
      assertCurrentAccountEpoch(accountEpoch)
      let keepSourceUntilQueuedDelete = false

      const moveFailed = (): null => {
        showErrorToast(`Failed to move ${collectionItemNoun(type).replace(/s$/, '')}. Please try again.`)
        return null
      }
      // #744 §13: a failed conditional move takes its copy back, only at the copy's own
      // saved revision. When the server cannot confirm that, the same conditional delete
      // is queued for this account; a copy someone changed meanwhile is never removed.
      const takeBackCopy = async (): Promise<null> => {
        const copyRevision = core.savedRevisionOf(created)
        try {
          if (!copyRevision) throw new Error('Moved copy revision is unknown')
          const result = await core.deleteItemIfUnchanged(account, targetCollection, created, {
            etagOverride: copyRevision,
            beforeDispatch: () => assertOfflineQueueAccountGuard(offlineQueueGuard, get()),
          })
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          if (result.kind === 'conflict') logger.warn(`[etebase-store] Kept moved ${type} item ${created.uid}: it changed before the rollback`)
        } catch (rollbackErr) {
          if (!isCurrentAccountEpoch(accountEpoch) || rollbackErr instanceof AccountBoundaryChangedError) return null
          logger.warn(`[etebase-store] Failed to roll back moved ${type} item ${created.uid}`, getSafeErrorDetails(rollbackErr))
          if (copyRevision) {
            try {
              assertOfflineQueueAccountGuard(offlineQueueGuard, get())
              await insertIfNoOutstanding(
                { type: 'delete', collectionType: type, collectionUid: targetCollection.uid, itemUid: created.uid, expectedEtag: copyRevision },
                offlineQueueGuard,
              )
              assertOfflineQueueAccountGuard(offlineQueueGuard, get())
            } catch (queueErr) {
              if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return null
              console.error('[etebase-store] Failed to queue the rollback of a moved item', getSafeErrorDetails(queueErr))
            }
          }
        }
        return moveFailed()
      }
      try {
        if (sourceRevision !== undefined) {
          const removed = await core.deleteItemIfUnchanged(account, sourceCollection, item, {
            etagOverride: sourceRevision,
            beforeDispatch: () => assertOfflineQueueAccountGuard(offlineQueueGuard, get()),
          })
          assertCurrentAccountEpoch(accountEpoch)
          // The source changed after this move was authorized: it stays, and the copy is taken back.
          if (removed.kind === 'conflict') return await takeBackCopy()
        } else {
          await core.deleteItem(account, sourceCollection, item)
        }
        assertCurrentAccountEpoch(accountEpoch)
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return null
        if (isOfflineError(err)) {
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          if (sourceRevision !== undefined) {
            // Offline, the source delete is admitted only at the authorized revision; refused, the source stays.
            const admitted = options?.offlineAllowed !== false && await insertIfNoOutstanding(
              { type: 'delete', collectionType: type, collectionUid: sourceCollection.uid, itemUid, expectedEtag: sourceRevision },
              offlineQueueGuard,
            )
            assertOfflineQueueAccountGuard(offlineQueueGuard, get())
            if (!admitted) return await takeBackCopy()
          } else {
            await enqueue({ type: 'delete', collectionType: type, collectionUid: sourceCollection.uid, itemUid }, offlineQueueGuard)
            assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          }
          logger.warn(`[etebase-store] Offline after moving ${type}/${itemUid} - queued source delete`)
          keepSourceUntilQueuedDelete = true
        } else if (sourceRevision !== undefined) {
          console.error(`[etebase-store] Failed to move ${type} item`, getSafeErrorDetails(err))
          return await takeBackCopy()
        } else {
          try {
            assertCurrentAccountEpoch(accountEpoch)
            await core.deleteItem(account, targetCollection, created)
            assertCurrentAccountEpoch(accountEpoch)
          } catch (rollbackErr) {
            if (!isCurrentAccountEpoch(accountEpoch) || rollbackErr instanceof AccountBoundaryChangedError) return null
            logger.warn(`[etebase-store] Failed to roll back moved ${type} item ${created.uid}`, rollbackErr)
          }
          throw err
        }
      }

      assertCurrentAccountEpoch(accountEpoch)
      const newCache = new Map(get().itemCache)
      const newTypeMap = new Map(get().itemTypeMap)
      const newCollectionMap = new Map(get().itemCollectionMap)
      if (!keepSourceUntilQueuedDelete) {
        newCache.delete(itemUid)
        newTypeMap.delete(itemUid)
        newCollectionMap.delete(itemUid)
      }
      newCache.set(created.uid, created)
      newTypeMap.set(created.uid, type)
      newCollectionMap.set(created.uid, targetCollection.uid)
      assertCurrentAccountEpoch(accountEpoch)
      set({ itemCache: newCache, itemTypeMap: newTypeMap, itemCollectionMap: newCollectionMap })
      return created.uid
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return null
      console.error(`[etebase-store] Failed to move ${type} item`, getSafeErrorDetails(err))
      showErrorToast(`Failed to move ${collectionItemNoun(type).replace(/s$/, '')}. Please try again.`)
      return null
    }
  },

  deleteItem: async (type: CollectionTypeKey, itemUid: string, options) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, itemCache, itemCollectionMap, accountFingerprint } = get()
    const offlineQueueGuard = captureOfflineQueueAccountGuard({ account, accountFingerprint })
    if (!offlineQueueGuard) return false
    const knownCollectionUid = itemCollectionMap.get(itemUid) ?? options?.collectionUid
    const collection = resolveCollection(collections, type, knownCollectionUid)
    const item = itemCache.get(itemUid)
    if (options?.conditional) {
      // #744 §9: a note or contact is deleted only at the revision this context authorized.
      const revision = options.expectedRevision
      if (!knownRevision(revision) || !knownCollectionUid) return false
      const admitOffline = async (): Promise<'queued' | false> => {
        if (options.offlineAllowed === false) return false
        try {
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          const inserted = await insertIfNoOutstanding(
            { type: 'delete', collectionType: type, collectionUid: collection?.uid ?? knownCollectionUid, itemUid, expectedEtag: revision },
            offlineQueueGuard,
            options.admit,
          )
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          return inserted ? 'queued' : false
        } catch (queueErr) {
          if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return false
          console.error('[etebase-store] Failed to admit a conditional delete', getSafeErrorDetails(queueErr))
          return false
        }
      }
      // C2: a proved server uid with no SDK item in memory goes through checked admission only.
      if (!collection || !item) return admitOffline()
      try {
        const core = await import('@silentsuite/core')
        assertOfflineQueueAccountGuard(offlineQueueGuard, get())
        const result = await core.deleteItemIfUnchanged(account, collection, item, {
          etagOverride: revision,
          beforeDispatch: () => assertOfflineQueueAccountGuard(offlineQueueGuard, get()),
        })
        assertOfflineQueueAccountGuard(offlineQueueGuard, get())
        // A conflict refuses: the server holds something this context never authorized deleting.
        if (result.kind === 'conflict') return false
        const newCache = new Map(get().itemCache)
        const newTypeMap = new Map(get().itemTypeMap)
        const newCollectionMap = new Map(get().itemCollectionMap)
        newCache.delete(itemUid)
        newTypeMap.delete(itemUid)
        newCollectionMap.delete(itemUid)
        set({ itemCache: newCache, itemTypeMap: newTypeMap, itemCollectionMap: newCollectionMap })
        return 'remote'
      } catch (err) {
        if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
        if (isOfflineError(err)) return admitOffline()
        console.error(`[etebase-store] Failed to delete ${type} item`, getSafeErrorDetails(err))
        return false
      }
    }
    if (!collection || !item) {
      if (!knownCollectionUid) {
        logger.warn(`[etebase-store] Cannot delete item ${itemUid}: missing collection or item`)
        return false
      }
      // No item object in memory (a reload while offline): queue the delete by UID.
      try {
        assertOfflineQueueAccountGuard(offlineQueueGuard, get())
        await enqueue({ type: 'delete', collectionType: type, collectionUid: knownCollectionUid, itemUid }, offlineQueueGuard)
        assertOfflineQueueAccountGuard(offlineQueueGuard, get())
        logger.warn(`[etebase-store] Queued delete for ${type}/${itemUid}`)
        return 'queued'
      } catch (queueErr) {
        if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return false
        console.error('[etebase-store] Failed to enqueue delete', getSafeErrorDetails(queueErr))
        showErrorToast(`Failed to delete ${itemSaveNoun(type)} for offline sync. Please try again.`)
        return false
      }
    }

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      await core.deleteItem(account, collection, item)
      assertCurrentAccountEpoch(accountEpoch)
      const newCache = new Map(get().itemCache)
      const newTypeMap = new Map(get().itemTypeMap)
      const newCollectionMap = new Map(get().itemCollectionMap)
      newCache.delete(itemUid)
      newTypeMap.delete(itemUid)
      newCollectionMap.delete(itemUid)
      set({ itemCache: newCache, itemTypeMap: newTypeMap, itemCollectionMap: newCollectionMap })
      if (type === 'notes') {
        // Queued offline edits of a note that no longer exists can never replay.
        try {
          await removeQueuedItemMutations(type, itemUid, offlineQueueGuard)
        } catch (queueErr) {
          if (queueErr instanceof AccountBoundaryChangedError) throw queueErr
          logger.warn('[etebase-store] Failed to drop queue entries for a deleted note', getSafeErrorDetails(queueErr))
        }
        assertCurrentAccountEpoch(accountEpoch)
      }
      return 'remote'
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
      if (isOfflineError(err)) {
        try {
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          await enqueue({ type: 'delete', collectionType: type, collectionUid: collection.uid, itemUid }, offlineQueueGuard)
          assertOfflineQueueAccountGuard(offlineQueueGuard, get())
          logger.warn(`[etebase-store] Offline — queued delete for ${type}/${itemUid}`)
          return 'queued'
        } catch (queueErr) {
          if (!isCurrentAccountEpoch(accountEpoch) || queueErr instanceof AccountBoundaryChangedError) return false
          console.error('[etebase-store] Failed to enqueue delete', getSafeErrorDetails(queueErr))
          showErrorToast(`Failed to delete ${itemSaveNoun(type)} for offline sync. Please try again.`)
          return false
        }
      }
      console.error(`[etebase-store] Failed to delete ${type} item`, getSafeErrorDetails(err))
      showErrorToast(`Failed to delete ${itemSaveNoun(type)}. Please try again.`)
      return false
    }
  },

  fetchAllItems: async (type: CollectionTypeKey, accountEpoch = getAccountEpoch()) => {
    assertCurrentAccountEpoch(accountEpoch)
    const { itemCache, itemTypeMap, itemCollectionMap } = get()
    const results: CachedContentItem[] = []
    const { savedRevisionOf } = await import('@silentsuite/core')
    assertCurrentAccountEpoch(accountEpoch)

    for (const [uid, item] of itemCache.entries()) {
      if (itemTypeMap.get(uid) !== type) continue
      try {
        const content = await item.getContent()
        assertCurrentAccountEpoch(accountEpoch)
        const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
        const collectionUid = itemCollectionMap.get(uid)
        // Content and revision come from the same SDK item.
        if (collectionUid) results.push({ uid, content: contentStr, collectionUid, meta: itemMetaOf(item), revision: savedRevisionOf(item) })
      } catch (err) {
        if (err instanceof AccountBoundaryChangedError || !isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
        // Skip items that fail to decode
      }
    }

    assertCurrentAccountEpoch(accountEpoch)
    return results
  },

  refreshCollection: async (type: CollectionTypeKey, collectionUid?: string, report?: { unreadable: number }) => {
    const accountEpoch = getAccountEpoch()
    const { account, collections, accountFingerprint } = get()
    const targetCollections = collectionUid
      ? [resolveCollection(collections, type, collectionUid)].filter(Boolean)
      : collections[type]
    if (!account || targetCollections.length === 0) return []

    try {
      const core = await import('@silentsuite/core')
      assertCurrentAccountEpoch(accountEpoch)
      const colManager = account.getCollectionManager()
      const refreshed: { collection: any; items: { item: any; content: string }[] }[] = []
      const allResults: CachedContentItem[] = []

      for (const collection of targetCollections) {
        // Fetch fresh collection reference from server
        const freshCollection = await colManager.fetch(collection.uid)
        assertCurrentAccountEpoch(accountEpoch)

        // Fetch ALL items (no stoken = full fetch)
        const itemManager = colManager.getItemManager(freshCollection)
        const collectionItems: { item: any; content: string }[] = []

        // Paginate through all items
        let stoken: string | undefined = undefined
        let done = false
        while (!done) {
          const response: { data: any[]; stoken: string | null; done: boolean } = await itemManager.list({ stoken })
          assertCurrentAccountEpoch(accountEpoch)
          for (const item of response.data) {
            if (item.isDeleted) continue
            const meta = itemMetaOf(item)
            if (type === 'notes' && !core.isMarkdownNoteItem(meta)) continue
            try {
              const content = await item.getContent()
              assertCurrentAccountEpoch(accountEpoch)
              const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
              collectionItems.push({ item, content: contentStr })
              allResults.push({ uid: item.uid, content: contentStr, collectionUid: freshCollection.uid, meta, revision: core.savedRevisionOf(item) })
            } catch (err) {
              if (err instanceof AccountBoundaryChangedError) throw err
              // Skip items that fail to decode
              if (report) report.unreadable += 1
            }
          }
          stoken = response.stoken || undefined
          done = response.done
        }

        refreshed.push({ collection: freshCollection, items: collectionItems })
      }

      const refreshedUids = new Set(refreshed.map((entry) => entry.collection.uid))
      assertCurrentAccountEpoch(accountEpoch)
      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)

      // Remove old items for the refreshed concrete collections only.
      for (const [uid, mappedCollectionUid] of newItemCollectionMap.entries()) {
        if (refreshedUids.has(mappedCollectionUid)) {
          newItemCache.delete(uid)
          newItemTypeMap.delete(uid)
          newItemCollectionMap.delete(uid)
        }
      }

      for (const { collection, items } of refreshed) {
        for (const { item } of items) {
          newItemCache.set(item.uid, item)
          newItemTypeMap.set(item.uid, type)
          newItemCollectionMap.set(item.uid, collection.uid)
        }
      }

      // Update collection references too (in case metadata changed).
      const refreshedByUid = new Map(refreshed.map((entry) => [entry.collection.uid, entry.collection]))
      const newCollections = { ...get().collections }
      newCollections[type] = newCollections[type].map((collection) =>
        refreshedByUid.get(collection.uid) ?? collection,
      )
      const nextDomainStatus = collectionUid ? get().domainLoadState[type] : 'loaded'

      assertCurrentAccountEpoch(accountEpoch)
      set((state) => ({
        itemCache: newItemCache,
        itemTypeMap: newItemTypeMap,
        itemCollectionMap: newItemCollectionMap,
        collections: newCollections,
        domainLoadState: { ...state.domainLoadState, [type]: nextDomainStatus },
      }))

      logger.debug(`[etebase-store] Refreshed ${type}: ${allResults.length} items`)
      return allResults
    } catch (err) {
      if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
      if (err instanceof AccountBoundaryChangedError) throw err
      assertCurrentAccountEpoch(accountEpoch)
      console.error(`[etebase-store] Failed to refresh ${type}`, getSafeErrorDetails(err))
      assertCurrentAccountEpoch(accountEpoch)
      set((state) => ({ domainLoadState: { ...state.domainLoadState, [type]: 'failed' } }))
      assertCurrentAccountEpoch(accountEpoch)
      return get().fetchAllItems(type, accountEpoch)
    }
  },

  destroy: () => {
    const leaving = getAccountEpoch()
    const epoch = bumpAccountEpoch()
    resetBirthdayMarkers(leaving)
    void import('@/app/lib/birthday-calendar/session').then(({ resetBirthdayProjection }) => {
      resetBirthdayProjection(leaving)
    }).catch(() => {
      // The projection was already dropped above; a pending debounce re-checks its account.
    })
    // The account goes with its generation; released first so the check below sees only this bump.
    releaseLogoutGeneration()
    // Any failure after the bump, including a nested teardown's typed error,
    // is stamped with this invocation's token so callers never adopt another.
    try {
      const { syncEngine } = get()
      if (syncEngine) {
        syncEngine.stop()
      }
      // A synchronously re-entrant account boundary now owns this store.
      if (!isCurrentAccountEpoch(epoch)) return epoch
      set({
        account: null,
        accountFingerprint: null,
        collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
        itemCache: new Map(),
        itemTypeMap: new Map(),
        itemCollectionMap: new Map(),
        isInitialized: false,
        restoreBlocked: false,
        domainLoadState: unknownDomainLoadState(),
        syncEngine: null,
      })
      logger.debug('[etebase-store] Destroyed')
      return epoch
    } catch (err) {
      throw new EtebaseTeardownError(epoch, err)
    }
  },

  onSyncChange: (handler) => {
    const { syncEngine } = get()
    if (!syncEngine) return null
    return syncEngine.onChange(handler)
  },

  onStatusChange: (handler) => {
    const { syncEngine } = get()
    if (!syncEngine) return null
    return syncEngine.onStatusChange(handler)
  },
}))
