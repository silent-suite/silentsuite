'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, Calendar, CheckSquare, Users, ChevronUp } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'

const items = [
  { label: 'Event', icon: Calendar, path: '/calendar', key: 'event' },
  { label: 'Task', icon: CheckSquare, path: '/tasks', key: 'task' },
  { label: 'Contact', icon: Users, path: '/contacts', key: 'contact' },
] as const

function getPrimaryItem(pathname: string) {
  if (pathname.startsWith('/tasks')) return 'task'
  if (pathname.startsWith('/contacts')) return 'contact'
  return 'event'
}

function getPrimaryLabel(key: string) {
  return items.find((i) => i.key === key)!.label
}

export function GlobalAddButton() {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Hide on settings page
  if (pathname.startsWith('/settings') || pathname.startsWith('/admin')) {
    return null
  }

  const primary = getPrimaryItem(pathname)
  const secondaryItems = items.filter((i) => i.key !== primary)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handlePrimaryClick = useCallback(() => {
    const target = items.find((i) => i.key === primary)!
    if (pathname !== target.path) {
      router.push(target.path)
    }
    window.dispatchEvent(new CustomEvent('silentsuite:new-item', { detail: { type: primary } }))
    setOpen(false)
  }, [primary, pathname, router])

  const handleSecondaryClick = useCallback(
    (key: string) => {
      const target = items.find((i) => i.key === key)!
      router.push(target.path)
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('silentsuite:new-item', { detail: { type: key } }))
      }, 100)
      setOpen(false)
    },
    [router],
  )

  return (
    <div ref={ref} className="fixed bottom-[76px] right-3 z-40 md:bottom-6 md:right-6">
      {/* Dropdown menu (above the button) */}
      {open && (
        <div className="mb-2 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))] shadow-xl overflow-hidden">
          {secondaryItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.key}
                onClick={() => handleSecondaryClick(item.key)}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] active:bg-[rgb(var(--border))] transition-colors"
              >
                <Icon className="h-4 w-4 text-[rgb(var(--muted))]" />
                New {item.label}
              </button>
            )
          })}
        </div>
      )}

      {/* Main button with arrow */}
      <div className="flex items-center gap-0 rounded-full shadow-lg">
        <button
          onClick={handlePrimaryClick}
          className="flex items-center gap-2 rounded-l-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700 active:scale-[0.97] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 md:px-5"
        >
          <Plus className="h-4 w-4" />
          New {getPrimaryLabel(primary)}
        </button>
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center rounded-r-full border-l border-emerald-500/30 bg-emerald-600 px-3.5 py-3 text-white hover:bg-emerald-700 active:scale-[0.97] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
          aria-label="More options"
          aria-expanded={open}
        >
          <ChevronUp className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
    </div>
  )
}
