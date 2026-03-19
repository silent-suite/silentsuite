'use client'

import { useState, useCallback } from 'react'
import { Calendar, CheckSquare, Users } from 'lucide-react'
import CalendarImport from '@/app/components/import/CalendarImport'
import TaskImport from '@/app/components/import/TaskImport'
import ContactImport from '@/app/components/import/ContactImport'

interface Toast {
  id: number
  message: string
}

export default function ImportPage() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = useCallback((message: string) => {
    const id = Date.now()
    setToasts((prev) => [...prev, { id, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">Import Data</h2>
        <p className="mt-1 text-sm text-[rgb(var(--muted))]">
          Import your existing calendar events, tasks, and contacts from other apps.
          All parsing happens locally in your browser — no data leaves your device.
        </p>
      </div>

      {/* Calendar Import */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Calendar Events</h3>
        </div>
        <CalendarImport
          onImportComplete={(count) => showToast(`Successfully imported ${count} calendar events`)}
        />
      </section>

      <hr className="border-[rgb(var(--border))]" />

      {/* Task Import */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <CheckSquare className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Tasks</h3>
        </div>
        <TaskImport
          onImportComplete={(count) => showToast(`Successfully imported ${count} tasks`)}
        />
      </section>

      <hr className="border-[rgb(var(--border))]" />

      {/* Contact Import */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Contacts</h3>
        </div>
        <ContactImport
          onImportComplete={(count) => showToast(`Successfully imported ${count} contacts`)}
        />
      </section>

      {/* Toast notifications */}
      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="animate-in slide-in-from-bottom-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  )
}
