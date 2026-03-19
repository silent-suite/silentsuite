import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms and Conditions | SilentSuite',
  description: 'Terms and conditions for using the SilentSuite encrypted productivity service.',
}

export default function Terms() {
  return (
    <main className="min-h-screen bg-navy-950 text-white pt-16">
      {/* Header */}
      <div className="border-b border-navy-700">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <Link href="/" className="text-teal-400 hover:underline text-sm">
            &larr; Back to SilentSuite
          </Link>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Terms and Conditions</h1>
        <p className="text-navy-400 mb-12">Last updated: March 17, 2026</p>

        <div className="prose prose-invert max-w-none space-y-8 text-navy-200">

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              1. Introduction
            </h2>
            <p>
              These Terms and Conditions (&quot;Terms&quot;) govern your use of the
              SilentSuite service (&quot;Service&quot;), operated by
              SilentSuite (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;).
            </p>
            <p className="mt-2">
              By creating an account or using the Service, you agree to these
              Terms. If you do not agree, please do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              2. Service description
            </h2>
            <p>
              SilentSuite provides an end-to-end encrypted synchronisation
              service for calendars, contacts, and tasks. Data is encrypted on
              your device before being transmitted to our servers. We have no
              technical ability to decrypt your data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              3. Account and password
            </h2>
            <p>
              You are responsible for maintaining the confidentiality of your
              account credentials. Your password is used to derive your
              encryption keys. Because of the zero-knowledge design, we cannot
              reset your password or recover your data if you forget it.
            </p>
            <p className="mt-2">
              You are responsible for all activity that occurs under your
              account. Please notify us immediately at{' '}
              <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
                info@silentsuite.io
              </a>{' '}
              if you suspect unauthorised use.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              4. Subscriptions and payment
            </h2>
            <p>
              Paid plans are billed monthly or annually via Stripe. Prices are
              displayed in EUR and include applicable taxes. You may cancel at
              any time; your subscription will remain active until the end of
              the current billing period.
            </p>
            <p className="mt-2">
              We offer a 30-day money-back guarantee on all paid plans. If you
              are not satisfied, contact us within 30 days of your first
              payment for a full refund.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              5. Free trial
            </h2>
            <p>
              New accounts may include a 30-day free trial period. At the end
              of the trial, your account will be placed in a read-only state
              unless you subscribe to a paid plan. You may export your data at
              any time.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              6. Data ownership and portability
            </h2>
            <p>
              Your data belongs to you. We do not claim any ownership or
              license over the content you store in SilentSuite. You may
              export your data in standard formats (ICS, VCF) at any time
              from the Settings page.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              7. Acceptable use
            </h2>
            <p>
              You agree not to use the Service for any unlawful purpose or in
              any way that could damage, disable, or impair the Service. We
              reserve the right to suspend or terminate accounts that violate
              these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              8. Limitation of liability
            </h2>
            <p>
              The Service is provided &quot;as is&quot; without warranties of any
              kind. To the maximum extent permitted by applicable law, we
              shall not be liable for any indirect, incidental, or
              consequential damages arising from your use of the Service.
            </p>
            <p className="mt-2">
              Due to the end-to-end encryption design, we cannot recover data
              if you lose your password. We are not liable for data loss
              resulting from lost credentials.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              9. Changes to these Terms
            </h2>
            <p>
              We may update these Terms from time to time. Changes will be
              posted on this page with an updated date. For material changes,
              we will notify registered users via email. Continued use of the
              Service after changes constitutes acceptance of the new Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              10. Governing law
            </h2>
            <p>
              These Terms are governed by the applicable laws of the
              jurisdiction in which the operator is established. Any disputes
              shall be resolved in accordance with the applicable laws,
              except where mandatory consumer protection laws provide
              otherwise.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              11. Contact
            </h2>
            <p>
              For any questions regarding these Terms, please contact us at{' '}
              <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
                info@silentsuite.io
              </a>.
            </p>
          </section>

        </div>
      </div>
    </main>
  )
}
