'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Calendar, CheckSquare, Users, Shield, Check, Lock, EyeOff, Sun, Moon, Monitor, X } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@silentsuite/ui'
import CalendarImport from '@/app/components/import/CalendarImport'
import TaskImport from '@/app/components/import/TaskImport'
import ContactImport from '@/app/components/import/ContactImport'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useTaskStore } from '@/app/stores/use-task-store'

interface ImportCounts {
  calendar: number
  tasks: number
  contacts: number
}

type Direction = 'left' | 'right'

const TOTAL_STEPS = 6
const STEP_LABELS = ['Welcome', 'Theme', 'Calendar', 'Tasks', 'Contacts', 'Done']

function WelcomeSlide({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-3">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Shield className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          Your encrypted workspace is ready
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Let&apos;s set up your workspace. You can import your existing calendar,
          tasks and contacts &mdash; or start fresh.
        </p>
      </div>

      <div className="grid gap-3 mt-4">
        {[
          { icon: Lock, title: 'End-to-End Encrypted', desc: 'Your data is encrypted on your device before it reaches our servers. Not even we can read it.' },
          { icon: EyeOff, title: 'Zero-Knowledge Architecture', desc: 'We never have access to your encryption keys or unencrypted data.' },
          { icon: Shield, title: 'Open Source & Auditable', desc: 'Our code is open source so anyone can verify our security claims.' },
        ].map(({ icon: Icon, title, desc }) => (
          <div key={title} className="flex items-start gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
              <Icon className="h-4 w-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-[rgb(var(--foreground))]">{title}</p>
              <p className="text-xs text-[rgb(var(--muted))] mt-0.5">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      <Button onClick={onGetStarted} className="w-full">
        Get started
      </Button>
    </div>
  )
}

function ThemeChoiceSlide({ onNext }: { onNext: () => void }) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const themes = [
    {
      value: 'light', label: 'Light', icon: Sun,
      bgPreview: 'bg-white', sidebarPreview: 'bg-gray-100', textPreview: 'bg-gray-800',
      accentPreview: 'bg-emerald-500', borderPreview: 'border-gray-200',
    },
    {
      value: 'dark', label: 'Dark', icon: Moon,
      bgPreview: 'bg-gray-900', sidebarPreview: 'bg-gray-800', textPreview: 'bg-gray-300',
      accentPreview: 'bg-emerald-500', borderPreview: 'border-gray-700',
    },
    {
      value: 'system', label: 'System', icon: Monitor,
      bgPreview: 'bg-gradient-to-r from-white to-gray-900', sidebarPreview: 'bg-gradient-to-r from-gray-100 to-gray-800',
      textPreview: 'bg-gradient-to-r from-gray-800 to-gray-300', accentPreview: 'bg-emerald-500', borderPreview: 'border-gray-400',
    },
  ] as const

  const selectedTheme = mounted ? theme : 'system'

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-3">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Sun className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">Choose your theme</h2>
        <p className="text-sm text-[rgb(var(--muted))]">Pick how SilentSuite looks. You can change this anytime in Settings.</p>
      </div>

      <div className="grid gap-3">
        {themes.map(({ value, label, icon: Icon, bgPreview, sidebarPreview, textPreview, accentPreview, borderPreview }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            className={`flex items-center gap-4 rounded-lg border p-4 text-left transition-all ${
              selectedTheme === value
                ? 'border-emerald-500 bg-emerald-500/5 ring-1 ring-emerald-500/30'
                : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] hover:border-[rgb(var(--muted))]/50'
            }`}
          >
            <div className={`relative h-16 w-24 shrink-0 overflow-hidden rounded-md border ${borderPreview}`}>
              <div className={`absolute inset-0 ${bgPreview}`} />
              <div className={`absolute left-0 top-0 bottom-0 w-6 ${sidebarPreview}`} />
              <div className={`absolute left-8 top-2 right-2 h-1.5 rounded-full ${textPreview} opacity-60`} />
              <div className={`absolute left-8 top-5 w-8 h-1.5 rounded-full ${accentPreview} opacity-80`} />
              <div className={`absolute left-8 top-8 right-4 h-1 rounded-full ${textPreview} opacity-30`} />
              <div className={`absolute left-8 top-11 right-2 h-1 rounded-full ${textPreview} opacity-20`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-[rgb(var(--foreground))]" />
                <span className="text-sm font-medium text-[rgb(var(--foreground))]">{label}</span>
              </div>
              <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">
                {value === 'light' && 'Clean and bright interface'}
                {value === 'dark' && 'Easy on the eyes, perfect for night'}
                {value === 'system' && 'Follows your OS appearance setting'}
              </p>
            </div>
            {selectedTheme === value && <Check className="h-5 w-5 shrink-0 text-emerald-500" />}
          </button>
        ))}
      </div>

      <Button onClick={onNext} className="w-full">Continue</Button>
    </div>
  )
}

function CompletionSlide({ counts, onFinish }: { counts: ImportCounts; onFinish: () => void }) {
  const anyImported = counts.calendar > 0 || counts.tasks > 0 || counts.contacts > 0

  const items = [
    { label: 'calendar events', count: counts.calendar, noun: 'Calendar' },
    { label: 'tasks', count: counts.tasks, noun: 'Tasks' },
    { label: 'contacts', count: counts.contacts, noun: 'Contacts' },
  ]

  return (
    <div className="space-y-6 animate-fade-in">
      {anyImported && (
        <div className="flex justify-center">
          <div className="celebration-check flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
            <Check className="h-8 w-8 text-emerald-500" />
          </div>
        </div>
      )}
      <div className="text-center space-y-2">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          {anyImported ? "You're all set!" : 'Setup complete'}
        </h2>
      </div>
      <div className="space-y-2">
        {items.map(({ label, count, noun }) => (
          <div key={noun} className="flex items-center gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-3">
            {count > 0 ? (
              <>
                <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                <span className="text-sm text-[rgb(var(--foreground))]">{count} {label} imported</span>
              </>
            ) : (
              <>
                <span className="text-sm text-[rgb(var(--muted))]">&mdash;</span>
                <span className="text-sm text-[rgb(var(--muted))]">{noun}: skipped</span>
              </>
            )}
          </div>
        ))}
      </div>
      {!anyImported && (
        <p className="text-center text-xs text-[rgb(var(--muted))]">No worries — you can import anytime from Settings</p>
      )}
      <p className="text-center text-xs text-[rgb(var(--muted))]">You can always import more data from Settings &gt; Import</p>
      <Button onClick={onFinish} className="w-full">Go to your workspace</Button>
    </div>
  )
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-2 w-2 rounded-full transition-all duration-300 ${
            i === current ? 'bg-emerald-500 scale-125' : i < current ? 'bg-emerald-500/40' : 'bg-[rgb(var(--border))]'
          }`}
          aria-label={`Step ${i + 1}: ${STEP_LABELS[i]}`}
        />
      ))}
    </div>
  )
}

export function OnboardingModal() {
  const [show, setShow] = useState(false)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState<Direction>('left')
  const [isAnimating, setIsAnimating] = useState(false)
  const [counts, setCounts] = useState<ImportCounts>({ calendar: 0, tasks: 0, contacts: 0 })
  const backdropRef = useRef<HTMLDivElement>(null)

  const events = useCalendarStore((s) => s.events)
  const contacts = useContactStore((s) => s.contacts)
  const tasks = useTaskStore((s) => s.tasks)

  useEffect(() => {
    const completed = localStorage.getItem('onboardingCompleted')
    if (completed) return

    // If user already has synced data, skip onboarding
    const hasData = events.length > 0 || contacts.length > 0 || tasks.length > 0
    if (hasData) {
      localStorage.setItem('onboardingCompleted', 'true')
      return
    }

    setShow(true)
  }, [events.length, contacts.length, tasks.length])

  const goTo = useCallback(
    (nextStep: number, dir: Direction) => {
      if (isAnimating || nextStep < 0 || nextStep >= TOTAL_STEPS) return
      setDirection(dir)
      setIsAnimating(true)
      setTimeout(() => {
        setStep(nextStep)
        setIsAnimating(false)
      }, 200)
    },
    [isAnimating],
  )

  const next = useCallback(() => goTo(step + 1, 'left'), [goTo, step])
  const back = useCallback(() => goTo(step - 1, 'right'), [goTo, step])

  const finish = useCallback(() => {
    localStorage.setItem('onboardingCompleted', 'true')
    setShow(false)
  }, [])

  const skipAll = useCallback(() => {
    localStorage.setItem('onboardingCompleted', 'true')
    setShow(false)
  }, [])

  const handleCalendarImport = useCallback((count: number) => {
    setCounts((prev) => ({ ...prev, calendar: count }))
    next()
  }, [next])

  const handleTaskImport = useCallback((count: number) => {
    setCounts((prev) => ({ ...prev, tasks: count }))
    next()
  }, [next])

  const handleContactImport = useCallback((count: number) => {
    setCounts((prev) => ({ ...prev, contacts: count }))
    next()
  }, [next])

  useEffect(() => {
    if (!show) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' && step < TOTAL_STEPS - 1 && step > 0) next()
      if (e.key === 'ArrowLeft' && step > 0) back()
      if (e.key === 'Escape') skipAll()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [show, step, next, back, skipAll])

  if (!show) return null

  const slideClass = isAnimating
    ? direction === 'left' ? 'onb-slide-exit-left' : 'onb-slide-exit-right'
    : direction === 'left' ? 'onb-slide-enter-left' : 'onb-slide-enter-right'

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) skipAll() }}
    >
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-6 shadow-2xl sm:p-8">
        {/* Close button */}
        <button
          type="button"
          onClick={skipAll}
          className="absolute right-3 top-3 rounded-md p-1 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
          aria-label="Close onboarding"
        >
          <X className="h-4 w-4" />
        </button>

        <StepIndicator current={step} total={TOTAL_STEPS} />

        <div className={`onb-transition-slide ${slideClass}`}>
          {step === 0 && <WelcomeSlide onGetStarted={next} />}
          {step === 1 && <ThemeChoiceSlide onNext={next} />}
          {step === 2 && <CalendarImport onImportComplete={handleCalendarImport} />}
          {step === 3 && <TaskImport onImportComplete={handleTaskImport} />}
          {step === 4 && <ContactImport onImportComplete={handleContactImport} />}
          {step === 5 && <CompletionSlide counts={counts} onFinish={finish} />}
        </div>

        {step >= 2 && step <= 4 && (
          <div className="mt-6 flex items-center justify-between">
            <button type="button" onClick={back} className="text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
              Back
            </button>
            <button type="button" onClick={next} className="text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
              Skip
            </button>
          </div>
        )}

        {step < TOTAL_STEPS - 1 && (
          <div className="mt-4 text-center">
            <button type="button" onClick={skipAll} className="text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
              Skip all
            </button>
          </div>
        )}
      </div>

      <style jsx>{`
        .onb-transition-slide {
          transition: transform 0.2s ease-out, opacity 0.2s ease-out;
        }
        .onb-slide-enter-left { animation: onbSlideInLeft 0.2s ease-out forwards; }
        .onb-slide-enter-right { animation: onbSlideInRight 0.2s ease-out forwards; }
        .onb-slide-exit-left { animation: onbSlideOutLeft 0.2s ease-out forwards; }
        .onb-slide-exit-right { animation: onbSlideOutRight 0.2s ease-out forwards; }
        @keyframes onbSlideInLeft { from { transform: translateX(30px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes onbSlideInRight { from { transform: translateX(-30px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes onbSlideOutLeft { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-30px); opacity: 0; } }
        @keyframes onbSlideOutRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(30px); opacity: 0; } }
        .animate-fade-in { animation: onbFadeIn 0.3s ease-out forwards; }
        @keyframes onbFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .celebration-check { animation: onbCelebrationPop 0.5s ease-out forwards; }
        @keyframes onbCelebrationPop { 0% { transform: scale(0); opacity: 0; } 60% { transform: scale(1.2); } 100% { transform: scale(1); opacity: 1; } }
      `}</style>
    </div>
  )
}
