'use client'

import { useEffect, useState, useCallback } from 'react'
import { WifiOff } from 'lucide-react'
import { onEnqueue } from '@/app/lib/offline-queue'

const TOAST_DURATION = 3000

export function OfflineToast() {
  const [visible, setVisible] = useState(false)
  const [fadeOut, setFadeOut] = useState(false)

  const show = useCallback(() => {
    setVisible(true)
    setFadeOut(false)
  }, [])

  useEffect(() => {
    const unsub = onEnqueue(() => {
      show()
    })
    return unsub
  }, [show])

  useEffect(() => {
    if (!visible) return
    const fadeTimer = setTimeout(() => setFadeOut(true), TOAST_DURATION - 300)
    const hideTimer = setTimeout(() => {
      setVisible(false)
      setFadeOut(false)
    }, TOAST_DURATION)
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(hideTimer)
    }
  }, [visible])

  if (!visible) return null

  return (
    <div
      className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-slate-800 px-4 py-2.5 text-sm text-amber-200 shadow-lg transition-opacity duration-300 ${fadeOut ? 'opacity-0' : 'opacity-100'}`}
      role="status"
      aria-live="polite"
    >
      <WifiOff className="h-4 w-4 shrink-0 text-amber-400" />
      Saved offline, will sync when connected
    </div>
  )
}
