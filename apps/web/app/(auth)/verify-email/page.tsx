'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle, XCircle, Clock, Loader2, MailOpen } from 'lucide-react'
import { Button } from '@silentsuite/ui'

type VerifyState = 'loading' | 'success' | 'expired' | 'invalid' | 'error'

export default function VerifyEmailPage() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const fromRedirect = searchParams.get('verified')
  const [state, setState] = useState<VerifyState>('loading')

  useEffect(() => {
    // Handle redirect from billing API (GET /auth/verify-email redirects here)
    if (fromRedirect === 'true') {
      setState('success')
      return
    }
    if (fromRedirect === 'expired') {
      setState('expired')
      return
    }

    // If we have a token, call the billing API to verify
    if (token) {
      const billingApi = process.env.NEXT_PUBLIC_BILLING_API_URL || 'https://api.silentsuite.io'
      // The billing API handles verification via GET and redirects,
      // but we can also call it directly from the client
      fetch(`${billingApi}/auth/verify-email?token=${encodeURIComponent(token)}`, {
        redirect: 'manual', // Don't follow redirects
      })
        .then((res) => {
          if (res.status === 200 || res.type === 'opaqueredirect') {
            setState('success')
          } else if (res.status === 410 || res.status === 400) {
            setState('expired')
          } else {
            setState('invalid')
          }
        })
        .catch(() => {
          setState('error')
        })
      return
    }

    // No token and no redirect status
    setState('invalid')
  }, [token, fromRedirect])

  return (
    <div className="space-y-6 text-center">
      {state === 'loading' && (
        <>
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
              Verifying your email
            </h2>
            <p className="text-sm text-[rgb(var(--muted))]">
              Please wait while we confirm your email address.
            </p>
          </div>
        </>
      )}

      {state === 'success' && (
        <>
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle className="w-8 h-8 text-emerald-500" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
              Email verified
            </h2>
            <p className="text-sm text-[rgb(var(--muted))]">
              Your email address has been confirmed. You can now use all features of SilentSuite.
            </p>
          </div>
          <Link href="/login">
            <Button className="w-full">Continue to login</Button>
          </Link>
        </>
      )}

      {state === 'expired' && (
        <>
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
              <Clock className="w-8 h-8 text-amber-500" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
              Link expired
            </h2>
            <p className="text-sm text-[rgb(var(--muted))]">
              This verification link has expired. Log in to your account and request a new one from your settings.
            </p>
          </div>
          <Link href="/login">
            <Button className="w-full">Go to login</Button>
          </Link>
        </>
      )}

      {state === 'invalid' && (
        <>
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
              <XCircle className="w-8 h-8 text-red-500" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
              Invalid link
            </h2>
            <p className="text-sm text-[rgb(var(--muted))]">
              This verification link is not valid. Please check your email for the correct link, or log in and request a new one.
            </p>
          </div>
          <Link href="/login">
            <Button className="w-full">Go to login</Button>
          </Link>
        </>
      )}

      {state === 'error' && (
        <>
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
              <MailOpen className="w-8 h-8 text-red-500" />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
              Something went wrong
            </h2>
            <p className="text-sm text-[rgb(var(--muted))]">
              We could not verify your email at this time. Please try again later or contact support.
            </p>
          </div>
          <Link href="/login">
            <Button className="w-full">Go to login</Button>
          </Link>
        </>
      )}
    </div>
  )
}
