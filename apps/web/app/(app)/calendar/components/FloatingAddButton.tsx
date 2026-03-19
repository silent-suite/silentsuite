'use client'

import { useState, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { EventDialog } from './EventDialog'

export function FloatingAddButton() {
  const [showDialog, setShowDialog] = useState(false)

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

  return (
    <>
      <button
        onClick={handleClick}
        className="fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg hover:bg-emerald-500 active:bg-emerald-700 transition-colors md:hidden"
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
