import { redirect } from 'next/navigation'

// No checkout return URL points here any more (Stripe returns to /signup,
// /signup/success or /settings/subscription; BTCPay to /signup/pending-payment).
// Old links land back on sign-up instead of a dead end.
export default function SignupCancelPage() {
  redirect('/signup')
}
