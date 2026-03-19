'use client'

import { CalendarDays, CheckSquare, Users, Search, type LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  /** Optional action button */
  action?: {
    label: string
    onClick: () => void
  }
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[rgb(var(--primary))]/10">
        <Icon className="h-8 w-8 text-[rgb(var(--primary))]/60" />
      </div>
      <h3 className="mt-4 text-base font-medium text-[rgb(var(--foreground))]">{title}</h3>
      <p className="mt-1.5 max-w-[280px] text-center text-sm leading-relaxed text-[rgb(var(--muted))]">
        {description}
      </p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

// Pre-configured empty states for each section

export function CalendarEmptyState() {
  return (
    <EmptyState
      icon={CalendarDays}
      title="No events today"
      description="Your schedule is clear. Tap the + button to add your first event."
    />
  )
}

export function TasksEmptyState() {
  return (
    <EmptyState
      icon={CheckSquare}
      title="No tasks yet"
      description="Stay on top of things. Add a task using the input above to get started."
    />
  )
}

export function ContactsEmptyState({ onAddContact }: { onAddContact?: () => void }) {
  return (
    <EmptyState
      icon={Users}
      title="No contacts yet"
      description="Your address book is empty. Add your first contact to keep your people close."
      action={onAddContact ? { label: 'Add Contact', onClick: onAddContact } : undefined}
    />
  )
}

export function SearchEmptyState({ query }: { query: string }) {
  return (
    <EmptyState
      icon={Search}
      title="No results found"
      description={`No contacts match "${query}". Try a different search term.`}
    />
  )
}

export function ContactDetailEmptyState() {
  return (
    <EmptyState
      icon={Users}
      title="Select a contact"
      description="Choose a contact from the list to view their details."
    />
  )
}
