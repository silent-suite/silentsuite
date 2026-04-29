import { Lock, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { MockAppleCalendar } from './components/MockAppleCalendar'

export default function BridgeSpotlight() {
  return (
    <section
      id="bridge"
      className="relative py-28 bg-navy-900 text-white overflow-hidden"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 50% 50% at 80% 30%, rgba(52, 211, 153, 0.06), transparent 70%)',
        }}
      />

      <div className="relative max-w-6xl mx-auto px-6 grid md:grid-cols-2 gap-12 items-center">
        {/* Copy */}
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-400/10 border border-teal-400/30 text-teal-400 text-xs font-semibold mb-5">
            <Lock className="w-3 h-3" />
            CalDAV / CardDAV bridge
          </div>
          <h2 className="text-3xl md:text-4xl font-bold mb-5 leading-tight">
            Your encrypted calendar, in the apps you already use.
          </h2>
          <p className="text-navy-300 leading-relaxed mb-4">
            SilentSuite ships a standalone bridge that exposes your encrypted
            calendars and contacts to <strong className="text-white">Apple Calendar</strong>,{' '}
            <strong className="text-white">Thunderbird</strong>, and{' '}
            <strong className="text-white">DAVx5</strong> on Android over
            standard CalDAV / CardDAV.
          </p>
          <p className="text-navy-300 leading-relaxed mb-6">
            The bridge runs locally and holds your decryption key. Plaintext
            never leaves your machine. Our server only ever sees ciphertext.
            You get the integration of an open protocol with the privacy of
            zero-knowledge encryption.
          </p>

          <ul className="space-y-2.5 text-sm mb-6">
            <Bullet text="Side-by-side with iCloud, Google, and Exchange calendars." />
            <Bullet text="Native macOS, Windows, Linux. Open source under AGPL-3.0." />
            <Bullet text="Per-device choice — install only on devices you trust." />
          </ul>

          <Link
            href="/blog/walled-gardens-vs-system-integration-encrypted-pim"
            className="inline-flex items-center gap-1.5 text-teal-400 hover:text-teal-300 text-sm font-medium"
          >
            Read the trade-off in detail
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {/* Mockup */}
        <div className="relative">
          <MockAppleCalendar />
          <div className="mt-3 text-center text-xs text-navy-500">
            Apple Calendar with SilentSuite calendars (lock icon = E2EE) and iCloud calendars side by side.
          </div>
        </div>
      </div>
    </section>
  )
}

function Bullet({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 text-navy-200">
      <Lock className="w-3.5 h-3.5 text-teal-400 flex-shrink-0 mt-0.5" />
      <span>{text}</span>
    </li>
  )
}
