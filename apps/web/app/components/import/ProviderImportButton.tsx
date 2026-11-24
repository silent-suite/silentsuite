'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { GoogleCalendarImport } from '@/app/lib/google-import/importer'
import type { ProviderImportVCard } from '@/app/lib/google-import/contact-mapper'

/*
 * The shared "Import from <provider>" button (#48). The provider's importer code is loaded
 * only on click. A blank popup opens synchronously in the click, so loading that code cannot
 * cost the user gesture; the importer then sends it to the provider's sign-in page.
 */

export type ProviderImportButtonProps =
  | { kind: 'calendar'; disabled?: boolean; onLoaded: (result: GoogleCalendarImport) => void; onError: (message: string) => void }
  | {
      kind: 'contacts'
      disabled?: boolean
      /** Called when the user starts a load, before any await, so the caller can order it against other selections. */
      onStart?: () => void
      onLoaded: (result: ProviderImportVCard[]) => void
      onError: (message: string) => void
    }

/** What a provider's importer module offers the button. */
export interface ProviderImporter {
  loadCalendars: (options: { clientId: string; popup: Window | null; signal: AbortSignal }) => Promise<GoogleCalendarImport>
  loadContacts: (options: { clientId: string; popup: Window | null; signal: AbortSignal }) => Promise<ProviderImportVCard[]>
  cancel: () => void
}

export interface ProviderDescriptor {
  /** "Google" or "Microsoft", as shown in the button. */
  label: string
  clientId: string
  popupName: string
  popupFeatures: string
  load: () => Promise<ProviderImporter>
  /** Error names whose messages are our own fixed text and may be shown. */
  knownErrors: readonly string[]
  failedMessage: string
  notice: ReactNode
}

export function providerImportEnabled(clientId: string | undefined): boolean {
  return (clientId ?? '').trim().length > 0
}

export default function ProviderImportButton({ provider, ...props }: ProviderImportButtonProps & { provider: ProviderDescriptor }) {
  const [busy, setBusy] = useState(false)
  const run = useRef<{ controller: AbortController; importer: ProviderImporter | null } | null>(null)

  const cancel = useCallback(() => {
    const current = run.current
    run.current = null
    current?.controller.abort()
    current?.importer?.cancel()
    setBusy(false)
  }, [])

  // Leaving the page ends the run and drops any token.
  useEffect(() => () => {
    const current = run.current
    run.current = null
    current?.controller.abort()
    current?.importer?.cancel()
  }, [])

  const start = useCallback(async () => {
    if (run.current) return
    const popup = window.open('about:blank', provider.popupName, provider.popupFeatures)
    const controller = new AbortController()
    const current: { controller: AbortController; importer: ProviderImporter | null } = { controller, importer: null }
    run.current = current
    if (props.kind === 'contacts') props.onStart?.()
    setBusy(true)
    try {
      const importer = await provider.load()
      current.importer = importer
      if (run.current !== current) {
        importer.cancel()
        try { popup?.close() } catch { /* already gone */ }
        return
      }
      const options = { clientId: provider.clientId, popup, signal: controller.signal }
      if (props.kind === 'calendar') {
        const result = await importer.loadCalendars(options)
        if (run.current === current) props.onLoaded(result)
      } else {
        const result = await importer.loadContacts(options)
        if (run.current === current) props.onLoaded(result)
      }
    } catch (err) {
      try { popup?.close() } catch { /* already gone */ }
      if (run.current === current) {
        // Only our own fixed messages are shown; nothing about the error is logged.
        const known = err instanceof Error && provider.knownErrors.includes(err.name)
        props.onError(known ? err.message : provider.failedMessage)
      }
    } finally {
      if (run.current === current) {
        run.current = null
        setBusy(false)
      }
    }
  }, [props, provider])

  if (!providerImportEnabled(provider.clientId)) return null

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={start}
          disabled={busy || props.disabled}
          className="inline-flex items-center gap-2 rounded-lg border border-[rgb(var(--border))] px-4 py-2 text-sm font-medium text-[rgb(var(--foreground))] transition-colors hover:bg-[rgb(var(--surface))] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? `Reading from ${provider.label}...` : `Import from ${provider.label}`}
        </button>
        {busy && (
          <button type="button" onClick={cancel} className="text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]">
            Cancel
          </button>
        )}
      </div>
      <p className="text-xs text-[rgb(var(--muted))]">{provider.notice}</p>
    </div>
  )
}
