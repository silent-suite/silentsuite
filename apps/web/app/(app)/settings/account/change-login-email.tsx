'use client'

import { useState, type FormEvent } from 'react'
import { useLoginEmailChangeEnabled } from '@/app/hooks/use-login-email-change-enabled'
import { isHostedAccount, requestLoginEmailChange, type LoginEmailRequestResult } from '@/app/lib/login-email-change'
import { useAuthStore } from '@/app/stores/use-auth-store'

const DEVICE_NOTE = 'Phones and the desktop Bridge that are signed in keep syncing. To use the new email there, sign out and sign in again.'
const RECEIPT_NOTE = 'Card receipts from the payment provider may still go to your old address.'

const MESSAGES: Record<LoginEmailRequestResult, string> = {
  sent: 'Check your new inbox and open the link there to finish the change.',
  unknown: 'If that address can receive email, a confirmation link is on its way. Open it to finish the change.',
  rejected: 'We could not deliver email to that address. Check it and try again.',
  unavailable: 'This account needs support to change its email. Contact support and we will help.',
  'invalid-email': 'Enter a valid email address.',
  'same-email': 'That is already your login email.',
  'wrong-password': 'Current password is incorrect.',
  'rate-limited': 'Too many attempts. Please try again later.',
  'try-again': 'The server is busy. Please try again in a few minutes.',
  'account-changed': 'Your account changed while this was running. Please try again.',
  failed: 'Could not start the change. Please try again.',
}

export function ChangeLoginEmail() {
  const enabled = useLoginEmailChangeEnabled()
  const user = useAuthStore((state) => state.user)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LoginEmailRequestResult | null>(null)

  if (!enabled || !isHostedAccount(user)) return null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const outcome = await requestLoginEmailChange(email, password)
      setResult(outcome)
      if (outcome === 'sent' || outcome === 'unknown') {
        setPassword('')
      }
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-[rgb(var(--border))] px-3 py-1.5 text-sm text-[rgb(var(--foreground))] hover:border-[rgb(var(--muted))] max-md:min-h-[44px]"
      >
        Change email
      </button>
    )
  }

  const pending = result === 'sent' || result === 'unknown'

  return (
    <form
      role="dialog"
      aria-labelledby="change-login-email-title"
      onSubmit={submit}
      className="space-y-3 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3"
    >
      <p id="change-login-email-title" className="text-sm font-medium text-[rgb(var(--foreground))]">Change login email</p>
      <p className="text-xs text-[rgb(var(--muted))]">
        You will sign in with the new address. We send a link there; nothing changes until you open it.
      </p>
      <div className="space-y-1">
        <label htmlFor="new-login-email" className="block text-xs text-[rgb(var(--muted))]">New email</label>
        <input
          id="new-login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-sm text-[rgb(var(--foreground))]"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="login-email-password" className="block text-xs text-[rgb(var(--muted))]">Current password</label>
        <input
          id="login-email-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-sm text-[rgb(var(--foreground))]"
        />
      </div>
      {result && (
        <p role={pending ? 'status' : 'alert'} className={`text-xs ${pending ? 'text-[rgb(var(--primary))]' : 'text-red-400'}`}>
          {MESSAGES[result]}
        </p>
      )}
      <p className="text-xs text-[rgb(var(--muted))]">{DEVICE_NOTE} {RECEIPT_NOTE}</p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 max-md:min-h-[44px]"
        >
          {busy ? 'Sending...' : 'Send confirmation link'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setResult(null); setPassword('') }}
          className="rounded-md border border-[rgb(var(--border))] px-3 py-1.5 text-sm text-[rgb(var(--foreground))] max-md:min-h-[44px]"
        >
          Close
        </button>
      </div>
    </form>
  )
}
