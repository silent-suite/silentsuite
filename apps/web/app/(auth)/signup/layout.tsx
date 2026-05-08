import type { ReactNode } from 'react'
import { SignupAnalytics } from './signup-analytics'

export default function SignupLayout({
  children,
}: {
  children: ReactNode
}) {
  return (
    <>
      <SignupAnalytics />
      {children}
    </>
  )
}
