import Link from 'next/link'
import { Shield, Lock, Eye, ArrowRight, ShieldCheck } from 'lucide-react'

export default function Security() {
  return (
    <section id="security" className="py-28 bg-navy-950 text-white">
      <div className="max-w-5xl mx-auto px-6 text-center">

        {/* Encryption badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-teal-400/10 border border-teal-400/20 text-teal-400 text-sm font-semibold mb-8">
          <ShieldCheck className="w-4 h-4" />
          <span>Verified encryption</span>
        </div>

        <h2 className="text-4xl md:text-5xl font-bold mb-6">
          Privacy by design. Not even we can read your data.
        </h2>

        <p className="text-xl text-navy-300 max-w-3xl mx-auto mb-16">
          SilentSuite is built on a simple principle: your personal data should
          remain yours. Calendars, contacts and tasks are encrypted on your
          device before they ever reach the server. Built on the
          Etebase encryption protocol.
        </p>

        <div className="grid md:grid-cols-3 gap-8 text-left">

          <div className="group p-6 rounded-xl bg-navy-900 border border-navy-700 hover:border-teal-400/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-teal-400/10 border border-teal-400/20 flex items-center justify-center mb-5 group-hover:bg-teal-400/20 transition-colors">
              <Lock className="w-6 h-6 text-teal-400" />
            </div>
            <h3 className="font-semibold text-lg mb-3">End&#8209;to&#8209;end encryption</h3>
            <p className="text-navy-300 text-sm leading-relaxed">
              Your data is encrypted locally using XChaCha20-Poly1305 before syncing.
              The server stores encrypted blobs and cannot read the contents.
              By design, not just policy.
            </p>
          </div>

          <div className="group p-6 rounded-xl bg-navy-900 border border-navy-700 hover:border-teal-400/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-teal-400/10 border border-teal-400/20 flex items-center justify-center mb-5 group-hover:bg-teal-400/20 transition-colors">
              <Eye className="w-6 h-6 text-teal-400" />
            </div>
            <h3 className="font-semibold text-lg mb-3">Zero&#8209;knowledge architecture</h3>
            <p className="text-navy-300 text-sm leading-relaxed">
              Your encryption keys are derived from your password using Argon2id
              and never leave your device. The server has zero knowledge of your
              data contents.
            </p>
          </div>

          <div className="group p-6 rounded-xl bg-navy-900 border border-navy-700 hover:border-teal-400/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-teal-400/10 border border-teal-400/20 flex items-center justify-center mb-5 group-hover:bg-teal-400/20 transition-colors">
              <Shield className="w-6 h-6 text-teal-400" />
            </div>
            <h3 className="font-semibold text-lg mb-3">No tracking, ever</h3>
            <p className="text-navy-300 text-sm leading-relaxed">
              No ads, no trackers, and no behavioral profiling. The service is
              funded by subscriptions, not surveillance. Your data stays under
              your control, protected by strict privacy laws (GDPR).
            </p>
          </div>

        </div>

        {/* Credibility bar */}
        <div className="mt-12 flex flex-wrap items-center justify-center gap-6 text-sm text-navy-400">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-teal-400" />
            <span>Built on Etebase protocol</span>
          </div>
          <span className="hidden sm:inline text-navy-700">|</span>
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-teal-400" />
            <span>XChaCha20-Poly1305 + Argon2id</span>
          </div>
          <span className="hidden sm:inline text-navy-700">|</span>
          <span>Open source &amp; auditable</span>
          <span className="hidden sm:inline text-navy-700">|</span>
          <span>Your data, your control. GDPR-compliant infrastructure.</span>
        </div>

        <div className="mt-8">
          <Link
            href="/security"
            className="inline-flex items-center gap-2 text-teal-400 hover:text-teal-300 text-sm font-medium transition-colors"
          >
            Learn more about our security
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

      </div>
    </section>
  )
}
