'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { useBirthdaysEnabled } from '@/app/hooks/use-birthdays-enabled'
import { useNotesEnabled } from '@/app/hooks/use-notes-enabled'
import { usePlanningDisposition, usePlanningEnabled } from '@/app/hooks/use-planning-enabled'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { requestBirthdayReconcile } from '@/app/lib/birthday-calendar/trigger'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useExperimentalStore, type PlanningDisposition } from '@/app/stores/use-experimental-store'
import { LanguageSetting } from './language-setting'

export default function ExperimentalSettingsPage() {
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  return <ExperimentalSettings key={fingerprint ?? 'no-account'} />
}

function ExperimentalSettings() {
  const enabled = useNotesEnabled()
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  const ready = useEtebaseStore((state) => !!state.account && state.isInitialized && !state.restoreBlocked && state.domainLoadState.notes === 'loaded')
  const hydrated = useExperimentalStore((state) => state.hydrated)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  const toggle = async () => {
    if (!fingerprint || !hydrated || inFlight.current || (!enabled && !ready)) return
    const epoch = getAccountEpoch()
    const isCurrent = () => isCurrentAccountEpoch(epoch) && useEtebaseStore.getState().accountFingerprint === fingerprint
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      if (!enabled && useEtebaseStore.getState().collections.notes.length === 0) {
        if (!useAuthStore.getState().canWrite()) {
          setError('Your account is currently read-only. You can enable Notes after write access is restored.')
          return
        }
        const uid = await useEtebaseStore.getState().createCollection('notes', 'Personal Notes', '#f59e0b')
        if (!isCurrent()) return
        if (!uid) {
          setError('Could not create your notebook. Sync and try again.')
          return
        }
      }
      if (isCurrent()) useExperimentalStore.getState().setNotesEnabled(fingerprint, !enabled)
    } catch {
      if (isCurrent()) setError('Could not save this setting. Check that browser storage is available and try again.')
    } finally {
      inFlight.current = false
      if (isCurrent()) setBusy(false)
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">Experimental</h2>
        <p className="mt-1 text-sm text-[rgb(var(--muted))]">Try optional features that are still being developed.</p>
      </div>
      <div className="space-y-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="enable-notes" className="font-medium text-[rgb(var(--foreground))]">Enable Notes</label>
          <input
            id="enable-notes"
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={busy || !fingerprint || !hydrated || (!enabled && !ready)}
            onChange={() => { void toggle() }}
            aria-describedby="notes-experiment-description"
            className="h-5 w-5 shrink-0 accent-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
          />
        </div>
        <p id="notes-experiment-description" className="text-sm text-[rgb(var(--muted))]">
          End-to-end encrypted Markdown notes. Experimental and available in the web app only.
          This choice is saved for this account in this browser, not synced to other devices.
          Turning Notes off hides the feature without deleting your notes or interrupting sync.
        </p>
        {!enabled && !ready && <p role="status" className="text-sm text-[rgb(var(--muted))]">Finish syncing your account before enabling Notes.</p>}
        {busy && <p role="status" className="text-sm text-[rgb(var(--muted))]">Updating Notes…</p>}
        {error && <p role="alert" className="text-sm text-[rgb(var(--foreground))]">{error}</p>}
        {enabled && <Link href="/notes" className="inline-block text-sm text-[rgb(var(--primary))] underline">Open Notes</Link>}
      </div>
      <BirthdaysSetting />
      <PlanningSetting />
      <LanguageSetting />
    </section>
  )
}

function BirthdaysSetting() {
  const enabled = useBirthdaysEnabled()
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  const hydrated = useExperimentalStore((state) => state.hydrated)
  const [error, setError] = useState('')

  const toggle = () => {
    if (!fingerprint || !hydrated) return
    setError('')
    try {
      useExperimentalStore.getState().setBirthdaysEnabled(fingerprint, !enabled)
    } catch {
      setError('Could not save this setting. Check that browser storage is available and try again.')
      return
    }
    // A Birthdays calendar already turned on elsewhere is maintained straight away.
    if (!enabled) requestBirthdayReconcile(getAccountEpoch())
  }

  return (
    <div className="space-y-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="enable-birthdays" className="font-medium text-[rgb(var(--foreground))]">Birthdays calendar</label>
        <input
          id="enable-birthdays"
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={!fingerprint || !hydrated}
          onChange={toggle}
          aria-describedby="birthdays-experiment-description"
          className="h-5 w-5 shrink-0 accent-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        />
      </div>
      <p id="birthdays-experiment-description" className="text-sm text-[rgb(var(--muted))]">
        Adds a Birthdays calendar made from your contacts&rsquo; birthdays. You can turn it on in the calendar list.
        This choice is saved for this account in this browser, not synced to other devices.
      </p>
      {error && <p role="alert" className="text-sm text-[rgb(var(--foreground))]">{error}</p>}
    </div>
  )
}

const PLANNING_CHOICES: Array<{ value: PlanningDisposition; label: string }> = [
  { value: 'label', label: 'Keep it open and add the label \u201cScheduled\u201d' },
  { value: 'complete', label: 'Mark it completed' },
  { value: 'delete', label: 'Delete the task' },
]

function PlanningSetting() {
  const enabled = usePlanningEnabled()
  const disposition = usePlanningDisposition()
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  const hydrated = useExperimentalStore((state) => state.hydrated)
  const [error, setError] = useState('')
  const disabled = !fingerprint || !hydrated

  const save = (change: () => void) => {
    if (disabled) return
    setError('')
    try {
      change()
    } catch {
      setError('Could not save this setting. Check that browser storage is available and try again.')
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="enable-planning" className="font-medium text-[rgb(var(--foreground))]">Planning view</label>
        <input
          id="enable-planning"
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={disabled}
          onChange={() => save(() => useExperimentalStore.getState().setPlanningEnabled(fingerprint!, !enabled))}
          aria-describedby="planning-experiment-description"
          className="h-5 w-5 shrink-0 accent-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        />
      </div>
      <p id="planning-experiment-description" className="text-sm text-[rgb(var(--muted))]">
        Adds a Plan button to the week view on larger screens. It shows your open tasks next to the calendar, and you can
        drag a task into a time slot to add a 30-minute event. These choices are saved for this account in this browser,
        not synced to other devices.
      </p>
      {enabled && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-[rgb(var(--foreground))]">When a task is added to the calendar</legend>
          {PLANNING_CHOICES.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2 text-sm text-[rgb(var(--foreground))]">
              <input
                type="radio"
                name="planning-disposition"
                value={value}
                checked={disposition === value}
                disabled={disabled}
                onChange={() => save(() => useExperimentalStore.getState().setPlanningDisposition(fingerprint!, value))}
                className="accent-emerald-600"
              />
              {label}
            </label>
          ))}
          <p className="text-sm text-[rgb(var(--muted))]">
            The task is only changed after the event is saved to the server. If you are offline, the event is saved for
            later and the task is left as it is. Changes to the task sync to your other devices.
          </p>
          {disposition === 'delete' && (
            <p role="note" className="text-sm text-[rgb(var(--foreground))]">
              Deleting cannot be undone. The event keeps the task&rsquo;s title, notes, link, location and labels, but not
              its list, priority, due date, progress or reminders.
            </p>
          )}
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm text-[rgb(var(--foreground))]">{error}</p>}
    </div>
  )
}
