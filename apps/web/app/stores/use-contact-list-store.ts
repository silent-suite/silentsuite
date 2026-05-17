import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAuthStore } from './use-auth-store'

export interface ContactList {
  id: string
  name: string
  color: string
  visible: boolean
}

export const DEFAULT_CONTACT_LIST_COLORS = [
  '#8b5cf6', // violet
  '#10b981', // emerald
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
]

interface ContactListState {
  lists: ContactList[]
  activeListId: string
  addList: (name: string, color?: string) => void
  removeList: (id: string) => void
  updateList: (id: string, updates: Partial<ContactList>) => void
  setActiveList: (id: string) => void
  toggleVisibility: (id: string) => void
  replaceListsFromRemote: (lists: ContactList[]) => void
  getNextColor: () => string
}

export const useContactListStore = create<ContactListState>()(
  persist(
    (set, get) => ({
      lists: [
        { id: 'default', name: 'My Contacts', color: '#8b5cf6', visible: true },
      ],
      activeListId: 'all',

      addList: (name, color) => {
        const { canWrite } = useAuthStore.getState()
        if (!canWrite()) throw new Error('Your subscription has ended. Renew to make changes.')
        const nextColor = color || get().getNextColor()
        set((state) => ({
          lists: [
            ...state.lists,
            {
              id: `contactlist_${Date.now()}`,
              name,
              color: nextColor,
              visible: true,
            },
          ],
        }))
      },

      removeList: (id) => {
        const { canWrite } = useAuthStore.getState()
        if (!canWrite()) throw new Error('Your subscription has ended. Renew to make changes.')
        if (id === 'default') return
        set((state) => ({
          lists: state.lists.filter((l) => l.id !== id),
          activeListId: state.activeListId === id ? 'default' : state.activeListId,
        }))
      },

      updateList: (id, updates) => {
        const { canWrite } = useAuthStore.getState()
        if (!canWrite()) throw new Error('Your subscription has ended. Renew to make changes.')
        set((state) => ({
          lists: state.lists.map((l) =>
            l.id === id ? { ...l, ...updates } : l,
          ),
        }))
      },

      setActiveList: (id) => set({ activeListId: id }),

      toggleVisibility: (id) => {
        set((state) => ({
          lists: state.lists.map((l) =>
            l.id === id ? { ...l, visible: !l.visible } : l,
          ),
        }))
      },

      replaceListsFromRemote: (lists) => {
        if (lists.length === 0) return
        const current = get()
        const remoteIds = new Set(lists.map((list) => list.id))
        const currentById = new Map(current.lists.map((list) => [list.id, list]))
        const merged = lists.map((list) => ({
          ...list,
          visible: currentById.get(list.id)?.visible ?? list.visible,
        }))
        set({
          lists: merged,
          activeListId: current.activeListId === 'all' || remoteIds.has(current.activeListId) ? current.activeListId : lists[0]!.id,
        })
      },

      getNextColor: () => {
        const { lists } = get()
        const usedColors = new Set(lists.map((l) => l.color))
        return DEFAULT_CONTACT_LIST_COLORS.find((c) => !usedColors.has(c)) || DEFAULT_CONTACT_LIST_COLORS[lists.length % DEFAULT_CONTACT_LIST_COLORS.length]
      },
    }),
    {
      name: 'silentsuite-contact-lists',
    },
  ),
)
