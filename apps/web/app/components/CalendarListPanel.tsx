'use client'

import { useState, useCallback, useRef } from 'react'
import { Cake, Plus } from 'lucide-react'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { showErrorToast, showSuccessToast, showWarningToast } from '@/app/stores/use-toast-store'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import {
  disableBirthdayCalendarFromSession,
  enableBirthdayCalendarFromSession,
  useManagedBirthdayCalendarIds,
  useQualifyingBirthdayCalendarIds,
} from '@/app/lib/birthday-calendar/session'
import { CollectionListItem } from '@/app/components/CollectionListItem'

const TURN_OFF_CONFIRMATION =
  'Turn off the Birthdays calendar? Birthday events generated from your contacts will be removed. '
  + 'Your contacts and any events you added yourself are kept.'

type PendingAction = { epoch: number; fingerprint: string | null }

export function CalendarListPanel() {
  const { calendars, defaultCalendarId, toggleVisibility, setDefaultCalendar, getNextColor } = useCalendarListStore()
  const createCollection = useEtebaseStore((s) => s.createCollection)
  const deleteCollection = useEtebaseStore((s) => s.deleteCollection)
  const updateCollectionMeta = useEtebaseStore((s) => s.updateCollectionMeta)
  const accountFingerprint = useEtebaseStore((s) => s.accountFingerprint)
  const managedIds = useManagedBirthdayCalendarIds()
  const ownIds = useQualifyingBirthdayCalendarIds()
  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [pending, setPending] = useState<PendingAction | null>(null)
  const isCreatingRef = useRef(false)

  const generationOn = ownIds.length > 0
  // Only the account that started an action sees it as running.
  const busy = Boolean(pending && pending.epoch === getAccountEpoch() && pending.fingerprint === accountFingerprint)

  const handleBirthdays = useCallback(async () => {
    if (busy) return
    const turningOff = generationOn
    if (turningOff && !window.confirm(TURN_OFF_CONFIRMATION)) return
    const action: PendingAction = { epoch: getAccountEpoch(), fingerprint: useEtebaseStore.getState().accountFingerprint }
    const stillCurrent = () => action.epoch === getAccountEpoch() && action.fingerprint === useEtebaseStore.getState().accountFingerprint
    setPending(action)
    let status = 'failed'
    try {
      status = (turningOff ? await disableBirthdayCalendarFromSession() : await enableBirthdayCalendarFromSession()).status
    } catch {
      status = 'failed'
    } finally {
      setPending((current) => (current === action ? null : current))
    }
    // Never publish a result into the account that replaced the one that started it.
    if (!stillCurrent()) return
    if (status === 'done') {
      showSuccessToast(turningOff
        ? 'Birthdays calendar turned off. Generated birthdays were removed; your own events were kept.'
        : 'Birthdays calendar turned on. Birthdays from your contacts will appear shortly.')
    } else if (status === 'skipped') {
      showWarningToast('The Birthdays calendar can’t be changed right now. Check that you’re online and can make changes.')
    } else if (status === 'pending') {
      showWarningToast('The Birthdays calendar change isn’t confirmed yet. It will be checked again on the next sync.')
    } else {
      showErrorToast(turningOff
        ? 'Couldn’t turn off the Birthdays calendar. Please try again.'
        : 'Couldn’t turn on the Birthdays calendar. Please try again.')
    }
  }, [busy, generationOn])

  const handleAdd = useCallback(async () => {
    if (isCreatingRef.current) return
    const name = newName.trim()
    if (name) {
      isCreatingRef.current = true
      setNewName('')
      const uid = await createCollection('calendar', name, getNextColor())
      if (uid) setIsAdding(false)
      else setNewName(name)
      isCreatingRef.current = false
    }
  }, [createCollection, getNextColor, newName])

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (calendars.length <= 1) return
    // A managed calendar is removed only through the safe turn-off, which keeps ordinary items.
    if (managedIds.includes(id)) return
    if (!window.confirm(`Delete calendar "${name}" and all events in it? This cannot be undone.`)) return
    await deleteCollection('calendar', id)
  }, [calendars.length, deleteCollection, managedIds])

  const handleColorChange = useCallback((id: string, color: string) => {
    void updateCollectionMeta('calendar', id, { color })
  }, [updateCollectionMeta])

  const handleRename = useCallback((id: string, name: string) => {
    void updateCollectionMeta('calendar', id, { name })
  }, [updateCollectionMeta])

  const handleSetDefault = useCallback((id: string) => {
    // New events never default into a managed (read-only) calendar.
    if (managedIds.includes(id)) return
    const calendar = calendars.find((cal) => cal.id === id)
    if (calendar && !calendar.visible) toggleVisibility(id)
    setDefaultCalendar(id)
  }, [calendars, managedIds, setDefaultCalendar, toggleVisibility])

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))]">
          Calendars
        </span>
        <button
          onClick={() => setIsAdding(true)}
          className="rounded p-0.5 max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex max-md:items-center max-md:justify-center text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
          aria-label="Add calendar"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-0.5">
        {calendars.map((cal) => (
          <CollectionListItem
            key={cal.id}
            name={cal.name}
            color={cal.color}
            visible={cal.visible}
            isDefault={cal.id === defaultCalendarId}
            canDelete={calendars.length > 1 && !managedIds.includes(cal.id)}
            itemLabel="calendar"
            defaultLabel="Default calendar"
            deleteLabel="Delete calendar"
            onToggleVisibility={() => toggleVisibility(cal.id)}
            onRename={(name) => handleRename(cal.id, name)}
            onSetDefault={() => handleSetDefault(cal.id)}
            onColorChange={(color) => handleColorChange(cal.id, color)}
            onDelete={() => handleDelete(cal.id, cal.name)}
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
              placeholder="Calendar name"
              className="flex-1 min-w-0 bg-transparent text-xs text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] outline-none"
            />
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 px-1">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-[rgb(var(--muted))]">
          <Cake className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Birthdays from contacts</span>
        </span>
        <button
          type="button"
          onClick={() => void handleBirthdays()}
          disabled={busy}
          aria-label={generationOn ? 'Turn off Birthdays calendar' : 'Turn on Birthdays calendar'}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-emerald-600 hover:bg-[rgb(var(--surface))] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          {busy ? 'Working…' : generationOn ? 'Turn off' : 'Turn on'}
        </button>
      </div>
    </div>
  )
}
