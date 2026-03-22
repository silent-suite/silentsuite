'use client'

import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, AlertTriangle, CheckCircle, X } from 'lucide-react'
import { useToastStore, type ToastMessage } from '@/app/stores/use-toast-store'

const TOAST_DURATION = 5000

const variantStyles: Record<ToastMessage['variant'], string> = {
  error: 'border-rose-500/30 text-rose-200',
  warning: 'border-amber-500/30 text-amber-200',
  success: 'border-emerald-500/30 text-emerald-200',
}

const variantIcons: Record<ToastMessage['variant'], typeof AlertCircle> = {
  error: AlertCircle,
  warning: AlertTriangle,
  success: CheckCircle,
}

const iconStyles: Record<ToastMessage['variant'], string> = {
  error: 'text-rose-400',
  warning: 'text-amber-400',
  success: 'text-emerald-400',
}

function ToastItem({ toast }: { toast: ToastMessage }) {
  const removeToast = useToastStore((s) => s.removeToast)
  const [fadeOut, setFadeOut] = useState(false)

  const dismiss = useCallback(() => {
    setFadeOut(true)
    setTimeout(() => removeToast(toast.id), 300)
  }, [removeToast, toast.id])

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadeOut(true), TOAST_DURATION - 300)
    const removeTimer = setTimeout(() => removeToast(toast.id), TOAST_DURATION)
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(removeTimer)
    }
  }, [removeToast, toast.id])

  const Icon = variantIcons[toast.variant]

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border bg-slate-800 px-4 py-2.5 text-sm shadow-lg transition-opacity duration-300 ${variantStyles[toast.variant]} ${fadeOut ? 'opacity-0' : 'opacity-100'}`}
      role="alert"
      aria-live="assertive"
    >
      <Icon className={`h-4 w-4 shrink-0 ${iconStyles[toast.variant]}`} />
      <span className="flex-1">{toast.message}</span>
      <button
        onClick={dismiss}
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-white/10"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted || toasts.length === 0) return null

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-sm:left-4 max-sm:right-4">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  )
}
