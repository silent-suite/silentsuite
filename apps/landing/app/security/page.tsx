import type { Metadata } from 'next'
import Link from 'next/link'
import { Shield, Lock, Eye, Server, Code, Key, FileCheck, Globe } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Security | SilentSuite',
  description: 'How SilentSuite protects your data with end-to-end encryption, zero-knowledge architecture, and open-source transparency.',
}

const principles = [
  {
    icon: Lock,
    title: 'End-to-end encryption',
    description:
      'All data is encrypted on your device before it leaves. Calendar events, contacts, and tasks are encrypted using XChaCha20-Poly1305. The server only ever sees encrypted blobs.',
  },
  {
    icon: Eye,
    title: 'Zero-knowledge architecture',
    description:
      'The server cannot read, analyze, or share your data. Not even SilentSuite employees can access it. This is enforced cryptographically, not just by policy.',
  },
  {
    icon: Key,
    title: 'Password-derived keys',
    description:
      'Your encryption keys are derived from your password using Argon2id, a memory-hard key derivation function designed to resist brute-force attacks. Your password never leaves your device.',
  },
  {
    icon: Server,
    title: 'Your Data, Your Control',
    description:
      'Your data is encrypted on your device before it ever reaches our servers. With zero-knowledge architecture, your data stays private regardless of where it is stored. Self-host for complete sovereignty.',
  },
  {
    icon: Code,
    title: 'Open source',
    description:
      'The SilentSuite server, sync engine, and client applications are open source. Anyone can inspect, audit, and verify the encryption implementation.',
  },
  {
    icon: FileCheck,
    title: 'Battle-tested protocol',
    description:
      'Built on the Etebase protocol, a proven end-to-end encryption framework designed specifically for structured data like calendars, contacts, and tasks.',
  },
]

