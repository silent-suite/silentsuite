import { ArrowRight } from 'lucide-react'
import { MockGoogleEventCard, MockSilentEventCard } from './components/MockEventCards'

export default function WhoCanRead() {
  return (
    <section
      id="who-can-read"
      className="relative py-28 bg-navy-900 text-white overflow-hidden"
    >
      <div className="relative max-w-6xl mx-auto px-6">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-semibold mb-4">
            The threat model
          </div>
          <h2 className="text-3xl md:text-4xl font-bold mb-4 leading-tight">
            One calendar event. Two providers. Different worlds.
          </h2>
          <p className="text-navy-300 max-w-2xl mx-auto">
            Both calendars say the same thing on screen. The difference is what
            their server can read.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 lg:gap-10 items-start">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-red-400 mb-2 text-center md:text-left">
              In Google Calendar
            </div>
            <MockGoogleEventCard />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-teal-400 mb-2 text-center md:text-left">
              In SilentSuite
            </div>
            <MockSilentEventCard />
          </div>
        </div>

        <div className="mt-12 max-w-3xl mx-auto p-5 rounded-xl border border-white/10 bg-navy-950/50 text-center">
          <p className="text-sm text-navy-300 leading-relaxed">
            Encryption alone changes who reads the data, but it does not change
            what data exists. Health appointments, lawyer meetings, therapist
            visits — they live in your calendar either way. The question is who
            else gets to see them.
          </p>
        </div>

        <div className="mt-8 flex justify-center">
          <a
            href="/blog/who-can-read-your-calendar"
            className="inline-flex items-center gap-1.5 text-teal-400 hover:text-teal-300 text-sm font-medium"
          >
            Who can read your calendar? — full guide
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    </section>
  )
}
