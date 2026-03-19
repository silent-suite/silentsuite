/**
 * Privacy Spectrum Diagram: Places calendar providers on a visual continuum.
 * All labels above the bar, endpoint descriptions below, with enough spacing.
 */
export default function PrivacySpectrumDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 480"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="psBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
          <linearGradient id="spectrumBar" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#EF4444" />
            <stop offset="35%" stopColor="#F59E0B" />
            <stop offset="70%" stopColor="#10B981" />
            <stop offset="100%" stopColor="#34d399" />
          </linearGradient>
          <linearGradient id="spectrumBarGlow" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#EF4444" stopOpacity="0.3" />
            <stop offset="35%" stopColor="#F59E0B" stopOpacity="0.3" />
            <stop offset="70%" stopColor="#10B981" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.3" />
          </linearGradient>
          <filter id="psGlow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="psGlowStrong">
            <feGaussianBlur stdDeviation="6" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="800" height="480" fill="url(#psBg)" />

        {/* Grid */}
        <g opacity="0.04">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="480" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 12 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="40" fontFamily="Inter, system-ui, sans-serif" fontSize="20" fontWeight="700" fill="white" textAnchor="middle">
          The calendar privacy spectrum
        </text>
        <text x="400" y="62" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#677FA3" textAnchor="middle">
          Where does your calendar provider stand?
        </text>

        {/*
          Bar at y=130, height=16. All labels ABOVE the bar.
          Providers spaced: Google=100, Microsoft=175, Apple=260, Nextcloud=370, Proton=530, Tuta=600, SilentSuite=710
        */}

        {/* Spectrum bar glow */}
        <rect x="60" y="126" width="680" height="24" rx="12" fill="url(#spectrumBarGlow)" filter="url(#psGlowStrong)" />
        {/* Spectrum bar */}
        <rect x="60" y="130" width="680" height="16" rx="8" fill="url(#spectrumBar)" />

        {/* Google */}
        <g transform="translate(100, 130)">
          <text x="0" y="-22" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#EF4444" textAnchor="middle" fontWeight="600">Google</text>
          <line x1="0" y1="-14" x2="0" y2="0" stroke="#EF4444" strokeWidth="2" />
          <circle cx="0" cy="8" r="7" fill="#1B2838" stroke="#EF4444" strokeWidth="2" />
          <circle cx="0" cy="8" r="2.5" fill="#EF4444" />
        </g>

        {/* Microsoft */}
        <g transform="translate(175, 130)">
          <text x="0" y="-22" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#EF4444" textAnchor="middle" fontWeight="600">Microsoft</text>
          <line x1="0" y1="-14" x2="0" y2="0" stroke="#EF4444" strokeWidth="2" />
          <circle cx="0" cy="8" r="7" fill="#1B2838" stroke="#EF4444" strokeWidth="2" />
          <circle cx="0" cy="8" r="2.5" fill="#EF4444" />
        </g>

        {/* Apple */}
        <g transform="translate(260, 130)">
          <text x="0" y="-22" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#F59E0B" textAnchor="middle" fontWeight="600">Apple*</text>
          <line x1="0" y1="-14" x2="0" y2="0" stroke="#F59E0B" strokeWidth="2" />
          <circle cx="0" cy="8" r="7" fill="#1B2838" stroke="#F59E0B" strokeWidth="2" />
          <circle cx="0" cy="8" r="2.5" fill="#F59E0B" />
        </g>

        {/* Nextcloud */}
        <g transform="translate(370, 130)">
          <text x="0" y="-22" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#F59E0B" textAnchor="middle" fontWeight="600">Nextcloud</text>
          <line x1="0" y1="-14" x2="0" y2="0" stroke="#F59E0B" strokeWidth="2" />
          <circle cx="0" cy="8" r="7" fill="#1B2838" stroke="#F59E0B" strokeWidth="2" />
          <circle cx="0" cy="8" r="2.5" fill="#F59E0B" />
        </g>

        {/* Proton */}
        <g transform="translate(530, 130)">
          <text x="0" y="-22" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#10B981" textAnchor="middle" fontWeight="600">Proton</text>
          <line x1="0" y1="-14" x2="0" y2="0" stroke="#10B981" strokeWidth="2" />
          <circle cx="0" cy="8" r="7" fill="#1B2838" stroke="#10B981" strokeWidth="2" />
          <circle cx="0" cy="8" r="2.5" fill="#10B981" />
        </g>

        {/* Tuta */}
        <g transform="translate(600, 130)">
          <text x="0" y="-22" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#10B981" textAnchor="middle" fontWeight="600">Tuta</text>
          <line x1="0" y1="-14" x2="0" y2="0" stroke="#10B981" strokeWidth="2" />
          <circle cx="0" cy="8" r="7" fill="#1B2838" stroke="#10B981" strokeWidth="2" />
          <circle cx="0" cy="8" r="2.5" fill="#10B981" />
        </g>

        {/* SilentSuite — highlighted */}
        <g transform="translate(710, 130)">
          <text x="0" y="-26" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" fontWeight="700">SilentSuite</text>
          <line x1="0" y1="-16" x2="0" y2="0" stroke="#34d399" strokeWidth="2.5" />
          <circle cx="0" cy="8" r="9" fill="#0D2E1F" stroke="#34d399" strokeWidth="2.5" filter="url(#psGlow)" />
          <circle cx="0" cy="8" r="3" fill="#34d399" />
        </g>

        {/* Endpoint labels — BELOW the bar, well clear of everything */}
        <text x="60" y="168" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#EF4444" textAnchor="start" fontWeight="500">
          Provider reads everything
        </text>
        <text x="740" y="168" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#34d399" textAnchor="end" fontWeight="500">
          Zero-knowledge encryption
        </text>

        {/* === Detail rows === */}

        {/* Row 1: Provider-readable */}
        <rect x="50" y="192" width="700" height="72" rx="12" fill="#1B2838" stroke="#3B1C1C" strokeWidth="1" />
        <rect x="50" y="192" width="5" height="72" rx="2" fill="#EF4444" />
        <g transform="translate(76, 204)">
          <g transform="translate(0, 6)">
            <ellipse cx="16" cy="14" rx="15" ry="10" fill="none" stroke="#EF4444" strokeWidth="1.8" />
            <circle cx="16" cy="14" r="5" fill="none" stroke="#EF4444" strokeWidth="1.5" />
            <circle cx="16" cy="14" r="2" fill="#EF4444" />
          </g>
          <text x="48" y="12" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="600" fill="#EF4444">Google, Apple*, Microsoft</text>
          <text x="48" y="30" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            Encrypted at rest with provider-held keys. They can decrypt and read your events anytime.
          </text>
          <text x="48" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#566B88">
            AI features, smart suggestions, and law enforcement access all require plaintext data.
          </text>
        </g>

        {/* Row 2: Self-hosted */}
        <rect x="50" y="276" width="700" height="72" rx="12" fill="#1B2838" stroke="#92690D" strokeWidth="1" />
        <rect x="50" y="276" width="5" height="72" rx="2" fill="#F59E0B" />
        <g transform="translate(76, 288)">
          <g transform="translate(0, 4)">
            <rect x="2" y="0" width="26" height="10" rx="3" fill="none" stroke="#F59E0B" strokeWidth="1.5" />
            <rect x="2" y="14" width="26" height="10" rx="3" fill="none" stroke="#F59E0B" strokeWidth="1.5" />
            <circle cx="23" cy="5" r="2.5" fill="#F59E0B" />
            <circle cx="23" cy="19" r="2.5" fill="#F59E0B" />
          </g>
          <text x="48" y="12" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="600" fill="#F59E0B">Nextcloud (self-hosted)</text>
          <text x="48" y="30" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            You control the server and who accesses it. Calendar data is stored in plaintext on disk.
          </text>
          <text x="48" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#566B88">
            A compromised server or backup exposes everything. Open source, works with any calendar app.
          </text>
        </g>

        {/* Row 3: E2EE */}
        <rect x="50" y="360" width="700" height="72" rx="12" fill="#1B2838" stroke="#0D5E3B" strokeWidth="1" />
        <rect x="50" y="360" width="5" height="72" rx="2" fill="#34d399" />
        <g transform="translate(76, 372)">
          <g transform="translate(2, 2)">
            <path
              d="M14 3C11 5.5 8 6 6.5 6v9c0 4.5 3.5 7.5 7.5 9 4-1.5 7.5-4.5 7.5-9V6C19 6 17 5.5 14 3z"
              fill="#0D2E1F" stroke="#34d399" strokeWidth="1.8"
            />
            <polyline points="10,14 13,17 19,11" fill="none" stroke="#34d399" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text x="48" y="12" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="600" fill="#34d399">Proton, Tuta, SilentSuite</text>
          <text x="48" y="30" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            End-to-end encrypted. Server stores only ciphertext. Provider cannot read your data.
          </text>
          <text x="48" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#566B88">
            Proton &amp; Tuta: own apps only. SilentSuite: open source + works with any calendar app.
          </text>
        </g>

        {/* Footnote */}
        <text x="50" y="456" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#566B88">
          * Apple excludes calendar &amp; contacts from Advanced Data Protection. Even with ADP enabled, Apple holds the keys.
        </text>

        <text x="740" y="474" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#566B88" textAnchor="end" opacity="0.5">
          silentsuite.io
        </text>
      </svg>
    </div>
  )
}
