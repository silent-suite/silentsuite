'use client'

import { create } from 'zustand'
import type { Contact, SyncStatus } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { AccountBoundaryChangedError, getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { assertOfflineQueueAccountGuard, captureOfflineQueueAccountGuard } from '@/app/lib/offline-queue-account'
import { readOutstanding } from '@/app/lib/offline-queue'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'

interface NewContact {
  displayName: string
  name?: Partial<Contact['name']>
  phones?: Contact['phones']
  emails?: Contact['emails']
  addresses?: Contact['addresses']
  organization?: string
  title?: string
  notes?: string
  birthday?: string | null
  photoUrl?: string | null
  categories?: string[]
  favorite?: boolean
  listId?: string
}

/**
 * A contact with the server revision its vCard was read at (#744), paired from
 * the same SDK item; null when unknown. In memory only: the core Contact type,
 * serializeContact and the display cache never carry it.
 */
export type StoredContact = Contact & { revision: string | null }

/** What the selected detail shows for a contact's unsettled draft (#744 §10). */
export type ContactSaveState = 'pending' | 'queued' | 'refused'

interface ContactState {
  contacts: StoredContact[]
  isLoading: boolean
  syncStatus: SyncStatus
  searchQuery: string
  contactSaveStates: Record<string, ContactSaveState>
}

interface ContactActions {
  /** Creates the contact in Etebase first and only then publishes it, in its origin account only. */
  createContact: (contact: NewContact) => Promise<StoredContact>
  /** Resolves true once the edit is saved remotely or sealed into custody. */
  updateContact: (id: string, patch: Partial<Contact>) => Promise<boolean>
  canWriteContact: (contact: Contact) => boolean
  setContactFavorite: (id: string, value: boolean) => Promise<boolean>
  /** Removes the contact only after the server delete is accepted; resolves false otherwise. */
  deleteContact: (id: string) => Promise<boolean>
  setSearchQuery: (query: string) => void
  /** Resolves with the number of contacts committed and published in the origin account. */
  importContacts: (newContacts: NewContact[]) => Promise<number>
  syncFromRemote: (contacts: StoredContact[]) => void
}

function defaultContactListId(): string | undefined {
  const { lists, activeListId } = useContactListStore.getState()
  if (activeListId !== 'all' && lists.some((list) => list.id === activeListId)) return activeListId
  return lists[0]?.id
}

function buildContact(input: NewContact, uid: string, now: Date): Contact {
  return {
    id: uid,
    uid,
    displayName: input.displayName,
    name: {
      prefix: input.name?.prefix ?? '',
      given: input.name?.given ?? '',
      family: input.name?.family ?? '',
      suffix: input.name?.suffix ?? '',
    },
    phones: input.phones ?? [],
    emails: input.emails ?? [],
    addresses: input.addresses ?? [],
    organization: input.organization ?? '',
    title: input.title ?? '',
    notes: input.notes ?? '',
    birthday: input.birthday ?? null,
    photoUrl: input.photoUrl ?? null,
    categories: input.categories ?? [],
    favorite: input.favorite ?? false,
    listId: input.listId ?? defaultContactListId(),
    created_at: now,
    updated_at: now,
  }
}

/**
 * Generation ledger (#744 §10), one per contact with an unsettled or retained
 * draft, tagged with its account epoch. Only the newest generation's remote
 * acceptance publishes a revision and retires the ledger; an older acceptance
 * never stamps or retires a newer draft. A refusal or queued acceptance keeps
 * the draft, overlaid on every remote refresh, until a newer draft is accepted.
 */
interface ContactLedger {
  accountEpoch: number
  unsettled: Set<number>
  latest: number
  draft: StoredContact
  refused: boolean
  queued: boolean
}

const contactLedgers = new Map<string, ContactLedger>()
const contactChains = new Map<string, Promise<unknown>>()
let nextGeneration = 0

function liveLedger(id: string): ContactLedger | undefined {
  const ledger = contactLedgers.get(id)
  if (!ledger) return undefined
  if (!isCurrentAccountEpoch(ledger.accountEpoch)) {
    contactLedgers.delete(id)
    return undefined
  }
  return ledger
}

function saveStateOf(ledger: ContactLedger | undefined): ContactSaveState | undefined {
  if (!ledger) return undefined
  if (ledger.refused) return 'refused'
  if (ledger.unsettled.size > 0) return 'pending'
  return ledger.queued ? 'queued' : undefined
}

/**
 * Created or imported contacts published under an explicit temp id before
 * their item is committed. A temp id is never a server identity: saves and
 * deletes of it are refused, and remote refreshes keep it until it resolves.
 */
const pendingCreates = new Map<string, { accountEpoch: number; record: StoredContact }>()

/**
 * The mounted detail that owns a contact (#744 §11). A reopened detail
 * replaces the owner, so an older detail's cleanup can never release it; an
 * owner leaves only once its photos and the contact's generations settled.
 */
interface ContactOwner {
  token: object
  accountEpoch: number
  pendingPhotos: number
  releasing: boolean
  /** A field of this detail holds typing not yet handed to a save (#744 §10). */
  fieldDraft: boolean
}

const contactOwners = new Map<string, ContactOwner>()

function ownerFor(id: string, token: object): ContactOwner | undefined {
  const owner = contactOwners.get(id)
  return owner && owner.token === token && isCurrentAccountEpoch(owner.accountEpoch) ? owner : undefined
}

function drainContactOwner(id: string): void {
  const owner = contactOwners.get(id)
  if (!owner || !owner.releasing || owner.pendingPhotos > 0 || owner.fieldDraft) return
  if ((liveLedger(id)?.unsettled.size ?? 0) > 0) return
  contactOwners.delete(id)
  retireSettledOverlay(id)
}

/**
 * #744 §11: once a contact's last owner departed, a ledger kept only for a queued
 * acceptance retires when this account holds no outstanding queue work for it, even
 * if another context acknowledged that work. A refusal, an unsettled generation, a
 * newer owner or remaining custody keeps it.
 */
function retireSettledOverlay(id: string): void {
  const ledger = liveLedger(id)
  if (!ledger || !ledger.queued || ledger.refused || ledger.unsettled.size > 0) return
  const guard = captureOfflineQueueAccountGuard(useEtebaseStore.getState())
  if (!guard) return
  void readOutstanding({ collectionType: 'contacts', itemUid: id }, guard).then((outstanding) => {
    assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
    if (outstanding.length > 0 || contactOwners.has(id) || liveLedger(id) !== ledger) return
    if (!ledger.queued || ledger.refused || ledger.unsettled.size > 0) return
    contactLedgers.delete(id)
    useContactStore.setState((state) => {
      if (!(id in state.contactSaveStates)) return state
      const contactSaveStates = { ...state.contactSaveStates }
      delete contactSaveStates[id]
      return { contactSaveStates }
    })
  }).catch(() => {
    // An unreadable queue or a changed account proves nothing: the overlay stays.
  })
}

export function registerContactOwner(id: string): object {
  const token = {}
  contactOwners.set(id, { token, accountEpoch: getAccountEpoch(), pendingPhotos: 0, releasing: false, fieldDraft: false })
  return token
}

/** Marks or clears this owner's unsaved field typing; a released mark lets the owner drain. */
export function setContactFieldDraft(id: string, token: object, active: boolean): void {
  const owner = ownerFor(id, token)
  if (!owner || owner.fieldDraft === active) return
  owner.fieldDraft = active
  if (!active) drainContactOwner(id)
}

/** Whether the detail that owns the contact in this account holds unsaved field typing. */
export function hasContactFieldDraft(id: string): boolean {
  const owner = contactOwners.get(id)
  return Boolean(owner && isCurrentAccountEpoch(owner.accountEpoch) && owner.fieldDraft)
}

/** The token of the detail that currently owns the contact in this account, if any. */
export function getContactOwner(id: string): object | undefined {
  const owner = contactOwners.get(id)
  return owner && isCurrentAccountEpoch(owner.accountEpoch) ? owner.token : undefined
}

/** Counts a photo before it is processed; false when the token no longer owns the contact. */
export function beginContactPhoto(id: string, token: object): boolean {
  const owner = ownerFor(id, token)
  if (!owner) return false
  owner.pendingPhotos += 1
  return true
}

export function endContactPhoto(id: string, token: object): void {
  const owner = ownerFor(id, token)
  if (!owner) return
  owner.pendingPhotos = Math.max(0, owner.pendingPhotos - 1)
  drainContactOwner(id)
}

export function releaseContactOwnerWhenSettled(id: string, token: object): void {
  const owner = ownerFor(id, token)
  if (!owner) return
  owner.releasing = true
  drainContactOwner(id)
}

/** Account reset: drops every contact draft ledger, save chain, pending create and owner. */
export function resetContactLifecycle(): void {
  contactLedgers.clear()
  contactChains.clear()
  pendingCreates.clear()
  contactOwners.clear()
}

export const useContactStore = create<ContactState & ContactActions>()(
    (set, get) => {
      const publishSaveState = (id: string) => {
        const next = saveStateOf(liveLedger(id))
        set((state) => {
          if (state.contactSaveStates[id] === next) return state
          const contactSaveStates = { ...state.contactSaveStates }
          if (next) contactSaveStates[id] = next
          else delete contactSaveStates[id]
          return { contactSaveStates }
        })
      }

      const startGeneration = (id: string, draft: StoredContact): number => {
        const generation = ++nextGeneration
        // A new draft carries an earlier refusal until it is itself accepted remotely.
        const ledger = liveLedger(id) ?? { accountEpoch: getAccountEpoch(), unsettled: new Set<number>(), latest: 0, draft, refused: false, queued: false }
        ledger.unsettled.add(generation)
        ledger.latest = generation
        ledger.draft = draft
        contactLedgers.set(id, ledger)
        set((state) => ({ contacts: state.contacts.map((contact) => (contact.id === id ? draft : contact)) }))
        publishSaveState(id)
        return generation
      }

      /** Settles one generation; only its own outcome is applied. */
      const settleGeneration = (
        id: string,
        generation: number,
        outcome: { kind: 'remote'; etag: string } | { kind: 'queued' } | { kind: 'refused' } | { kind: 'failed'; base: StoredContact },
        /** A favorite intent: its star value and the base it was toggled on. */
        star?: { value: boolean; base: StoredContact },
      ) => {
        const ledger = liveLedger(id)
        if (!ledger || !ledger.unsettled.delete(generation)) return
        if (outcome.kind === 'remote') {
          // An older acceptance leaves the newer draft, its state and revision alone.
          if (generation === ledger.latest) {
            const saved: StoredContact = { ...ledger.draft, revision: outcome.etag }
            set((state) => ({ contacts: state.contacts.map((contact) => (contact.id === id ? saved : contact)) }))
            ledger.draft = saved
            ledger.refused = false
            ledger.queued = false
            if (ledger.unsettled.size === 0) contactLedgers.delete(id)
          }
        } else if (outcome.kind === 'queued') {
          ledger.queued = true
        } else if (star) {
          // A favorite that was not accepted reverts only its own live star (#744 §11).
          const live = get().contacts.find((contact) => contact.id === id)
          const onlyThisStar = generation === ledger.latest && ledger.unsettled.size === 0 && !ledger.refused && !ledger.queued
          if (onlyThisStar && live === ledger.draft) {
            // A star-only draft retires: the record returns to its base, revision included.
            contactLedgers.delete(id)
            set((state) => ({ contacts: state.contacts.map((contact) => (contact === live ? star.base : contact)) }))
          } else {
            const revert = (record: StoredContact) => (record.favorite === star.value ? { ...record, favorite: star.base.favorite } : record)
            if (live && live.favorite === star.value) {
              const reverted = revert(live)
              set((state) => ({ contacts: state.contacts.map((contact) => (contact === live ? reverted : contact)) }))
              if (ledger.draft === live) ledger.draft = reverted
            } else {
              ledger.draft = revert(ledger.draft)
            }
          }
        } else if (outcome.kind === 'refused') {
          ledger.refused = true
        } else if (generation === ledger.latest && ledger.unsettled.size === 0 && !ledger.refused && !ledger.queued) {
          // Nothing was accepted or refused: only this generation's own draft rolls back.
          contactLedgers.delete(id)
          const draft = ledger.draft
          set((state) => ({ contacts: state.contacts.map((contact) => (contact === draft ? outcome.base : contact)) }))
        }
        publishSaveState(id)
        drainContactOwner(id)
      }

      /**
       * Saves a contact at its captured record base (#744 §8). The account guard,
       * the base and the draft are fixed before the first await, so a later save
       * sees this one's draft; the complete vCard witness is serialized from that
       * captured base. Ordinary and photo fields are never sealed; a favorite alone
       * may be. Saves of one contact dispatch in order.
       */
      const saveContact = async (id: string, patch: Partial<Contact>, sealIntent?: 'favorite'): Promise<boolean> => {
        const accountEpoch = getAccountEpoch()
        const guard = captureOfflineQueueAccountGuard(useEtebaseStore.getState())
        if (!guard) return false
        const base = get().contacts.find((contact) => contact.id === id)
        if (!base) return false
        const draft: StoredContact = { ...base, ...patch, updated_at: new Date(), revision: null }
        const star = sealIntent === 'favorite'
          ? { value: draft.favorite === true, base: { ...base, favorite: base.favorite === true } }
          : undefined
        const generation = startGeneration(id, draft)
        const persist = async (): Promise<boolean> => {
          let savedEtag: string | null = null
          let refused = false
          let outcome: 'remote' | 'queued' | false = false
          try {
            const { serializeContact } = await import('@silentsuite/core')
            // The account that captured the draft must still be the one dispatching it.
            assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            const witness = serializeContact(base)
            const content = serializeContact(draft)
            outcome = await useEtebaseStore.getState().updateItem('contacts', id, content, {
              contactBase: { revision: base.revision, witness },
              sealIntent,
              collectionUid: base.listId,
              suppressErrorToast: true,
              onSaved: (etag) => { savedEtag = etag },
              onRefused: () => { refused = true },
            })
          } catch (err) {
            if (!isCurrentAccountEpoch(accountEpoch)) return false
            if (err instanceof AccountBoundaryChangedError) {
              // The owning account moved on before dispatch: quietly withdraw this draft.
              settleGeneration(id, generation, { kind: 'failed', base }, star)
              return false
            }
            console.error('[contact-store] Failed to save contact', getSafeErrorDetails(err))
          }
          if (!isCurrentAccountEpoch(accountEpoch)) return false
          if (outcome === 'remote' && savedEtag) settleGeneration(id, generation, { kind: 'remote', etag: savedEtag })
          else if (outcome === 'queued') settleGeneration(id, generation, { kind: 'queued' })
          else if (refused) settleGeneration(id, generation, { kind: 'refused' }, star)
          else settleGeneration(id, generation, { kind: 'failed', base }, star)
          if (outcome === false) {
            showErrorToast(sealIntent === 'favorite' ? 'Failed to update favorite. Please try again.' : 'Failed to save contact. Please try again.')
            return false
          }
          void useLabelSuggestionsStore.getState().recordUsage('contacts', draft.categories ?? [])
          return true
        }
        const previous = contactChains.get(id) ?? Promise.resolve()
        const mutation = previous.catch(() => undefined).then(persist)
        contactChains.set(id, mutation)
        try {
          return await mutation
        } finally {
          if (contactChains.get(id) === mutation) contactChains.delete(id)
        }
      }

      return {
      contacts: [],
      isLoading: false,
      syncStatus: 'synced' as SyncStatus,
      searchQuery: '',
      contactSaveStates: {},

      createContact: async (newContact: NewContact) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        // The origin account is fixed before the first await.
        const accountEpoch = getAccountEpoch()
        // Published at once under an explicit temp identity with no revision (#744 §8).
        const tempId = crypto.randomUUID()
        const pending: StoredContact = { ...buildContact(newContact, tempId, new Date()), revision: null }
        pendingCreates.set(tempId, { accountEpoch, record: pending })
        set((state) => ({ contacts: [...state.contacts, pending] }))
        const etebase = useEtebaseStore.getState()
        if (!etebase.account) return pending
        let itemUid: string | null = null
        let committedRevision: string | null = null
        try {
          const { serializeContact, savedRevisionOf } = await import('@silentsuite/core')
          if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
          itemUid = await etebase.createItem('contacts', serializeContact(pending), tempId, pending.listId, undefined, (item) => {
            // Content and revision come from the same committed SDK object.
            if (isCurrentAccountEpoch(accountEpoch)) committedRevision = savedRevisionOf(item)
          })
        } catch (err) {
          if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) throw new AccountBoundaryChangedError()
          console.error('[contact-store] Failed to sync new contact to Etebase', getSafeErrorDetails(err))
          showErrorToast('Failed to save contact. Please try again.')
        } finally {
          if (pendingCreates.get(tempId)?.record === pending) pendingCreates.delete(tempId)
        }
        // Never published into the account that replaced the origin.
        if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
        // Uncommitted: the temp record stays local, and its id is never treated as a server identity.
        if (!itemUid) return pending
        const contact: StoredContact = { ...pending, id: itemUid, revision: committedRevision }
        set((state) => ({ contacts: state.contacts.map((record) => (record === pending ? contact : record)) }))
        void useLabelSuggestionsStore.getState().recordUsage('contacts', contact.categories ?? [])
        return contact
      },

      updateContact: async (id: string, patch: Partial<Contact>) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        return saveContact(id, patch)
      },

      canWriteContact: (contact: Contact) => {
        if (!useAuthStore.getState().canWrite()) return false
        const list = useContactListStore.getState().lists.find((entry) => entry.id === contact.listId)
        return list?.accessLevel === 1 || list?.accessLevel === 2
      },

      setContactFavorite: async (id: string, value: boolean) => {
        const contact = get().contacts.find((entry) => entry.id === id)
        if (!contact || !get().canWriteContact(contact)) return false
        if ((contact.favorite === true) === value) return true
        // A favorite alone may be sealed into custody, through the same record base.
        return saveContact(id, { favorite: value }, 'favorite')
      },

      deleteContact: async (id: string) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const contact = get().contacts.find((c) => c.id === id)
        const accountEpoch = getAccountEpoch()
        const etebase = useEtebaseStore.getState()
        if (!contact || !etebase.account) return false
        // An identity this context cannot prove on the server is refused, never queued (#744 C3).
        if (!etebase.itemCache.has(id)) return false
        // #744 §9 C1: a drafted contact or an unknown revision refuses; otherwise delete only at the revision shown.
        if (liveLedger(id) || !contact.revision) return false
        try {
          const outcome = await etebase.deleteItem('contacts', id, {
            collectionUid: contact.listId,
            conditional: true,
            expectedRevision: contact.revision,
          })
          if (!isCurrentAccountEpoch(accountEpoch) || outcome === false) return false
        } catch (err) {
          if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) return false
          console.error('[contact-store] Failed to sync contact deletion to Etebase', getSafeErrorDetails(err))
          showErrorToast('Failed to delete contact. Please try again.')
          return false
        }
        // A draft begun while the delete was in flight stays shown with its own save state, as
        // does unsaved typing still in an open field; the server copy is gone, so that draft is
        // refused visibly, never dropped silently.
        if (liveLedger(id) || hasContactFieldDraft(id)) return true
        // Not optimistic: the contact leaves the list only once the delete is accepted.
        set((state) => ({ contacts: state.contacts.filter((c) => c.id !== id) }))
        publishSaveState(id)
        return true
      },

      setSearchQuery: (query: string) => set({ searchQuery: query }),

      importContacts: async (newContacts: NewContact[]) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        if (newContacts.length === 0) return 0
        // The origin account is fixed before the first await.
        const accountEpoch = getAccountEpoch()
        const now = new Date()
        // Published at once under explicit temp ids with no revision; each is replaced only
        // by its own committed item, in the origin account (#744 §8).
        const drafts = newContacts.map((input) => {
          const tempId = crypto.randomUUID()
          return { tempId, contact: { ...buildContact(input, tempId, now), revision: null } as StoredContact }
        })
        for (const { tempId, contact } of drafts) pendingCreates.set(tempId, { accountEpoch, record: contact })
        set((state) => ({ contacts: [...state.contacts, ...drafts.map(({ contact }) => contact)] }))
        const settleDrafts = () => {
          for (const { tempId, contact } of drafts) if (pendingCreates.get(tempId)?.record === contact) pendingCreates.delete(tempId)
        }
        const etebase = useEtebaseStore.getState()
        if (!etebase.account) {
          settleDrafts()
          return drafts.length
        }
        const { serializeContact, savedRevisionOf } = await import('@silentsuite/core')
        if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()

        const groups = new Map<string | undefined, typeof drafts>()
        for (const draft of drafts) groups.set(draft.contact.listId, [...(groups.get(draft.contact.listId) ?? []), draft])
        let published = 0
        try {
          for (const [targetCollectionUid, group] of groups) {
            if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
            const committed = new Map<string, string | null>()
            const uids = await etebase.createItemsBatch(
              'contacts',
              group.map(({ tempId, contact }) => ({ content: serializeContact(contact), tempId })),
              targetCollectionUid,
              (tempId, item) => {
                if (isCurrentAccountEpoch(accountEpoch)) committed.set(tempId, savedRevisionOf(item))
              },
            )
            if (!isCurrentAccountEpoch(accountEpoch)) throw new AccountBoundaryChangedError()
            // Only items the server acknowledged in this account replace their temp records,
            // each with its own revision; the rest stay local under their temp ids.
            const committedRecords = new Map<StoredContact, StoredContact>()
            group.forEach(({ tempId, contact }, index) => {
              const itemUid = uids[index]
              if (itemUid && committed.has(tempId)) committedRecords.set(contact, { ...contact, id: itemUid, revision: committed.get(tempId) ?? null })
            })
            if (committedRecords.size === 0) continue
            set((state) => ({ contacts: state.contacts.map((record) => committedRecords.get(record) ?? record) }))
            published += committedRecords.size
            void useLabelSuggestionsStore.getState().recordUsage('contacts', [...committedRecords.values()].flatMap((contact) => contact.categories ?? []))
          }
        } catch (err) {
          if (!isCurrentAccountEpoch(accountEpoch) || err instanceof AccountBoundaryChangedError) throw new AccountBoundaryChangedError()
          console.error('[contact-store] Failed to batch import contacts', getSafeErrorDetails(err))
        } finally {
          settleDrafts()
        }
        void published
        return drafts.length
      },

      syncFromRemote: (remoteContacts: StoredContact[]) => {
        // Unsettled and retained drafts stay over the remote copy; a missing one is appended.
        const ids = new Set(remoteContacts.map((contact) => contact.id))
        const merged = remoteContacts.map((contact) => liveLedger(contact.id)?.draft ?? contact)
        for (const id of [...contactLedgers.keys()]) {
          const ledger = liveLedger(id)
          if (ledger && !ids.has(id)) merged.push(ledger.draft)
        }
        // A contact still being created stays visible under its temp id until it resolves.
        const visible = new Set(get().contacts)
        for (const [tempId, pending] of pendingCreates) {
          if (isCurrentAccountEpoch(pending.accountEpoch) && !ids.has(tempId) && visible.has(pending.record)) merged.push(pending.record)
        }
        // A focused field has not handed its typing to the ledger yet. Keep its
        // existing display record on omission until blur saves it or its owner leaves.
        const mergedIds = new Set(merged.map((contact) => contact.id))
        for (const contact of get().contacts) {
          if (!mergedIds.has(contact.id) && hasContactFieldDraft(contact.id)) {
            merged.push(contact)
            mergedIds.add(contact.id)
          }
        }
        set({ contacts: merged, syncStatus: 'synced' })
      },
      }
    },
)

