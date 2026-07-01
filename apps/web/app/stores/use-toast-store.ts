'use client'

import { create } from 'zustand'

export type ToastVariant = 'success' | 'error' | 'warning'

export interface ToastMessage {
  id: string
  message: string
  variant: ToastVariant
}

interface ToastState {
  toasts: ToastMessage[]
}

interface ToastActions {
  addToast: (message: string, variant: ToastVariant) => void
  removeToast: (id: string) => void
}

export type ToastCoalesceSource = 'preferences' | 'labelIndex' | 'internal-sync'

interface ToastOptions {
  source?: ToastCoalesceSource
  passiveStartup?: boolean
  suppressDuringPassiveStartup?: boolean
}

let passiveStartupCycle = 0
let passiveStartupCycleActive = false
const shownPassiveStartupToasts = new Set<string>()

export const useToastStore = create<ToastState & ToastActions>((set) => ({
  toasts: [],

  addToast: (message, variant) => {
    const id = crypto.randomUUID()
    set((state) => ({
      toasts: [...state.toasts, { id, message, variant }],
    }))
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },
}))

/** Show an error toast from anywhere (including non-React code like stores). */
export function beginPassiveStartupToastCycle() {
  passiveStartupCycle += 1
  passiveStartupCycleActive = true
  shownPassiveStartupToasts.clear()
}

export function endPassiveStartupToastCycle() {
  passiveStartupCycleActive = false
  shownPassiveStartupToasts.clear()
}

export function showErrorToast(message: string, options: ToastOptions = {}) {
  const isPassiveStartup = options.passiveStartup || passiveStartupCycleActive
  if (isPassiveStartup && options.suppressDuringPassiveStartup) return
  if (isPassiveStartup && options.source) {
    const key = `${passiveStartupCycle}:${options.source}:${message}`
    if (shownPassiveStartupToasts.has(key)) return
    shownPassiveStartupToasts.add(key)
  }
  useToastStore.getState().addToast(message, 'error')
}

/** Show a warning toast from anywhere. */
export function showWarningToast(message: string) {
  useToastStore.getState().addToast(message, 'warning')
}

/** Show a success toast from anywhere. */
export function showSuccessToast(message: string) {
  useToastStore.getState().addToast(message, 'success')
}
