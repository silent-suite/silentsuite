'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Calendar,
  Users,
  CheckSquare,
  Smartphone,
  ChevronDown,
  ChevronUp,
  Check,
  X,
} from 'lucide-react'
import { MobileAppDialog } from '@/app/components/MobileAppDialog'

interface ChecklistItem {
  id: string
  label: string
  description: string
  icon: React.ElementType
  href?: string
  completed: boolean
}

export function OnboardingChecklist() {
  const [isOpen, setIsOpen] = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [completedItems, setCompletedItems] = useState<Set<string>>(new Set())
  const [mobileDialogOpen, setMobileDialogOpen] = useState(false)

  // Load completed items from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('silentsuite-onboarding-checklist')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (parsed.dismissed) {
          setDismissed(true)
          return
        }
        if (parsed.completed) {
          setCompletedItems(new Set(parsed.completed))
        }
      }
    } catch {}
  }, [])

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem(
      'silentsuite-onboarding-checklist',
      JSON.stringify({
        dismissed,
        completed: Array.from(completedItems),
      }),
    )
  }, [completedItems, dismissed])

  if (dismissed) return null

  const items: ChecklistItem[] = [
    {
      id: 'import-calendar',
      label: 'Import your calendar',
      description: 'Bring your events from Google, Apple, or Outlook',
      icon: Calendar,
      href: '/settings/import',
      completed: completedItems.has('import-calendar'),
    },
    {
      id: 'import-contacts',
      label: 'Import your contacts',
      description: 'Bring your contacts from other apps',
      icon: Users,
      href: '/settings/import',
      completed: completedItems.has('import-contacts'),
    },
    {
      id: 'import-tasks',
      label: 'Import your tasks',
      description: 'Bring your tasks from Todoist or other apps',
      icon: CheckSquare,
      href: '/settings/import',
      completed: completedItems.has('import-tasks'),
    },
    {
      id: 'download-app',
      label: 'Get the mobile app',
      description: 'Access your data on the go',
      icon: Smartphone,
      completed: completedItems.has('download-app'),
    },
  ]

  const completedCount = items.filter((i) => i.completed).length
  const allDone = completedCount === items.length

  if (allDone) return null

  return (
    <div className="mx-2 mb-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
      {/* Header */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[rgb(var(--foreground))]">
            Get started
          </span>
          <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-semibold text-white">
            {completedCount}/{items.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setDismissed(true)
            }}
            className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
            aria-label="Dismiss checklist"
          >
            <X className="h-3 w-3" />
          </button>
          {isOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-[rgb(var(--muted))]" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[rgb(var(--muted))]" />
          )}
        </div>
      </button>

      {/* Items */}
      {isOpen && (
        <div className="border-t border-[rgb(var(--border))] px-1 py-1">
          {items.map((item) => {
            const Icon = item.icon
            const content = (
              <div
                className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                  item.completed
                    ? 'opacity-50'
                    : 'hover:bg-[rgb(var(--background))]'
                }`}
              >
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  item.completed
                    ? 'bg-emerald-500/20'
                    : 'bg-[rgb(var(--background))]'
                }`}>
                  {item.completed ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Icon className="h-3 w-3 text-[rgb(var(--muted))]" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-medium truncate ${
                    item.completed
                      ? 'text-[rgb(var(--muted))] line-through'
                      : 'text-[rgb(var(--foreground))]'
                  }`}>
                    {item.label}
                  </p>
                </div>
              </div>
            )

            if (item.href && !item.completed) {
              return (
                <Link key={item.id} href={item.href} className="block">
                  {content}
                </Link>
              )
            }

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id === 'download-app' && !item.completed) {
                    setMobileDialogOpen(true)
                    setCompletedItems((prev) => new Set([...prev, item.id]))
                    return
                  }
                  if (!item.completed) {
                    setCompletedItems((prev) => new Set([...prev, item.id]))
                  }
                }}
                className="w-full"
              >
                {content}
              </button>
            )
          })}
        </div>
      )}

      <MobileAppDialog
        open={mobileDialogOpen}
        onClose={() => setMobileDialogOpen(false)}
      />
    </div>
  )
}
