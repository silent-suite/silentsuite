import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Contact } from '@silentsuite/core';
import { mmkvStorage } from './mmkv-storage';

interface ContactState {
  contacts: Contact[];
  isLoading: boolean;
  searchQuery: string;

  setContacts: (contacts: Contact[]) => void;
  addContact: (contact: Contact) => void;
  updateContact: (id: string, contact: Partial<Contact>) => void;
  removeContact: (id: string) => void;
  setSearchQuery: (query: string) => void;
  getFilteredContacts: () => Contact[];
}

export const useContactStore = create<ContactState>()(
  persist(
    (set, get) => ({
      contacts: [],
      isLoading: false,
      searchQuery: '',

      setContacts: (contacts) => set({ contacts }),
      addContact: (contact) => set((s) => ({ contacts: [...s.contacts, contact] })),
      updateContact: (id, updates) =>
        set((s) => ({
          contacts: s.contacts.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        })),
      removeContact: (id) => set((s) => ({ contacts: s.contacts.filter((c) => c.id !== id) })),
      setSearchQuery: (query) => set({ searchQuery: query }),
      getFilteredContacts: () => {
        const { contacts, searchQuery } = get();
        if (!searchQuery.trim()) return contacts;
        const q = searchQuery.toLowerCase();
        return contacts.filter(
          (c) =>
            c.displayName?.toLowerCase().includes(q) ||
            c.emails?.some((e) => e.value.toLowerCase().includes(q)) ||
            c.phones?.some((p) => p.value.includes(q))
        );
      },
    }),
    {
      name: 'silentsuite-contacts',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({ contacts: state.contacts }),
    },
  ),
);
