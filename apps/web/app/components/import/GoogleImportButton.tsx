'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { GOOGLE_IMPORT_CLIENT_ID } from '@/app/lib/config'
import type { GoogleCalendarImport } from '@/app/lib/google-import/importer'
import type { ProviderImportVCard } from '@/app/lib/google-import/contact-mapper'

type Importer = typeof import('@/app/lib/google-import/importer')

type Props =
  | { kind: 'calendar'; disabled?: boolean; onLoaded: (result: GoogleCalendarImport) => void; onError: (message: string) => void }
  | { kind: 'contacts'; disabled?: boolean; onLoaded: (result: ProviderImportVCard[]) => void; onError: (message: string) => void }

export function googleImportEnabled(clientId: string = GOOGLE_IMPORT_CLIENT_ID): boolean {
  return clientId.trim().length > 0
}

/** Where a user removes the permission at Google; ending the import does not revoke it. */
export const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections'

/** Name and features shared with app/lib/google-import/oauth.ts, which navigates this popup. */
const POPUP_NAME = 'silentsuite-google-import'
const POPUP_FEATURES = 'popup,width=520,height=680'

/**
 * "Import from Google": hidden unless the build has a Google client ID. The importer code is
 * loaded only on click. A blank popup opens synchronously in the click, so loading that code
 * cannot cost the user gesture; the importer then sends it to Google.
 */
export default function GoogleImportButton(props: Props) {
  const [busy, setBusy] = useState(false)
  const run = useRef<{ controller: AbortController; importer: Importer | null } | null>(null)

  const cancel = useCallback(() => {
    const current = run.current
    run.current = null
    current?.controller.abort()
    current?.importer?.cancelGoogleImport()
    setBusy(false)
  }, [])

  // Leaving the page ends the run and drops any token.
  useEffect(() => () => {
    const current = run.current
    run.current = null
    current?.controller.abort()
    current?.importer?.cancelGoogleImport()
  }, [])

  const start = useCallback(async () => {
    if (run.current) return
    const popup = window.open('about:blank', POPUP_NAME, POPUP_FEATURES)
    const controller = new AbortController()
    const current: { controller: AbortController; importer: Importer | null } = { controller, importer: null }
    run.current = current
    setBusy(true)
    try {
      const importer = await import('@/app/lib/google-import/importer')
      current.importer = importer
      if (run.current !== current) {
        importer.cancelGoogleImport()
        try { popup?.close() } catch { /* already gone */ }
        return
      }
      const options = { clientId: GOOGLE_IMPORT_CLIENT_ID, popup, signal: controller.signal }
      if (props.kind === 'calendar') {
        const result = await importer.loadGoogleCalendars(options)
        if (run.current === current) props.onLoaded(result)
      } else {
        const result = await importer.loadGoogleContacts(options)
        if (run.current === current) props.onLoaded(result)
      }
    } catch (err) {
      try { popup?.close() } catch { /* already gone */ }
      if (run.current === current) {
        // Only our own fixed messages are shown; nothing about the error is logged.
        const known = err instanceof Error && ['GoogleAuthError', 'GoogleApiError', 'GoogleImportError'].includes(err.name)
        props.onError(known ? err.message : 'The Google import failed. Please try again.')
      }
    } finally {
      if (run.current === current) {
        run.current = null
        setBusy(false)
      }
    }
  }, [props])

  if (!googleImportEnabled()) return null

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
          {busy ? 'Reading from Google...' : 'Import from Google'}
        </button>
        {busy && (
          <button type="button" onClick={cancel} className="text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]">
            Cancel
          </button>
        )}
      </div>
      <p className="text-xs text-[rgb(var(--muted))]">
        After the import, SilentSuite keeps no access to your Google account. Google still lists the permission until you remove it under{' '}
        <a
          href={GOOGLE_CONNECTIONS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-500 hover:text-emerald-400"
        >
          third-party connections
        </a>
        .
      </p>
    </div>
  )
}
