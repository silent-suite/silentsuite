/**
 * Encryption Comparison Diagram: Google "encrypted at rest" vs SilentSuite E2EE.
 * Two-column visual showing the difference in who can read the data.
 */
export default function EncryptionComparisonDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 380"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="ecBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
        </defs>

        <rect width="800" height="380" fill="url(#ecBg)" />

        {/* Grid */}
        <g opacity="0.03">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="380" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 10 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="36" fontFamily="Inter, system-ui, sans-serif" fontSize="18" fontWeight="700" fill="white" textAnchor="middle">
          &quot;Encrypted at rest&quot; vs end-to-end encryption
        </text>

        {/* === Left: Google === */}
        <g transform="translate(40, 60)">
          <rect x="0" y="0" width="340" height="296" rx="12" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />

          {/* Header */}
          <rect x="0" y="0" width="340" height="44" rx="12" fill="#2D1515" />
          <rect x="0" y="22" width="340" height="22" fill="#2D1515" />
          <text x="170" y="30" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="700" fill="#EF4444" textAnchor="middle">
            Google Calendar
          </text>

          {/* Device */}
          <rect x="30" y="66" width="120" height="44" rx="8" fill="#0A1018" stroke="#5B2020" strokeWidth="0.8" />
          <text x="90" y="84" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA" textAnchor="middle">Your device</text>
          <text x="90" y="98" fontFamily="monospace" fontSize="9" fill="#EF4444" textAnchor="middle">&quot;Therapy 3pm&quot;</text>

          {/* Arrow */}
          <line x1="150" y1="88" x2="190" y2="88" stroke="#EF4444" strokeWidth="1.5" markerEnd="url(#arrowRed)" />
          <text x="170" y="80" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#677FA3" textAnchor="middle">TLS</text>

          {/* Server */}
          <rect x="190" y="66" width="120" height="44" rx="8" fill="#0A1018" stroke="#5B2020" strokeWidth="0.8" />
          <text x="250" y="84" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA" textAnchor="middle">Google server</text>
          <text x="250" y="98" fontFamily="monospace" fontSize="9" fill="#EF4444" textAnchor="middle">&quot;Therapy 3pm&quot;</text>

          {/* Eye icon */}
          <g transform="translate(145, 126)">
            <ellipse cx="25" cy="10" rx="18" ry="9" fill="none" stroke="#EF4444" strokeWidth="1.5" />
            <circle cx="25" cy="10" r="5" fill="none" stroke="#EF4444" strokeWidth="1.2" />
            <circle cx="25" cy="10" r="2" fill="#EF4444" />
          </g>

          <text x="170" y="160" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#EF4444" textAnchor="middle" fontWeight="500">
            Google can read everything
          </text>

          {/* What they see */}
          <g transform="translate(30, 176)">
            <rect x="0" y="0" width="280" height="22" rx="4" fill="#2D1515" opacity="0.5" />
            <text x="10" y="15" fontFamily="monospace" fontSize="9" fill="#EF4444">📅 &quot;Therapy session, Thursday 3pm&quot;</text>
          </g>
          <g transform="translate(30, 204)">
            <rect x="0" y="0" width="280" height="22" rx="4" fill="#2D1515" opacity="0.5" />
            <text x="10" y="15" fontFamily="monospace" fontSize="9" fill="#EF4444">📍 &quot;123 Main St, Dr. Mueller&apos;s Office&quot;</text>
          </g>
          <g transform="translate(30, 232)">
            <rect x="0" y="0" width="280" height="22" rx="4" fill="#2D1515" opacity="0.5" />
            <text x="10" y="15" fontFamily="monospace" fontSize="9" fill="#EF4444">👥 &quot;Meeting with: custody lawyer&quot;</text>
          </g>

          <text x="170" y="280" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">
            Keys held by Google. Decrypted on demand.
          </text>
        </g>

        {/* === Right: SilentSuite === */}
        <g transform="translate(420, 60)">
          <rect x="0" y="0" width="340" height="296" rx="12" fill="#131D2A" stroke="#0D5E3B" strokeWidth="1" />

          {/* Header */}
          <rect x="0" y="0" width="340" height="44" rx="12" fill="#0D2E1F" />
          <rect x="0" y="22" width="340" height="22" fill="#0D2E1F" />
          <text x="170" y="30" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="700" fill="#34d399" textAnchor="middle">
            SilentSuite
          </text>

          {/* Device */}
          <rect x="30" y="66" width="120" height="44" rx="8" fill="#0A1018" stroke="#0D5E3B" strokeWidth="0.8" />
          <text x="90" y="84" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA" textAnchor="middle">Your device</text>
          <text x="90" y="98" fontFamily="monospace" fontSize="9" fill="#34d399" textAnchor="middle">&quot;Therapy 3pm&quot;</text>

          {/* Arrow with lock */}
          <line x1="150" y1="88" x2="190" y2="88" stroke="#34d399" strokeWidth="1.5" />
          <text x="170" y="80" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#34d399" textAnchor="middle">🔒 E2EE</text>

          {/* Server */}
          <rect x="190" y="66" width="120" height="44" rx="8" fill="#0A1018" stroke="#0D5E3B" strokeWidth="0.8" />
          <text x="250" y="84" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA" textAnchor="middle">Our server</text>
          <text x="250" y="98" fontFamily="monospace" fontSize="9" fill="#34d399" textAnchor="middle" opacity="0.7">aG9wZSB5b3U...</text>

          {/* Shield */}
          <g transform="translate(145, 122)">
            <path
              d="M25 4C20 8 16 9.5 14 9.5v14c0 7 5.5 11.5 11 13.5 5.5-2 11-6.5 11-13.5V9.5C33 9.5 30 8 25 4z"
              fill="#0D2E1F" stroke="#34d399" strokeWidth="1.8"
            />
            <polyline points="20,20 23.5,23.5 30.5,16.5" fill="none" stroke="#34d399" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          <text x="170" y="160" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#34d399" textAnchor="middle" fontWeight="500">
            We see only encrypted blobs
          </text>

          {/* What server sees */}
          <g transform="translate(30, 176)">
            <rect x="0" y="0" width="280" height="22" rx="4" fill="#0D2E1F" opacity="0.4" />
            <text x="10" y="15" fontFamily="monospace" fontSize="9" fill="#34d399" opacity="0.7">xK8mP2qR7vN3bF5jL9wT2hQ6...</text>
          </g>
          <g transform="translate(30, 204)">
            <rect x="0" y="0" width="280" height="22" rx="4" fill="#0D2E1F" opacity="0.4" />
            <text x="10" y="15" fontFamily="monospace" fontSize="9" fill="#34d399" opacity="0.7">bW9yZSBjb2RlIHRoYW4geW91...</text>
          </g>
          <g transform="translate(30, 232)">
            <rect x="0" y="0" width="280" height="22" rx="4" fill="#0D2E1F" opacity="0.4" />
            <text x="10" y="15" fontFamily="monospace" fontSize="9" fill="#34d399" opacity="0.7">dCBkZWNvZGUgdGhpcyBlaXRo...</text>
          </g>

          <text x="170" y="280" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">
            Keys on your device only. We can&apos;t decrypt.
          </text>
        </g>
      </svg>
    </div>
  )
}
