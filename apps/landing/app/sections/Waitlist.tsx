'use client'

import { useState } from 'react'
import Link from 'next/link'


export default function Waitlist() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [useCase, setUseCase] = useState('')
  const [consent, setConsent] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('loading')

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, useCase, consent }),
      })

      if (res.ok) {
        setStatus('success')
        setEmail('')
        setName('')
        setUseCase('')
        setConsent(false)
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <section id="waitlist" className="py-28 bg-navy-900 text-white">
      <div className="max-w-2xl mx-auto px-6 text-center">
        <h2 className="text-4xl md:text-5xl font-bold mb-6">
          Stay in the loop
        </h2>
        <p className="text-xl text-navy-300 mb-12">
          Get product updates, new feature announcements, and tips on getting the most out of SilentSuite.
        </p>

        {status === 'success' ? (
          <div className="p-8 rounded-2xl bg-teal-400/10 border border-teal-400/30">
            <h3 className="text-xl font-semibold mb-2 text-teal-400">Check your inbox.</h3>
            <p className="text-navy-300">
              We&apos;ve sent you a confirmation email.
              Click the confirmation link to complete your subscription.
            </p>
            <p className="text-navy-500 text-sm mt-3">
              Didn&apos;t receive it? Check your spam folder or try again.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 text-left">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-navy-200 mb-1">
                Name <span className="text-navy-500">(optional)</span>
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="w-full px-4 py-3 rounded-lg bg-navy-950 border border-navy-700 focus:border-teal-400 focus:outline-none text-white placeholder-navy-500 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-navy-200 mb-1">
                Email <span className="text-teal-400">*</span>
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-3 rounded-lg bg-navy-950 border border-navy-700 focus:border-teal-400 focus:outline-none text-white placeholder-navy-500 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="useCase" className="block text-sm font-medium text-navy-200 mb-1">
                How would you use SilentSuite? <span className="text-navy-500">(optional)</span>
              </label>
              <select
                id="useCase"
                value={useCase}
                onChange={(e) => setUseCase(e.target.value)}
                className="w-full px-4 py-3 rounded-lg bg-navy-950 border border-navy-700 focus:border-teal-400 focus:outline-none text-white transition-colors"
              >
                <option value="">Select one&hellip;</option>
                <option value="personal">Personal use</option>
                <option value="family">Family / household</option>
                <option value="smb">Small business / team</option>
                <option value="selfhost">Self-hosting</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="flex items-start gap-3">
              <input
                id="consent"
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-navy-700 bg-navy-950 text-teal-400 focus:ring-teal-400 focus:ring-offset-0 accent-teal-400"
                required
              />
              <label htmlFor="consent" className="text-sm text-navy-300">
                I agree to receive updates about SilentSuite via email.
                I can withdraw my consent at any time. See our{' '}
                <Link href="/privacy" className="text-teal-400 hover:underline">
                  Privacy Policy
                </Link>.
                <span className="text-teal-400"> *</span>
              </label>
            </div>

            {status === 'error' && (
              <p className="text-red-400 text-sm">Something went wrong. Please try again.</p>
            )}

            <button
              type="submit"
              disabled={status === 'loading' || !consent}
              className="w-full py-4 bg-teal-400 hover:bg-teal-500 disabled:opacity-60 text-navy-950 font-semibold rounded-lg transition-colors"
            >
              {status === 'loading' ? 'Subscribing\u2026' : 'Subscribe'}
            </button>

            <p className="text-center text-navy-500 text-xs">
              No spam. We&apos;ll send a confirmation email first. Unsubscribe anytime.
            </p>
          </form>
        )}
      </div>
    </section>
  )
}