/**
 * #744: this account's sealed favorite was replayed and its exact record acknowledged.
 * A ledger kept only for that queued acceptance retires; a refusal, an unsettled
 * generation or a pending photo keeps it, and sealed custody is not touched here.
 */
export function contactSealedFavoriteAcknowledged(id: string): void {
  const ledger = liveLedger(id)
  if (!ledger || !ledger.queued || ledger.refused || ledger.unsettled.size > 0) return
  const owner = contactOwners.get(id)
  if (owner && isCurrentAccountEpoch(owner.accountEpoch) && owner.pendingPhotos > 0) return
  contactLedgers.delete(id)
  useContactStore.setState((state) => {
    if (!(id in state.contactSaveStates)) return state
    const contactSaveStates = { ...state.contactSaveStates }
    delete contactSaveStates[id]
    return { contactSaveStates }
  })
  drainContactOwner(id)
}

export function getFilteredContacts(contacts: Contact[], query: string): Contact[] {
  if (!query.trim()) return contacts
  const q = query.toLowerCase()
  return contacts.filter((c) => {
    const searchable = [
      c.displayName, c.name.given, c.name.family, c.organization,
      ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value),
      ...(c.categories ?? []),
    ].join(' ').toLowerCase()
    return searchable.includes(q)
  })
}

export type { NewContact }
