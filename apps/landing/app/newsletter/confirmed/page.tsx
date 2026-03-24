import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Subscription Confirmed | SilentSuite',
  description: 'Your newsletter subscription has been confirmed.',
}

export default function Confirmed() {
  return (
    <main className="min-h-screen bg-navy-950 text-white flex items-center justify-center pt-16">
      <div className="max-w-lg mx-auto px-6 text-center">
        <div className="p-10 rounded-2xl bg-teal-400/10 border border-teal-400/30">
          <div className="text-5xl mb-6" aria-hidden="true">&#10003;</div>
          <h1 className="text-2xl font-bold mb-3 text-teal-400">
            You&apos;re confirmed.
          </h1>
          <p className="text-navy-300 mb-6">
            Your email has been verified and you&apos;re subscribed to
            SilentSuite updates. We&apos;ll keep you posted on new features and releases.
          </p>
          <p className="text-navy-500 text-sm mb-8">
            You can unsubscribe at any time.
          </p>
          <Link
            href="/"
            className="inline-block px-6 py-3 bg-teal-400 hover:bg-teal-500 text-navy-950 font-semibold rounded-lg transition-colors"
          >
            Back to SilentSuite
          </Link>
        </div>
      </div>
    </main>
  )
}
