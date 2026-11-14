'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, buttonVariants } from '@silentsuite/ui'
import { DISPLAY_VERSION } from '@/app/lib/constants'
import { isCustomServer, isSelfHosted } from '@/app/lib/self-hosted'
import { readRestoreDiagnostics } from '@/app/lib/sync-restore-diagnostics'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import {
  DESCRIPTION_MAX_CHARS,
  PRIVACY_POLICY_URL,
  REPORT_RELAY_URL,
  REPORT_SEND_TIMEOUT_MS,
  SUMMARY_MAX_CHARS,
  SUPPORT_EMAIL,
  buildProblemReport,
  buildWebDiagnostics,
  codePoints,
  formatDiagnostics,
  formatReportText,
  reportMailtoHref,
  type ReportKind,
  type WebDiagnostics,
} from '@/app/lib/problem-report'

function storedServerIsCustom(): boolean {
  if (isSelfHosted) return true
  try {
    return isCustomServer(window.localStorage.getItem('silentsuite-server-url') ?? undefined)
  } catch {
    return false
  }
}

/** Reads the current store values once; the result is frozen for the preview and the send. */
function collectDiagnostics(): WebDiagnostics {
  const sync = useSyncStore.getState()
  return buildWebDiagnostics({
    appVersion: DISPLAY_VERSION,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    customServer: storedServerIsCustom(),
    isOnline: sync.isOnline,
    syncStatus: sync.syncStatus,
    syncError: sync.error,
    lastSyncedAt: sync.lastSyncedAt,
    domainLoadState: useEtebaseStore.getState().domainLoadState,
    restoreSnapshot: readRestoreDiagnostics(),
    nowMs: Date.now(),
  })
}

type SendState = 'editing' | 'sending' | 'sent' | 'unconfirmed'

const fieldClass =
  'w-full rounded-md border border-[rgb(var(--border))] bg-transparent px-3 py-2 text-sm text-[rgb(var(--foreground))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-500'

