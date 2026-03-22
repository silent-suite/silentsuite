'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Contact, SyncStatus } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { enqueue } from '@/app/lib/offline-queue'

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
  syncFromRemote: (contacts: Contact[]) => void
}

export const useContactStore = create<ContactState & ContactActions>()(
  persist(
    (set, get) => ({
      contacts: [],
      isLoading: false,
      syncStatus: 'synced' as SyncStatus,
      searchQuery: '',

      createContact: async (newContact: NewContact) => {
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
          }
        }

        return contact
      },

      updateContact: async (id: string, patch: Partial<Contact>) => {
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
            }
          } else {
            const { serializeContact } = await import('@silentsuite/core')
            const content = serializeContact(updated)
            await enqueue({ type: 'update', collectionType: 'contacts', content, tempId: id })
          }
        }
      },

      deleteContact: async (id: string) => {
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
            }
          } else {
            // Item was created offline and not yet synced — enqueue delete with tempId for compaction
            await enqueue({ type: 'delete', collectionType: 'contacts', tempId: id })
          }
        }
      },

      setSearchQuery: (query: string) => set({ searchQuery: query }),

      syncFromRemote: (remoteContacts: Contact[]) => {
        set({ contacts: remoteContacts, syncStatus: 'synced' })
      },
    }),
    {
      name: 'silentsuite-contacts',
      partialize: (state) => ({ contacts: state.contacts }),
      storage: {
        getItem: (name) => {
          const raw = localStorage.getItem(name)
          if (!raw) return null
          const parsed = JSON.parse(raw)
          if (parsed?.state?.contacts) {
            parsed.state.contacts = parsed.state.contacts.map((c: Record<string, unknown>) => ({
              ...c,
              created_at: new Date(c.created_at as string),
              updated_at: new Date(c.updated_at as string),
            }))
          }
          return parsed
        },
        setItem: (name, value) => localStorage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
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
