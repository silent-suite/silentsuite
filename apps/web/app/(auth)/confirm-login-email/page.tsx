'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { confirmLoginEmailChange, type LoginEmailConfirmResult } from '@/app/lib/login-email-change'

/**
 * Takes the token from the link's fragment (#token=...) and removes it from
 * the address bar before anything else runs, so it never reaches history,
 * referrers or a request URL. Nothing is confirmed until the button is pressed.
 */
function takeTokenFromFragment(): string | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  const token = new URLSearchParams(hash).get('token')
  if (hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
  return token && token.trim() ? token.trim() : null
}

const DEVICE_NOTE = 'Phones and the desktop Bridge stay signed in and keep syncing. They may show your old address until you sign in on them again.'

function contactLine(contactState: string): string {
  switch (contactState) {
    case 'applied':
      return 'Billing emails now go to this address too.'
    case 'pending':
      return 'Billing emails move to this address once your current payment has finished.'
    case 'legacy_hold':
      return 'Billing emails and card receipts keep going to your previous address for now.'
    default:
      return 'Billing emails keep going to your previous contact address. You can change it in Settings.'
  }
}

function refusedLine(reason: string | null): string {
  if (reason === 'taken') return 'That address is already used by another account.'
  if (reason === 'stale' || reason === 'superseded') return 'Your login email changed again after this link was sent. Request a new link if you still want this address.'
  if (reason === 'credentials_changed') return 'Your password changed after this link was sent. Request a new link.'
  return 'This change could not be made. Request a new link from Settings > Account.'
}

export default function ConfirmLoginEmailPage() {
  const tokenRef = useRef<string | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LoginEmailConfirmResult | null>(null)

  useEffect(() => {
    tokenRef.current = takeTokenFromFragment()
    setReady(true)
  }, [])

  const confirm = async () => {
    const token = tokenRef.current
    if (!token || busy) return
    setBusy(true)
    try {
      const outcome = await confirmLoginEmailChange(token)
      setResult(outcome)
      if (outcome.kind !== 'try-again' && outcome.kind !== 'failed') tokenRef.current = null
    } finally {
      setBusy(false)
    }
  }

  let body: React.ReactNode
  if (!ready) {
    body = null
  } else if (result?.kind === 'done') {
    body = (
      <div role="status" className="space-y-2 text-sm text-[rgb(var(--foreground))]">
        <p>Your login email is now <strong>{result.newLogin}</strong>. Use it next time you sign in.</p>
        <p className="text-[rgb(var(--muted))]">{contactLine(result.contactState)}</p>
        <p className="text-[rgb(var(--muted))]">{DEVICE_NOTE}</p>
        <Link href="/" className="inline-block text-[rgb(var(--primary))] underline">Open SilentSuite</Link>
      </div>
    )
  } else if (result?.kind === 'expired') {
    body = <p role="alert" className="text-sm text-[rgb(var(--foreground))]">This link has expired or was already used. Request a new one from Settings &gt; Account.</p>
  } else if (result?.kind === 'refused') {
    body = <p role="alert" className="text-sm text-[rgb(var(--foreground))]">{refusedLine(result.reason)}</p>
  } else if (!tokenRef.current) {
    body = <p role="alert" className="text-sm text-[rgb(var(--foreground))]">This link is incomplete. Open it again from the email, or request a new one from Settings &gt; Account.</p>
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-[rgb(var(--muted))]">Confirm to make this address your login email.</p>
        {result?.kind === 'try-again' && (
          <p role="alert" className="text-sm text-[rgb(var(--foreground))]">We could not finish the change yet. Try again in a moment.</p>
        )}
        {result?.kind === 'failed' && (
          <p role="alert" className="text-sm text-[rgb(var(--foreground))]">Something went wrong. Try again in a moment.</p>
        )}
        <button
          type="button"
          onClick={() => { void confirm() }}
          disabled={busy}
          className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Confirming...' : 'Confirm change'}
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">Change login email</h2>
      {body}
    </div>
  )
}
