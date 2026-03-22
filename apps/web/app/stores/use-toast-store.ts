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
export function showErrorToast(message: string) {
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
