'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

function ErrorContent() {
  const searchParams = useSearchParams()
  const reason = searchParams.get('reason')

  const messages: Record<string, { title: string; body: string }> = {
    'missing-token': {
      title: 'Invalid link',
      body: 'The confirmation link appears to be incomplete. Please check the link in your email and try again.',
    },
    'invalid-token': {
      title: 'Link expired or already used',
      body: 'This confirmation link is no longer valid. It may have expired or already been used. Please sign up again if needed.',
    },
    'server-error': {
      title: 'Something went wrong',
      body: 'We couldn\'t process your confirmation right now. Please try again later or contact us.',
    },
  }

  const msg = messages[reason || ''] || messages['server-error']

  return (
    <div className="max-w-lg mx-auto px-6 text-center">
      <div className="p-10 rounded-2xl bg-red-400/10 border border-red-400/30">
        <h1 className="text-2xl font-bold mb-3 text-red-400">
          {msg.title}
        </h1>
        <p className="text-navy-300 mb-6">{msg.body}</p>
        <p className="text-navy-500 text-sm mb-8">
          Need help? Email{' '}
          <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
            info@silentsuite.io
          </a>
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-teal-400 hover:bg-teal-500 text-navy-950 font-semibold rounded-lg transition-colors"
        >
          Back to SilentSuite
        </Link>
      </div>
    </div>
  )
}

export default function WaitlistError() {
  return (
    <main className="min-h-screen bg-navy-950 text-white flex items-center justify-center pt-16">
      <Suspense fallback={
        <div className="max-w-lg mx-auto px-6 text-center">
          <div className="p-10 rounded-2xl bg-navy-800 border border-navy-700">
            <p className="text-navy-300">Loading...</p>
          </div>
        </div>
      }>
        <ErrorContent />
      </Suspense>
    </main>
  )
}
