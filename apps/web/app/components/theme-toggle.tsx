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
        className="no-min-size rounded-md p-2 hover:bg-[rgb(var(--surface))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 transition-colors"
        aria-label="Toggle theme"
        aria-expanded={open}
      >
        <ActiveIcon className="h-4 w-4 text-[rgb(var(--foreground))]" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-[100] mt-1 w-36 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg">
          {options.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => {
                setTheme(value)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
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
