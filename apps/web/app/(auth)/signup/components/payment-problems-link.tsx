/** The single, deliberately quiet support entry beside payable controls. */
export const PAYMENT_SUPPORT_HREF = 'mailto:support@silentsuite.io'

export function PaymentProblemsLink() {
  return (
    <a href={PAYMENT_SUPPORT_HREF} className="block text-center text-xs text-[rgb(var(--muted))] underline hover:text-[rgb(var(--foreground))]">
      Problems with payment?
    </a>
  )
}
