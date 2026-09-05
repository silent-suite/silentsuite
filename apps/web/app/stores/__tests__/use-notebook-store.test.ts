import { beforeEach, describe, expect, it } from 'vitest'
import { canWriteNotebook, newNoteNotebook, useNotebookStore } from '../use-notebook-store'

const notebooks = [
  { id: 'notes-a', name: 'A', color: '#111', visible: true, accessLevel: 1 },
  { id: 'notes-b', name: 'B', color: '#222', visible: false, accessLevel: 2 },
]

describe('useNotebookStore', () => {
  beforeEach(() => {
    useNotebookStore.setState({ lists: notebooks, activeListId: 'all' })
  })

  it('only admin and read/write Etebase access can receive notes', () => {
    expect(canWriteNotebook({ accessLevel: 0 })).toBe(false)
    expect(canWriteNotebook({ accessLevel: 1 })).toBe(true)
    expect(canWriteNotebook({ accessLevel: 2 })).toBe(true)
    expect(canWriteNotebook({})).toBe(false)
    expect(canWriteNotebook(undefined)).toBe(false)
  })

  it('keeps local visibility and repairs a stale default when notebooks arrive from the server', () => {
    useNotebookStore.setState({ activeListId: 'missing' })

    useNotebookStore.getState().replaceListsFromRemote([
      { id: 'notes-b', name: 'B renamed', color: '#333', visible: true, accessLevel: 2 },
      { id: 'notes-c', name: 'C', color: '#444', visible: true, accessLevel: 0 },
    ])

    expect(useNotebookStore.getState().lists).toEqual([
      { id: 'notes-b', name: 'B renamed', color: '#333', visible: false, accessLevel: 2 },
      { id: 'notes-c', name: 'C', color: '#444', visible: true, accessLevel: 0 },
    ])
    expect(useNotebookStore.getState().activeListId).toBe('notes-b')
  })

  it('toggles visibility and picks the default notebook', () => {
    useNotebookStore.getState().toggleVisibility('notes-b')
    expect(useNotebookStore.getState().lists[1]!.visible).toBe(true)

    useNotebookStore.getState().setActiveList('notes-b')
    expect(useNotebookStore.getState().activeListId).toBe('notes-b')
  })

  it('chooses where a new note goes: filter, then star, then open note, then first by name', () => {
    const lists = [
      { id: 'z', name: 'Zulu', color: '#1', visible: true, accessLevel: 2 },
      { id: 'a', name: 'Alpha', color: '#2', visible: true, accessLevel: 2 },
      { id: 'hidden', name: 'Hidden', color: '#3', visible: false, accessLevel: 2 },
      { id: 'shared', name: 'Shared', color: '#4', visible: true, accessLevel: 0 },
    ]
    expect(newNoteNotebook(lists, 'all')?.id).toBe('a')
    expect(newNoteNotebook(lists, 'z')?.id).toBe('z')
    expect(newNoteNotebook(lists, 'all', { openNotebookId: 'z' })?.id).toBe('z')
    expect(newNoteNotebook(lists, 'a', { openNotebookId: 'z' })?.id).toBe('a')
    expect(newNoteNotebook(lists, 'a', { filterId: 'z', openNotebookId: 'a' })?.id).toBe('z')
    // Hidden, read-only and unknown candidates are skipped at every step.
    expect(newNoteNotebook(lists, 'hidden', { filterId: 'shared', openNotebookId: 'missing' })?.id).toBe('a')
    expect(newNoteNotebook([lists[3]!], 'all')).toBeUndefined()
  })

})