export default function ReportProblemPage() {
  const t = useTranslations('SettingsReport')
  const [kind, setKind] = useState<ReportKind>('problem')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [diagnostics, setDiagnostics] = useState<WebDiagnostics | null>(null)
  const [sendState, setSendState] = useState<SendState>('editing')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const sendStarted = useRef(false)

  // Built from local state only (no network). Frozen when the preview is shown; Send uses it unchanged.
  // Collected after mount because the stores and storage exist only in the browser.
  useEffect(() => {
    setDiagnostics(collectDiagnostics())
  }, [])

  const setInclude = (on: boolean) => {
    setIncludeDiagnostics(on)
    setDiagnostics(on ? collectDiagnostics() : null)
  }

  const report = useMemo(
    () => buildProblemReport({ kind, summary, description, contactEmail, diagnostics: includeDiagnostics ? diagnostics : null }),
    [kind, summary, description, contactEmail, includeDiagnostics, diagnostics],
  )
  // Before the mount effect runs, nothing can be sent, emailed or copied.
  const ready = report.ok && (!includeDiagnostics || diagnostics !== null)
  const locked = sendState !== 'editing'

  const chooseKind = (next: ReportKind) => {
    setKind(next)
    setInclude(next === 'problem')
  }

  const send = async () => {
    if (!ready || sendStarted.current) return
    // One request per report: no automatic retries, and no second Send after an unknown outcome.
    sendStarted.current = true
    setSendState('sending')
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), REPORT_SEND_TIMEOUT_MS)
    try {
      const response = await fetch(REPORT_RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: report.body,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      setSendState(response.status === 201 ? 'sent' : 'unconfirmed')
    } catch {
      setSendState('unconfirmed')
    } finally {
      window.clearTimeout(timer)
    }
  }

  const copy = async () => {
    if (!ready || !report.ok) return
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(formatReportText(report.payload))
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
    window.setTimeout(() => setCopyStatus('idle'), 2000)
  }

  const fieldError = (problem: string | undefined) =>
    problem === 'too_long' ? t('errors.tooLong') : problem === 'control_chars' ? t('errors.controlChars') : problem === 'invalid' ? t('errors.email') : null
  const errors = report.ok ? {} : report.errors
  const summaryError = fieldError(errors.summary)
  const descriptionError = fieldError(errors.description)
  const emailError = fieldError(errors.contactEmail)

  if (sendState === 'sent') {
    return (
      <section className="rounded-lg border border-[rgb(var(--border))] p-4">
        <p role="status" className="text-sm text-[rgb(var(--foreground))]">{t('sent')}</p>
      </section>
    )
  }

  const emailAndCopy = (
    <>
      <a
        href={ready && report.ok ? reportMailtoHref(report.payload) : undefined}
        aria-disabled={!ready}
        onClick={(event) => {
          if (!ready) event.preventDefault()
        }}
        className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} max-md:min-h-[44px] ${ready ? '' : 'pointer-events-none opacity-50'}`}
      >
        {t('emailInstead')}
      </a>
      <Button type="button" variant="secondary" size="sm" className="max-md:min-h-[44px]" disabled={!ready} onClick={copy}>
        {copyStatus === 'copied' ? t('copied') : copyStatus === 'failed' ? t('copyFailed') : t('copy')}
      </Button>
    </>
  )

  return (
    <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-5">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">{t('title')}</h2>
        <p className="text-xs text-[rgb(var(--muted))]">{t('intro')}</p>
      </div>

      <fieldset disabled={locked} className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-xs text-[rgb(var(--muted))]">{t('kindLabel')}</legend>
          <div className="flex flex-wrap gap-4">
            {(['problem', 'feature'] as const).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-[rgb(var(--foreground))]">
                <input
                  type="radio"
                  name="report-kind"
                  checked={kind === value}
                  onChange={() => chooseKind(value)}
                  className="accent-emerald-500"
                />
                {value === 'problem' ? t('kindProblem') : t('kindFeature')}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="report-summary" className="text-xs text-[rgb(var(--muted))]">{t('summaryLabel')}</label>
          <Input
            id="report-summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            aria-invalid={summaryError ? true : undefined}
            className="text-[rgb(var(--foreground))]"
          />
          <p className="text-xs text-[rgb(var(--muted))]">
            {summaryError ?? t('counter', { count: codePoints(summary), max: SUMMARY_MAX_CHARS })}
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="report-description" className="text-xs text-[rgb(var(--muted))]">{t('descriptionLabel')}</label>
          <textarea
            id="report-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={6}
            aria-invalid={descriptionError ? true : undefined}
            className={`${fieldClass} resize-y`}
          />
          <p className="text-xs text-[rgb(var(--muted))]">
            {descriptionError ?? t('counter', { count: codePoints(description), max: DESCRIPTION_MAX_CHARS })}
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="report-email" className="text-xs text-[rgb(var(--muted))]">{t('emailLabel')}</label>
          <Input
            id="report-email"
            type="email"
            autoComplete="email"
            value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
            aria-invalid={emailError ? true : undefined}
            className="text-[rgb(var(--foreground))]"
          />
          <p className="text-xs text-[rgb(var(--muted))]">{emailError ?? t('emailHint')}</p>
        </div>

        <div className="space-y-2">
          <label className="flex min-h-11 items-center gap-2 text-sm text-[rgb(var(--foreground))]">
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={(event) => setInclude(event.target.checked)}
              className="h-4 w-4 rounded border-[rgb(var(--border))] accent-emerald-500"
            />
            {t('includeDiagnostics')}
          </label>
          {includeDiagnostics && diagnostics && (
            <div className="space-y-1">
              <p className="text-xs text-[rgb(var(--muted))]">{t('previewHint')}</p>
              <pre
                aria-label={t('previewLabel')}
                data-testid="report-diagnostics-preview"
                className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 font-mono text-xs text-[rgb(var(--foreground))]"
              >
                {formatDiagnostics(diagnostics)}
              </pre>
            </div>
          )}
        </div>
      </fieldset>

      <p className="text-xs text-[rgb(var(--muted))]">
        {t('disclosure', { email: SUPPORT_EMAIL })}{' '}
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="underline">
          {t('privacyLink')}
        </a>
      </p>

      {sendState === 'unconfirmed' && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{t('unconfirmed')}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {sendState !== 'unconfirmed' && (
          <Button type="button" size="sm" className="max-md:min-h-[44px]" disabled={!ready || locked} onClick={send}>
            {sendState === 'sending' ? t('sending') : t('send')}
          </Button>
        )}
        {emailAndCopy}
      </div>
    </section>
  )
}
