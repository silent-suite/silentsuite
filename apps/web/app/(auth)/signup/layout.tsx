import Script from 'next/script'
import type { ReactNode } from 'react'

export default function SignupLayout({
  children,
}: {
  children: ReactNode
}) {
  return (
    <>
      {/* Privacy-friendly, cookieless analytics for the unauthenticated signup funnel only. */}
      <Script
        src="https://plausible.silentsuite.io/js/pa-ZqdDjldOcs8obwiOHgHSR.js"
        strategy="afterInteractive"
      />
      <Script id="plausible-init" strategy="afterInteractive">
        {`window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`}
      </Script>
      {children}
    </>
  )
}
