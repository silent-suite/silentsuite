'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { useNotesEnabled } from '@/app/hooks/use-notes-enabled'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'

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
    </section>
  )
}
