import { Lock, Eye, MapPin, Clock, Server, Calendar } from 'lucide-react'

/**
 * Side-by-side event-card mockups for the "who can read this?" visualizer.
 * The Google card shows fully readable plaintext + an "ad-targetable" badge.
 * The SilentSuite card shows the same event with a green "encrypted" badge,
 * and the server view underneath shows ciphertext bytes instead of fields.
 *
 * Goal: communicate the threat model in a single glance, not a paragraph.
 */

const EVENT = {
  title: 'Therapy session — Dr. Müller',
  time: 'Wed Apr 29 · 14:00 – 15:00',
  location: 'Charité Mitte, Berlin',
  attendee: 'm.muller@charite-berlin.de',
  notes: 'Continue from last week. Bring journal.',
}

export function MockGoogleEventCard() {
  return (
    <div className="rounded-xl bg-white text-[#1f2937] overflow-hidden ring-1 ring-black/5"
      style={{
        boxShadow: '0 20px 40px -20px rgba(15, 23, 42, 0.4)',
      }}
    >
      {/* "URL bar" hint that this is Google */}
      <div className="px-4 py-2 bg-[#f1f3f4] flex items-center gap-2 text-[10px] text-[#5f6368] border-b border-black/5">
        <div className="w-4 h-4 rounded-full bg-white border border-[#dadce0] flex items-center justify-center">
          <Calendar className="w-2.5 h-2.5 text-[#1a73e8]" />
        </div>
        calendar.google.com
      </div>

      {/* Card body */}
      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-3 h-3 rounded-sm bg-[#1a73e8]" />
          <span className="text-[10px] uppercase tracking-wide text-[#5f6368]">Google Calendar</span>
        </div>
        <div className="text-sm font-semibold text-[#202124] leading-snug mb-2">
          {EVENT.title}
        </div>
        <div className="space-y-1 text-xs text-[#3c4043]">
          <Row icon={Clock}    text={EVENT.time} />
          <Row icon={MapPin}   text={EVENT.location} />
          <Row icon={Calendar} text={EVENT.attendee} />
        </div>
        <div className="mt-3 pt-3 border-t border-black/5 text-[11px] text-[#3c4043] italic">
          {EVENT.notes}
        </div>

        <div className="mt-4 flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-red-50 border border-red-200 text-red-700 text-[10px] font-semibold">
          <Eye className="w-3 h-3 flex-shrink-0" />
          <span>Google can read every field. Used for ads + ML.</span>
        </div>
      </div>

      {/* Server view */}
      <div className="px-4 py-3 bg-[#f8f9fa] border-t border-black/5">
        <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-[#5f6368] mb-1.5">
          <Server className="w-2.5 h-2.5" />
          What Google&apos;s server sees
        </div>
        <pre className="text-[10px] text-[#202124] font-mono leading-relaxed whitespace-pre-wrap">{`{
  "summary": "Therapy session — Dr. Müller",
  "location": "Charité Mitte, Berlin",
  "attendees": ["m.muller@charite-berlin.de"]
}`}</pre>
      </div>
    </div>
  )
}

export function MockSilentEventCard() {
  return (
    <div className="rounded-xl bg-navy-900 text-navy-200 overflow-hidden ring-1 ring-teal-400/30"
      style={{
        boxShadow:
          '0 20px 40px -20px rgba(15, 23, 42, 0.6), 0 0 0 1px rgba(52, 211, 153, 0.1)',
      }}
    >
      <div className="px-4 py-2 bg-navy-950 flex items-center gap-2 text-[10px] text-navy-400 border-b border-white/5">
        <div className="w-4 h-4 rounded-full bg-teal-400/15 border border-teal-400/30 flex items-center justify-center">
          <Lock className="w-2 h-2 text-teal-400" />
        </div>
        app.silentsuite.io
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-3 h-3 rounded-sm bg-teal-400" />
          <span className="text-[10px] uppercase tracking-wide text-navy-400">SilentSuite Calendar</span>
        </div>
        <div className="text-sm font-semibold text-white leading-snug mb-2">
          {EVENT.title}
        </div>
        <div className="space-y-1 text-xs text-navy-300">
          <Row icon={Clock}    text={EVENT.time} dark />
          <Row icon={MapPin}   text={EVENT.location} dark />
          <Row icon={Calendar} text={EVENT.attendee} dark />
        </div>
        <div className="mt-3 pt-3 border-t border-white/5 text-[11px] text-navy-300 italic">
          {EVENT.notes}
        </div>

        <div className="mt-4 flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-teal-400/10 border border-teal-400/30 text-teal-300 text-[10px] font-semibold">
          <Lock className="w-3 h-3 flex-shrink-0" />
          <span>End-to-end encrypted. Decrypted only on your device.</span>
        </div>
      </div>

      <div className="px-4 py-3 bg-navy-950 border-t border-white/5">
        <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-navy-400 mb-1.5">
          <Server className="w-2.5 h-2.5" />
          What SilentSuite&apos;s server sees
        </div>
        <pre className="text-[10px] text-navy-500 font-mono leading-relaxed break-all whitespace-pre-wrap select-none">
{`uid: 8b2c…f1
ciphertext: pQ7K9d2vXh3mZ8nB4cWxLp1aR5sFt
            jH6yV0eK7uM2bN9oP3iA4rT8sQwL
            dY6gC1xJ5lP9zS2vN4mB7tH0eK3i…
nonce: 5mP9wQ7rT2yV0eK
auth_tag: 3bN8jM6kL2pH9eR4`}
        </pre>
      </div>
    </div>
  )
}

function Row({ icon: Icon, text, dark = false }: { icon: typeof Clock; text: string; dark?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className={`w-3 h-3 mt-0.5 flex-shrink-0 ${dark ? 'text-navy-500' : 'text-[#5f6368]'}`} />
      <span className="leading-relaxed">{text}</span>
    </div>
  )
}
