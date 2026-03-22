import { Calendar, Users, CheckSquare, Smartphone, WifiOff, Github, Download, Monitor } from 'lucide-react'

const features = [
  {
    icon: Calendar,
    title: 'Calendar sync',
    description: 'Keep your calendar in sync across all your devices with zero-knowledge encryption. Nobody can read your events but you.',
  },
  {
    icon: Users,
    title: 'Contact sync',
    description: 'Your address book, synced and encrypted. Names, numbers, emails, all private by default.',
  },
  {
    icon: CheckSquare,
    title: 'Task management',
    description: 'Sync your to-dos across devices. Plan your day without handing your goals to a data broker.',
  },
  {
    icon: Smartphone,
    title: 'Cross-platform',
    description: 'Web, iOS, and Android. Installable as a PWA on any device for a native app experience.',
  },
  {
    icon: WifiOff,
    title: 'Offline-first',
    description: 'Your data is always available locally. Sync happens in the background when you reconnect.',
  },
  {
    icon: Download,
    title: 'Data export',
    description: 'Export your calendars (ICS), contacts (VCF), or everything (ZIP) at any time. No lock-in, no data hostage.',
  },
  {
    icon: Monitor,
    title: 'Self-hosting',
    description: 'Run the SilentSuite server and PostgreSQL on your own infrastructure. Connect via app.silentsuite.io or the mobile apps.',
  },
  {
    icon: Github,
    title: 'Open source',
    description: 'Fully auditable code. Self-host or use our managed service. Your choice.',
  },
]

export default function Features() {
  return (
    <section id="features" className="py-28 bg-navy-900 text-white">
      <div className="max-w-5xl mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Everything you need. Nothing you don&apos;t.
          </h2>
          <p className="text-xl text-navy-300 max-w-2xl mx-auto">
            SilentSuite replaces iCloud and Google sync with an open,
            encrypted alternative that just works.
          </p>
        </div>

        <div className="grid md:grid-cols-4 gap-8">
          {features.map(({ icon: Icon, title, description }) => (
            <div key={title} className="p-6 rounded-xl bg-navy-950 border border-navy-700 hover:border-teal-400/30 transition-colors">
              <div className="w-10 h-10 rounded-lg bg-teal-400/10 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5 text-teal-400" />
              </div>
              <h3 className="font-semibold text-lg mb-2">{title}</h3>
              <p className="text-navy-300 text-sm leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
