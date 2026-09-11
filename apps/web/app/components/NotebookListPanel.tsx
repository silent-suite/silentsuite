'use client'

import { useState, useCallback, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useNotebookStore, type Notebook } from '@/app/stores/use-notebook-store'
import { useNoteStore } from '@/app/stores/use-note-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { CollectionListItem } from '@/app/components/CollectionListItem'
import { ConfirmDialog } from '@/app/components/confirm-dialog'

export function NotebookListPanel() {
  const t = useTranslations('Notes')
  const { lists, activeListId, toggleVisibility, setActiveList, getNextColor } = useNotebookStore()
  const createCollection = useEtebaseStore((s) => s.createCollection)
  const deleteCollection = useEtebaseStore((s) => s.deleteCollection)
  const updateCollectionMeta = useEtebaseStore((s) => s.updateCollectionMeta)
  const notes = useNoteStore((s) => s.notes)
  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Notebook | null>(null)
  const isCreatingRef = useRef(false)

  const handleAdd = useCallback(async () => {
    if (isCreatingRef.current) return
    const name = newName.trim()
    if (name) {
      isCreatingRef.current = true
      setNewName('')
      const uid = await createCollection('notes', name, getNextColor())
      if (uid) setIsAdding(false)
      else setNewName(name)
      isCreatingRef.current = false
    }
  }, [createCollection, getNextColor, newName])

  const handleDelete = useCallback((id: string) => {
    if (lists.length <= 1) return
    setPendingDelete(lists.find((list) => list.id === id) ?? null)
  }, [lists])

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete
    setPendingDelete(null)
    if (target) await deleteCollection('notes', target.id)
  }, [deleteCollection, pendingDelete])

  const handleColorChange = useCallback((id: string, color: string) => {
    void updateCollectionMeta('notes', id, { color })
  }, [updateCollectionMeta])

  const handleRename = useCallback((id: string, name: string) => {
    void updateCollectionMeta('notes', id, { name })
  }, [updateCollectionMeta])

  const handleSetDefault = useCallback((id: string) => {
    const list = lists.find((item) => item.id === id)
    if (list && !list.visible) toggleVisibility(id)
    setActiveList(id)
  }, [lists, setActiveList, toggleVisibility])

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))]">
          {t('notebooks')}
        </span>
        <button
          onClick={() => setIsAdding(true)}
          className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
          aria-label={t('addNotebook')}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-0.5">
        {lists.map((list) => (
          <CollectionListItem
            key={list.id}
            name={list.name}
            color={list.color}
            visible={list.visible}
            isDefault={list.id === activeListId}
            canDelete={lists.length > 1}
            itemLabel={t('notebook')}
            defaultLabel={t('defaultNotebook')}
            deleteLabel={t('deleteNotebook')}
            onToggleVisibility={() => toggleVisibility(list.id)}
            onRename={(name) => handleRename(list.id, name)}
            onSetDefault={() => handleSetDefault(list.id)}
            onColorChange={(color) => handleColorChange(list.id, color)}
            onDelete={() => handleDelete(list.id)}
          />
        ))}

        {isAdding && (
          <div className="flex items-center gap-1 px-1">
            <div
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: getNextColor() }}
            />
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd()
                if (e.key === 'Escape') setIsAdding(false)
              }}
              onBlur={() => {
                if (newName.trim()) handleAdd()
                else setIsAdding(false)
              }}
              placeholder={t('notebookName')}
              aria-label={t('notebookName')}
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={t('deleteNotebookTitle')}
          message={t('deleteNotebookMessage', {
            name: pendingDelete.name,
            count: notes.filter((note) => note.notebookId === pendingDelete.id).length,
          })}
          confirmLabel={t('deleteNotebook')}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
