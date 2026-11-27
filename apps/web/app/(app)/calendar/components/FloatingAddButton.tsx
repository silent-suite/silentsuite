'use client'

import { useState, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { EventDialog } from './EventDialog'
import { useAuthStore } from '@/app/stores/use-auth-store'

export function FloatingAddButton() {
  const [showDialog, setShowDialog] = useState(false)
  const canWrite = useAuthStore((s) => s.canWrite())

  const handleClick = useCallback(() => {
    setShowDialog(true)
  }, [])

  const handleClose = useCallback(() => {
    setShowDialog(false)
  }, [])

  // Default to current time, rounded to next 30-min slot
  const now = new Date()
  const minutes = now.getMinutes()
  const roundedMinutes = minutes < 30 ? 30 : 60
  const startDate = new Date(now)
  startDate.setMinutes(roundedMinutes, 0, 0)
  if (roundedMinutes === 60) {
    startDate.setHours(startDate.getHours())
    startDate.setMinutes(0)
  }
  const endDate = new Date(startDate)
  endDate.setMinutes(endDate.getMinutes() + 30)

  // Read-only accounts can't create events; the read-only banner explains why.
  if (!canWrite) return null

  return (
    <>
      <button
        onClick={handleClick}
        className="fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-700 text-white shadow-lg transition-colors hover:bg-emerald-800 active:bg-emerald-900 md:hidden"
        aria-label="New event"
      >
        <Plus className="h-6 w-6" />
      </button>

      {showDialog && (
        <EventDialog
          mode="create"
          startDate={startDate}
          endDate={endDate}
          onClose={handleClose}
        />
      )}
    </>
  )
}