export default function SecurityPage() {
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

      {/* Hero */}
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-teal-400/10 border border-teal-400/20 text-teal-400 text-sm font-medium mb-8">
          <Shield className="w-4 h-4" />
          <span>Security</span>
        </div>
        <h1 className="text-4xl md:text-5xl font-bold mb-6">
          Your data is encrypted.<br />Not even we can read it.
        </h1>
        <p className="text-xl text-navy-300 max-w-2xl mx-auto leading-relaxed">
          SilentSuite uses end-to-end encryption to ensure your calendar,
          contacts, and tasks remain completely private. Here&apos;s exactly how
          it works.
        </p>
      </div>

      {/* Principles grid */}
      <div className="max-w-5xl mx-auto px-6 pb-16">
        <div className="grid md:grid-cols-2 gap-6">
          {principles.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="p-6 rounded-xl bg-navy-900 border border-navy-700 hover:border-teal-400/30 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-teal-400/10 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5 text-teal-400" />
              </div>
              <h3 className="font-semibold text-lg mb-2">{title}</h3>
              <p className="text-navy-300 text-sm leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* How it works diagram */}
      <div className="bg-navy-900 border-t border-b border-navy-700">
        <div className="max-w-4xl mx-auto px-6 py-16">
          <h2 className="text-3xl font-bold text-center mb-12">How encryption works</h2>
          <div className="grid md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="w-16 h-16 rounded-2xl bg-teal-400/10 border border-teal-400/20 flex items-center justify-center mx-auto mb-4">
                <Key className="w-8 h-8 text-teal-400" />
              </div>
              <h3 className="font-semibold mb-2">1. Keys derived locally</h3>
              <p className="text-navy-300 text-sm leading-relaxed">
                Your password is used to derive encryption keys on your device
                using Argon2id. Keys never leave your device.
              </p>
            </div>
            <div>
              <div className="w-16 h-16 rounded-2xl bg-teal-400/10 border border-teal-400/20 flex items-center justify-center mx-auto mb-4">
                <Lock className="w-8 h-8 text-teal-400" />
              </div>
              <h3 className="font-semibold mb-2">2. Encrypted before sync</h3>
              <p className="text-navy-300 text-sm leading-relaxed">
                Every event, contact, and task is encrypted with
                XChaCha20-Poly1305 on your device before being sent to the
                server.
              </p>
            </div>
            <div>
              <div className="w-16 h-16 rounded-2xl bg-teal-400/10 border border-teal-400/20 flex items-center justify-center mx-auto mb-4">
                <Globe className="w-8 h-8 text-teal-400" />
              </div>
              <h3 className="font-semibold mb-2">3. Server stores blobs</h3>
              <p className="text-navy-300 text-sm leading-relaxed">
                The server stores only encrypted blobs. It has no
                keys to decrypt them. Your data is safe even in a breach.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Comparison section */}
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center mb-4">
          Unlike Google Calendar or iCloud
        </h2>
        <p className="text-navy-300 text-center max-w-2xl mx-auto mb-12">
          Most productivity tools have full access to your data in plaintext.
          SilentSuite is fundamentally different.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-700">
                <th className="text-left py-3 px-4 text-navy-400 font-medium"></th>
                <th className="text-center py-3 px-4 text-teal-400 font-semibold">SilentSuite</th>
                <th className="text-center py-3 px-4 text-navy-400 font-medium">Google</th>
                <th className="text-center py-3 px-4 text-navy-400 font-medium">Apple iCloud</th>
              </tr>
            </thead>
            <tbody className="text-navy-300">
              <tr className="border-b border-navy-800">
                <td className="py-3 px-4">End-to-end encrypted</td>
                <td className="py-3 px-4 text-center text-teal-400">Yes</td>
                <td className="py-3 px-4 text-center text-red-400">No</td>
                <td className="py-3 px-4 text-center text-amber-400">Partial</td>
              </tr>
              <tr className="border-b border-navy-800">
                <td className="py-3 px-4">Provider can read your data</td>
                <td className="py-3 px-4 text-center text-teal-400">No</td>
                <td className="py-3 px-4 text-center text-red-400">Yes</td>
                <td className="py-3 px-4 text-center text-red-400">Yes</td>
              </tr>
              <tr className="border-b border-navy-800">
                <td className="py-3 px-4">Open source</td>
                <td className="py-3 px-4 text-center text-teal-400">Yes</td>
                <td className="py-3 px-4 text-center text-red-400">No</td>
                <td className="py-3 px-4 text-center text-red-400">No</td>
              </tr>
              <tr className="border-b border-navy-800">
                <td className="py-3 px-4">Self-hostable</td>
                <td className="py-3 px-4 text-center text-teal-400">Yes</td>
                <td className="py-3 px-4 text-center text-red-400">No</td>
                <td className="py-3 px-4 text-center text-red-400">No</td>
              </tr>
              <tr className="border-b border-navy-800">
                <td className="py-3 px-4">Data sovereignty</td>
                <td className="py-3 px-4 text-center text-teal-400">Yes (self-host or hosted)</td>
                <td className="py-3 px-4 text-center text-red-400">No</td>
                <td className="py-3 px-4 text-center text-red-400">No</td>
              </tr>
              <tr>
                <td className="py-3 px-4">Data used for advertising</td>
                <td className="py-3 px-4 text-center text-teal-400">Never</td>
                <td className="py-3 px-4 text-center text-red-400">Yes</td>
                <td className="py-3 px-4 text-center text-navy-400">No</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* CTA */}
      <div className="max-w-4xl mx-auto px-6 pb-20 text-center">
        <div className="rounded-2xl bg-navy-900 border border-navy-700 p-10">
          <h2 className="text-2xl font-bold mb-4">Ready to take back your privacy?</h2>
          <p className="text-navy-300 mb-8 max-w-lg mx-auto">
            Join the waitlist and be among the first to experience truly private
            productivity tools.
          </p>
          <a
            href="/#waitlist"
            className="inline-block px-8 py-4 bg-teal-400 hover:bg-teal-500 text-navy-950 font-semibold rounded-lg transition-colors"
          >
            Join the Waitlist
          </a>
        </div>
      </div>
    </main>
  )
}
