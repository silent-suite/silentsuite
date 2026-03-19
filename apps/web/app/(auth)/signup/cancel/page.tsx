'use client'

import Link from 'next/link'
import { XCircle } from 'lucide-react'
import { Button } from '@silentsuite/ui'

export default function SignupCancelPage() {
  return (
    <div className="max-w-md mx-auto space-y-6 text-center">
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-full bg-[rgb(var(--surface))] p-4">
          <XCircle className="h-12 w-12 text-[rgb(var(--muted))]" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          You didn&apos;t complete checkout
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          No worries — you can try again or continue without a subscription.
        </p>
      </div>

      <div className="space-y-3">
        <Link href="/signup/plan">
          <Button className="w-full">Try again</Button>
        </Link>
        <Link
          href="/"
          className="block text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
        >
          Continue without subscription
        </Link>
      </div>
    </div>
  )
}
