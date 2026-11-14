'use client'

import { useState, useCallback, useMemo, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useDomainInitializing } from '@/app/hooks/use-domain-initializing'
import { CollectionListItem } from '@/app/components/CollectionListItem'

export function ContactListPanel() {
  const { lists, activeListId, toggleVisibility, setActiveList, getNextColor } = useContactListStore()
  const createCollection = useEtebaseStore((s) => s.createCollection)
  const deleteCollection = useEtebaseStore((s) => s.deleteCollection)
  const updateCollectionMeta = useEtebaseStore((s) => s.updateCollectionMeta)
  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const isCreatingRef = useRef(false)
  const t = useTranslations('Collections')
  const contacts = useContactStore((s) => s.contacts)
  // Counts stay hidden until contacts are known, so a loading account never shows 0.
  const countsUnknown = useDomainInitializing('contacts') && contacts.length === 0
  const countsByList = useMemo(() => {
    const counts = new Map<string, number>()
    for (const contact of contacts) {
      const listId = contact.listId ?? 'default'
      counts.set(listId, (counts.get(listId) ?? 0) + 1)
    }
    return counts
  }, [contacts])

  const handleAdd = useCallback(async () => {
    if (isCreatingRef.current) return
    const name = newName.trim()
    if (name) {
      isCreatingRef.current = true
      setNewName('')
      const uid = await createCollection('contacts', name, getNextColor())
      if (uid) setIsAdding(false)
      else setNewName(name)
      isCreatingRef.current = false
    }
  }, [createCollection, getNextColor, newName])

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (lists.length <= 1) return
    if (!window.confirm(`Delete address book "${name}" and all contacts in it? This cannot be undone.`)) return
    await deleteCollection('contacts', id)
  }, [deleteCollection, lists.length])

  const handleColorChange = useCallback((id: string, color: string) => {
    void updateCollectionMeta('contacts', id, { color })
  }, [updateCollectionMeta])

  const handleRename = useCallback((id: string, name: string) => {
    void updateCollectionMeta('contacts', id, { name })
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
          Address Books
        </span>
        <button
          onClick={() => setIsAdding(true)}
          className="rounded p-0.5 max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex max-md:items-center max-md:justify-center text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
          aria-label="Add address book"
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
            itemLabel="address book"
            defaultLabel="Default address book"
            deleteLabel="Delete address book"
            count={countsUnknown ? undefined : countsByList.get(list.id) ?? 0}
            countLabel={t('contactCount', { count: countsByList.get(list.id) ?? 0 })}
            onToggleVisibility={() => toggleVisibility(list.id)}
            onRename={(name) => handleRename(list.id, name)}
            onSetDefault={() => handleSetDefault(list.id)}
            onColorChange={(color) => handleColorChange(list.id, color)}
            onDelete={() => handleDelete(list.id, list.name)}
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
              placeholder="Address book name"
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
