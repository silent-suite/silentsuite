'use client'

import { create } from 'zustand'
import type { Contact, SyncStatus } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { enqueue } from '@/app/lib/offline-queue'
import { showErrorToast } from '@/app/stores/use-toast-store'

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
  listId?: string
}

interface ContactState {
  contacts: Contact[]
  isLoading: boolean
  syncStatus: SyncStatus
  searchQuery: string
}

interface ContactActions {
  createContact: (contact: NewContact) => Promise<Contact>
  updateContact: (id: string, patch: Partial<Contact>) => Promise<void>
  deleteContact: (id: string) => Promise<void>
  setSearchQuery: (query: string) => void
  importContacts: (newContacts: NewContact[]) => Promise<number>
  syncFromRemote: (contacts: Contact[]) => void
}

export const useContactStore = create<ContactState & ContactActions>()(
    (set, get) => ({
      contacts: [],
      isLoading: false,
      syncStatus: 'synced' as SyncStatus,
      searchQuery: '',

      createContact: async (newContact: NewContact) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const tempId = crypto.randomUUID()
        const now = new Date()
        const contact: Contact = {
          id: tempId,
          uid: tempId,
          displayName: newContact.displayName,
          name: {
            prefix: newContact.name?.prefix ?? '',
            given: newContact.name?.given ?? '',
            family: newContact.name?.family ?? '',
            suffix: newContact.name?.suffix ?? '',
          },
          phones: newContact.phones ?? [],
          emails: newContact.emails ?? [],
          addresses: newContact.addresses ?? [],
          organization: newContact.organization ?? '',
          title: newContact.title ?? '',
          notes: newContact.notes ?? '',
          birthday: newContact.birthday ?? null,
          photoUrl: newContact.photoUrl ?? null,
          listId: newContact.listId,
          created_at: now,
          updated_at: now,
        }

        // Optimistic local update
        set((state) => ({ contacts: [...state.contacts, contact] }))

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          try {
            const { serializeContact } = await import('@silentsuite/core')
            const content = serializeContact(contact)
            const itemUid = await etebase.createItem('contacts', content, tempId)
            if (itemUid) {
              set((state) => ({
                contacts: state.contacts.map((c) =>
                  c.id === tempId ? { ...c, id: itemUid, uid: itemUid } : c,
                ),
              }))
              return { ...contact, id: itemUid, uid: itemUid }
            }
          } catch (err) {
            console.error('[contact-store] Failed to sync new contact to Etebase:', err)
            showErrorToast('Failed to save contact. Please try again.')
          }
        }

        return contact
      },

      updateContact: async (id: string, patch: Partial<Contact>) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const { contacts } = get()
        const index = contacts.findIndex((c) => c.id === id)
        if (index === -1) return

        const updated = { ...contacts[index], ...patch, updated_at: new Date() }
        const next = [...contacts]
        next[index] = updated
        set({ contacts: next })

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          const itemInCache = etebase.itemCache.has(id)
          if (itemInCache) {
            try {
              const { serializeContact } = await import('@silentsuite/core')
              const content = serializeContact(updated)
              await etebase.updateItem('contacts', id, content)
            } catch (err) {
              console.error('[contact-store] Failed to sync contact update to Etebase:', err)
              showErrorToast('Failed to save contact. Please try again.')
            }
          } else {
            const { serializeContact } = await import('@silentsuite/core')
            const content = serializeContact(updated)
            await enqueue({ type: 'update', collectionType: 'contacts', content, tempId: id })
          }
        }
      },

      deleteContact: async (id: string) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        set((state) => ({ contacts: state.contacts.filter((c) => c.id !== id) }))

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          const itemInCache = etebase.itemCache.has(id)
          if (itemInCache) {
            try {
              await etebase.deleteItem('contacts', id)
            } catch (err) {
              console.error('[contact-store] Failed to sync contact deletion to Etebase:', err)
              showErrorToast('Failed to delete contact. Please try again.')
            }
          } else {
            // Item was created offline and not yet synced — enqueue delete with tempId for compaction
            await enqueue({ type: 'delete', collectionType: 'contacts', tempId: id })
          }
        }
      },

      setSearchQuery: (query: string) => set({ searchQuery: query }),

      importContacts: async (newContacts: NewContact[]) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        if (newContacts.length === 0) return 0

        const now = new Date()
        const contacts: Contact[] = newContacts.map((nc) => {
          const tempId = crypto.randomUUID()
          return {
            id: tempId,
            uid: tempId,
            displayName: nc.displayName,
            name: {
              prefix: nc.name?.prefix ?? '',
              given: nc.name?.given ?? '',
              family: nc.name?.family ?? '',
              suffix: nc.name?.suffix ?? '',
            },
            phones: nc.phones ?? [],
            emails: nc.emails ?? [],
            addresses: nc.addresses ?? [],
            organization: nc.organization ?? '',
            title: nc.title ?? '',
            notes: nc.notes ?? '',
            birthday: nc.birthday ?? null,
            photoUrl: nc.photoUrl ?? null,
            listId: nc.listId,
            created_at: now,
            updated_at: now,
          }
        })

        // Optimistic local update — add all at once
        set((state) => ({ contacts: [...state.contacts, ...contacts] }))

        // Batch sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          try {
            const { serializeContact } = await import('@silentsuite/core')
            const contents = contacts.map((c) => ({
              content: serializeContact(c),
              tempId: c.id,
            }))
            const uids = await etebase.createItemsBatch('contacts', contents)
            set((state) => ({
              contacts: state.contacts.map((c) => {
                const idx = contacts.findIndex((contact) => contact.id === c.id)
                if (idx !== -1 && uids[idx]) {
                  return { ...c, id: uids[idx]!, uid: uids[idx]! }
                }
                return c
              }),
            }))
          } catch (err) {
            console.error('[contact-store] Failed to batch import contacts:', err)
          }
        }

        return contacts.length
      },

      syncFromRemote: (remoteContacts: Contact[]) => {
        set({ contacts: remoteContacts, syncStatus: 'synced' })
      },
    }),
)

export function getFilteredContacts(contacts: Contact[], query: string): Contact[] {
  if (!query.trim()) return contacts
  const q = query.toLowerCase()
  return contacts.filter((c) => {
    const searchable = [
      c.displayName, c.name.given, c.name.family, c.organization,
      ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value),
    ].join(' ').toLowerCase()
    return searchable.includes(q)
  })
}

export type { NewContact }
