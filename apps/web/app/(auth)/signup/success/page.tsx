'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle } from 'lucide-react'
import { MS_PER_DAY } from '@/app/lib/constants'
import { Button } from '@silentsuite/ui'

export default function SignupSuccessPage() {
  const router = useRouter()

  const trialEndDate = new Date(
    Date.now() + 30 * MS_PER_DAY,
  ).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="max-w-md mx-auto space-y-6 text-center">
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-full bg-[rgb(var(--primary))]/10 p-4">
          <CheckCircle className="h-12 w-12 text-[rgb(var(--primary))]" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          Payment successful!
        </h2>
        <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
          Your 30-day free trial has started. You won&apos;t be charged until{' '}
          <span className="font-medium text-[rgb(var(--foreground))]">{trialEndDate}</span>.
        </p>
      </div>

      <Button onClick={() => router.push('/')} className="w-full">
        Set up your workspace
      </Button>
    </div>
  )
}
