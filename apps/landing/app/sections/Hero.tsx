'use client'

import { Shield, Lock, ChevronDown, Fingerprint, ShieldCheck } from 'lucide-react'

export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-navy-950">
      {/* Background gradient */}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-navy-950 via-navy-900 to-teal-950/30" />
      
      {/* Subtle grid pattern */}
      <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      {/* SVG wireframe UI elements in background */}
      <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <svg
          aria-hidden="true"
          role="presentation"
          viewBox="0 0 1600 900"
          className="w-full h-full max-w-[1600px]"
          preserveAspectRatio="xMidYMid slice"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Calendar - left side */}
          <g transform="translate(120, 200)" opacity="0.15">
            <rect width="380" height="320" rx="16" fill="#1B2838" stroke="#34d399" strokeWidth="2"/>
            <rect x="0" y="0" width="380" height="50" rx="16" fill="#253549"/>
            <rect x="0" y="34" width="380" height="16" fill="#253549"/>
            <rect x="130" y="14" width="120" height="18" rx="6" fill="#34d399" opacity="0.5"/>
            {/* Day headers */}
            <text x="38" y="82" fontFamily="sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" opacity="0.7">Mo</text>
            <text x="92" y="82" fontFamily="sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" opacity="0.7">Tu</text>
            <text x="146" y="82" fontFamily="sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" opacity="0.7">We</text>
            <text x="200" y="82" fontFamily="sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" opacity="0.7">Th</text>
            <text x="254" y="82" fontFamily="sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" opacity="0.7">Fr</text>
            <text x="308" y="82" fontFamily="sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" opacity="0.7">Sa</text>
            <text x="355" y="82" fontFamily="sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" opacity="0.7">Su</text>
            <line x1="0" y1="92" x2="380" y2="92" stroke="#34d399" strokeWidth="0.8"/>
            {/* Day numbers */}
            <text x="38" y="118" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">1</text>
            <text x="92" y="118" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">2</text>
            <text x="146" y="118" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">3</text>
            <text x="200" y="118" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">4</text>
            <text x="254" y="118" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">5</text>
            <text x="308" y="118" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">6</text>
            <text x="355" y="118" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">7</text>
            <rect x="16" y="128" width="95" height="20" rx="4" fill="#34d399" opacity="0.35"/>
            <rect x="178" y="128" width="45" height="20" rx="4" fill="#34d399" opacity="0.25"/>
            {/* Row 2 */}
            <text x="38" y="172" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">8</text>
            <text x="92" y="172" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">9</text>
            <text x="146" y="172" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">10</text>
            <text x="200" y="172" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">11</text>
            <text x="254" y="172" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">12</text>
            <text x="308" y="172" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">13</text>
            <text x="355" y="172" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">14</text>
            <circle cx="146" cy="168" r="14" fill="#34d399" opacity="0.2"/>
            <rect x="124" y="182" width="100" height="20" rx="4" fill="#34d399" opacity="0.3"/>
            {/* Row 3 */}
            <text x="38" y="226" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">15</text>
            <text x="92" y="226" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">16</text>
            <text x="146" y="226" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">17</text>
            <text x="200" y="226" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">18</text>
            <text x="254" y="226" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">19</text>
            <text x="308" y="226" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">20</text>
            <text x="355" y="226" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">21</text>
            <rect x="232" y="236" width="140" height="20" rx="4" fill="#34d399" opacity="0.25"/>
            {/* Row 4 */}
            <text x="38" y="280" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">22</text>
            <text x="92" y="280" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">23</text>
            <text x="146" y="280" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">24</text>
            <text x="200" y="280" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">25</text>
            <text x="254" y="280" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">26</text>
            <text x="308" y="280" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">27</text>
            <text x="355" y="280" fontFamily="sans-serif" fontSize="14" fill="#34d399" textAnchor="middle">28</text>
            <rect x="70" y="290" width="45" height="20" rx="4" fill="#34d399" opacity="0.2"/>
          </g>

          {/* Contacts - right side */}
          <g transform="translate(1100, 200)" opacity="0.15">
            <rect width="380" height="400" rx="16" fill="#1B2838" stroke="#34d399" strokeWidth="2"/>
            <rect x="0" y="0" width="380" height="50" rx="16" fill="#253549"/>
            <rect x="0" y="34" width="380" height="16" fill="#253549"/>
            <rect x="120" y="14" width="140" height="18" rx="6" fill="#34d399" opacity="0.5"/>
            {/* Search bar */}
            <rect x="20" y="65" width="340" height="32" rx="8" fill="#253549"/>
            <circle cx="40" cy="81" r="7" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <line x1="45" y1="86" x2="50" y2="91" stroke="#34d399" strokeWidth="1.5"/>
            {/* Contact 1 */}
            <circle cx="46" cy="130" r="18" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <circle cx="46" cy="125" r="6" fill="#34d399" opacity="0.3"/>
            <path d="M33 143 Q46 149 59 143" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <rect x="78" y="120" width="150" height="9" rx="4" fill="#34d399" opacity="0.5"/>
            <rect x="78" y="136" width="100" height="7" rx="3" fill="#34d399" opacity="0.25"/>
            {/* Contact 2 */}
            <circle cx="46" cy="190" r="18" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <circle cx="46" cy="185" r="6" fill="#34d399" opacity="0.3"/>
            <path d="M33 203 Q46 209 59 203" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <rect x="78" y="180" width="130" height="9" rx="4" fill="#34d399" opacity="0.5"/>
            <rect x="78" y="196" width="170" height="7" rx="3" fill="#34d399" opacity="0.25"/>
            {/* Contact 3 */}
            <circle cx="46" cy="250" r="18" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <circle cx="46" cy="245" r="6" fill="#34d399" opacity="0.3"/>
            <path d="M33 263 Q46 269 59 263" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <rect x="78" y="240" width="110" height="9" rx="4" fill="#34d399" opacity="0.5"/>
            <rect x="78" y="256" width="140" height="7" rx="3" fill="#34d399" opacity="0.25"/>
            {/* Contact 4 */}
            <circle cx="46" cy="310" r="18" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <circle cx="46" cy="305" r="6" fill="#34d399" opacity="0.3"/>
            <path d="M33 323 Q46 329 59 323" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <rect x="78" y="300" width="160" height="9" rx="4" fill="#34d399" opacity="0.5"/>
            <rect x="78" y="316" width="90" height="7" rx="3" fill="#34d399" opacity="0.25"/>
            {/* Contact 5 */}
            <circle cx="46" cy="370" r="18" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <circle cx="46" cy="365" r="6" fill="#34d399" opacity="0.3"/>
            <path d="M33 383 Q46 389 59 383" fill="none" stroke="#34d399" strokeWidth="1.5"/>
            <rect x="78" y="360" width="120" height="9" rx="4" fill="#34d399" opacity="0.5"/>
            <rect x="78" y="376" width="150" height="7" rx="3" fill="#34d399" opacity="0.25"/>
          </g>

          {/* Shield overlay - center */}
          <g transform="translate(800, 420) scale(5)" opacity="0.06">
            <path d="M16 5C12.5 7.5 9 8 7 8v10c0 5 4 8.5 9 10 5-1.5 9-5 9-10V8c-2 0-5.5-.5-9-3z" fill="none" stroke="#34d399" strokeWidth="2.5"/>
          </g>

          {/* Soft glow circles */}
          <circle cx="300" cy="450" r="100" fill="#34d399" opacity="0.04"/>
          <circle cx="1300" cy="450" r="100" fill="#34d399" opacity="0.04"/>
        </svg>
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-6 py-32 text-center">
        {/* E2E Encryption Badge - prominent */}
        <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-teal-400/15 border border-teal-400/30 text-teal-400 text-sm font-semibold mb-4 backdrop-blur-sm">
          <Lock className="w-4 h-4" />
          <span>End-to-End Encrypted</span>
          <ShieldCheck className="w-4 h-4" />
        </div>

        {/* Headline */}
        <h1 className="text-5xl md:text-7xl font-bold text-white mb-6 leading-tight">
          Your Calendar & Contacts
          <span className="block text-teal-400">Encrypted. Yours.</span>
        </h1>

        {/* Subheadline */}
        <p className="text-xl md:text-2xl text-navy-300 max-w-2xl mx-auto mb-10 leading-relaxed">
          Sync your calendar, contacts and tasks with end-to-end encryption.
          As easy as iCloud. As private as Signal.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
          <a
            href="https://app.silentsuite.io/signup"
            className="px-8 py-4 bg-teal-400 hover:bg-teal-500 text-navy-950 font-semibold rounded-lg transition-colors"
          >
            Get Started
          </a>
          <a
            href="#problem"
            className="px-8 py-4 bg-navy-800 hover:bg-navy-700 text-white font-medium rounded-lg transition-colors"
          >
            Learn More
          </a>
        </div>

        {/* Trust indicators */}
        <div className="flex flex-wrap items-center justify-center gap-6 text-navy-400 text-sm">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-teal-400" />
            <span>End-to-end encrypted</span>
          </div>
          <div className="flex items-center gap-2">
            <Fingerprint className="w-4 h-4 text-teal-400" />
            <span>Zero-knowledge. Not even we can read your data.</span>
          </div>
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-teal-400" />
            <span>Open source &amp; your data, your control</span>
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce text-navy-400">
        <ChevronDown className="w-6 h-6" />
      </div>
    </section>
  )
}
