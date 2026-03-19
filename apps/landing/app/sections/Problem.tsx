export default function Problem() {
  return (
    <section id="problem" className="py-28 bg-navy-950 text-white">
      <div className="max-w-5xl mx-auto px-6 text-center">

        <h2 className="text-4xl md:text-5xl font-bold mb-6">
          Your personal data shouldn&apos;t belong to Big Tech
        </h2>

        <p className="text-xl text-navy-300 max-w-3xl mx-auto mb-16">
          Calendars, contacts, and tasks contain the most personal information about your life &mdash;
          who you meet, where you go, what you plan. Unlike Google Calendar or Apple iCloud,
          SilentSuite encrypts everything on your device before it ever reaches a server.
          Not even we can read it.
        </p>

        <div className="grid md:grid-cols-3 gap-8 text-left">

          <div className="p-6 rounded-xl bg-navy-900 border border-navy-700">
            <h3 className="font-semibold text-lg mb-3">Data mining</h3>
            <p className="text-navy-300">
              Google scans your calendar and contacts to build advertising profiles.
              With SilentSuite, your data is encrypted &mdash; there&apos;s nothing to mine.
            </p>
          </div>

          <div className="p-6 rounded-xl bg-navy-900 border border-navy-700">
            <h3 className="font-semibold text-lg mb-3">Vendor lock&#8209;in</h3>
            <p className="text-navy-300">
              Once your life lives inside one ecosystem, leaving becomes painful.
              SilentSuite uses open standards (ICS, VCF) and lets you export everything, anytime.
            </p>
          </div>

          <div className="p-6 rounded-xl bg-navy-900 border border-navy-700">
            <h3 className="font-semibold text-lg mb-3">No real encryption</h3>
            <p className="text-navy-300">
              Most services claim security but still have access to your information in plaintext.
              Real privacy requires end&#8209;to&#8209;end encryption &mdash; where only you hold the keys.
            </p>
          </div>

        </div>
      </div>
    </section>
  )
}
