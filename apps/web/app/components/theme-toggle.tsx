'use client'

import { useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { Sun, Moon, Monitor, Check } from 'lucide-react'

const options = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Auto-focus first item on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => itemsRef.current[0]?.focus())
    }
  }, [open])

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = itemsRef.current.filter(Boolean) as HTMLElement[]
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  if (!mounted) {
    return (
      <button className="rounded-md p-2" aria-label="Toggle theme">
        <Monitor className="h-5 w-5 text-[rgb(var(--muted))]" />
      </button>
    )
  }

  const ActiveIcon = options.find((o) => o.value === theme)?.icon ?? Monitor

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-md p-2 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center hover:bg-[rgb(var(--surface))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 transition-colors"
        aria-label="Toggle theme"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <ActiveIcon className="h-4 w-4 text-[rgb(var(--foreground))]" />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-[100] mt-1 w-36 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg"
          role="menu"
          aria-label="Theme options"
          onKeyDown={handleMenuKeyDown}
        >
          {options.map(({ value, label, icon: Icon }, i) => (
            <button
              key={value}
              ref={(el) => { itemsRef.current[i] = el }}
              onClick={() => {
                setTheme(value)
                setOpen(false)
              }}
              role="menuitem"
              tabIndex={-1}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:bg-[rgb(var(--surface))] focus:outline-none transition-colors"
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{label}</span>
              {theme === value && (
                <Check className="h-4 w-4 text-[rgb(var(--primary))]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
