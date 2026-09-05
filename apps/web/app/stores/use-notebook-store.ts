import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Notebook {
  id: string
  name: string
  color: string
  visible: boolean
  /** Etebase access: 0 read-only, 1 admin, 2 read/write. Missing fails closed. */
  accessLevel?: number
}

export const DEFAULT_NOTEBOOK_COLORS = [
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#10b981', // emerald
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
]

/** Notes can only be written to notebooks the account has admin or read/write access to. */
export function canWriteNotebook(notebook: Pick<Notebook, 'accessLevel'> | null | undefined): boolean {
  return notebook?.accessLevel === 1 || notebook?.accessLevel === 2
}

/**
 * Notebook that should receive a new note. Candidates are tried in order: the
 * notebook the list is filtered to, the starred default, the notebook of the
 * note being read, and finally the first shown writable notebook by name, so
 * the outcome never depends on the order the server lists collections in.
 * Hidden and read-only notebooks are skipped at every step.
 */
export function newNoteNotebook(
  lists: Notebook[],
  activeListId: string,
  context: { filterId?: string; openNotebookId?: string } = {},
): Notebook | undefined {
  const usable = (id: string | undefined) => {
    const notebook = id ? lists.find((list) => list.id === id) : undefined
    return notebook && notebook.visible && canWriteNotebook(notebook) ? notebook : undefined
  }
  for (const id of [context.filterId, activeListId, context.openNotebookId]) {
    const notebook = usable(id)
    if (notebook) return notebook
  }
  return lists
    .filter((list) => list.visible && canWriteNotebook(list))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
}

/**
 * Notebooks mirror the account's note collections. Creating, renaming,
 * recolouring and deleting go through the Etebase store, which then calls
 * replaceListsFromRemote; only visibility and the starred default live here.
 */
interface NotebookState {
  lists: Notebook[]
  /** Starred notebook that receives new notes; 'all' means none is starred. Visibility filters the list. */
  activeListId: string
  setActiveList: (id: string) => void
  toggleVisibility: (id: string) => void
  replaceListsFromRemote: (lists: Notebook[]) => void
  getNextColor: () => string
}

export const useNotebookStore = create<NotebookState>()(
  persist(
    (set, get) => ({
      lists: [
        { id: 'default', name: 'Personal Notes', color: '#f59e0b', visible: true },
      ],
      activeListId: 'all',

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
        return DEFAULT_NOTEBOOK_COLORS.find((c) => !usedColors.has(c)) || DEFAULT_NOTEBOOK_COLORS[lists.length % DEFAULT_NOTEBOOK_COLORS.length]
      },
    }),
    {
      name: 'silentsuite-notebooks',
    },
  ),
)
