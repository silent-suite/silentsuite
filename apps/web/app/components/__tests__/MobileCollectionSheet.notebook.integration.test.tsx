import { useState } from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useNoteStore } from '@/app/stores/use-note-store'
import { useNotebookStore } from '@/app/stores/use-notebook-store'
import { MobileCollectionSheet } from '../MobileCollectionSheet'

// Real notebook panel, row, and confirmation. deleteCollection is a spy on the
// real store action, not a synthetic sync result.

vi.mock('../CalendarListPanel', () => ({ CalendarListPanel: () => null }))
vi.mock('../TaskListPanel', () => ({ TaskListPanel: () => null }))
vi.mock('../ContactListPanel', () => ({ ContactListPanel: () => null }))

const deleteCollection = vi.fn()

function SheetHarness() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open collections</button>
      <MobileCollectionSheet type="notes" open={open} onClose={() => setOpen(false)} />
    </>
  )
}

describe('MobileCollectionSheet notebook confirmation', () => {
  beforeEach(async () => {
    deleteCollection.mockReset()
    localStorage.removeItem('silentsuite-notebooks')
    const persisted = useNotebookStore as typeof useNotebookStore & {
      persist?: { clearStorage: () => void; rehydrate: () => Promise<void> | void }
    }
    persisted.persist?.clearStorage()
    await persisted.persist?.rehydrate()
    useNotebookStore.setState({
      lists: [
        { id: 'nb-1', name: 'Personal', color: '#f59e0b', visible: true, accessLevel: 1 },
        { id: 'nb-2', name: 'Work', color: '#3b82f6', visible: true, accessLevel: 2 },
      ],
      activeListId: 'nb-1',
    })
    useNoteStore.setState({
      notes: [
        { id: 'n1', notebookId: 'nb-1' },
        { id: 'n2', notebookId: 'nb-1' },
      ] as never,
    })
    useEtebaseStore.setState({ deleteCollection })
  })

  async function openDelete() {
    renderWithIntl(<SheetHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Personal actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete notebook' }))
    const confirmation = await screen.findByRole('dialog', { name: 'Delete notebook?' })
    const sheet = screen.getByRole('dialog', { name: 'Collections' })
    expect(sheet.contains(confirmation)).toBe(true)
    return { confirmation, sheet }
  }

  it('cancels only the confirmation on Escape and restores the row actions button', async () => {
    const { confirmation } = await openDelete()
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete notebook?' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Collections' })).toBeInTheDocument()
    expect(deleteCollection).not.toHaveBeenCalled()
    expect(confirmation).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Personal actions' })).toHaveFocus())
  })

  it('keeps Tab inside the confirmation by wrapping at the boundary', async () => {
    const { confirmation, sheet } = await openDelete()
    const cancel = within(confirmation).getByRole('button', { name: 'Cancel' })
    const remove = within(confirmation).getByRole('button', { name: 'Delete notebook' })
    expect(sheet.contains(confirmation)).toBe(true)

    remove.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Close collections' })).not.toHaveFocus()

    cancel.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(remove).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Close collections' })).not.toHaveFocus()
  })

  it('deletes on confirm, then lets Tab and Escape operate on the sheet', async () => {
    await openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete notebook' }))

    await waitFor(() => expect(deleteCollection).toHaveBeenCalledTimes(1))
    expect(deleteCollection).toHaveBeenCalledWith('notes', 'nb-1')
    expect(screen.queryByRole('dialog', { name: 'Delete notebook?' })).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Tab' })
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Collections' }).contains(document.activeElement)).toBe(true))

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Collections' })).not.toBeInTheDocument())
  })
})
