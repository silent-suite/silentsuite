/**
 * Encryption Comparison Diagram: Side-by-side Google vs SilentSuite.
 * Shows clear data flow from device → server with visual encryption difference.
 */
export default function EncryptionComparisonDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 540"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="ecBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
          <linearGradient id="ecRedGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#EF4444" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ecGreenGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
          <filter id="ecGlow">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="800" height="540" fill="url(#ecBg)" />

        {/* Grid */}
        <g opacity="0.03">
          {Array.from({ length: 21 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="540" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="38" fontFamily="Inter, system-ui, sans-serif" fontSize="20" fontWeight="700" fill="white" textAnchor="middle">
          &quot;Encrypted at rest&quot; vs end-to-end encryption
        </text>
        <text x="400" y="58" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#677FA3" textAnchor="middle">
          The difference between marketing and mathematics
        </text>

        {/* === Left Column: Google Calendar === */}
        <g transform="translate(24, 78)">
          <rect x="0" y="0" width="364" height="444" rx="14" fill="url(#ecRedGlow)" />
          <rect x="0" y="0" width="364" height="444" rx="14" fill="#131D2A" stroke="#5B2020" strokeWidth="1.2" />

          {/* Header */}
          <rect x="0" y="0" width="364" height="52" rx="14" fill="#2D1515" />
          <rect x="0" y="26" width="364" height="26" fill="#2D1515" />
          <text x="182" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="15" fontWeight="700" fill="#EF4444" textAnchor="middle">
            Google Calendar
          </text>

          {/* Step 1: Your Device */}
          <text x="182" y="80" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle" fontWeight="500">
            YOUR DEVICE
          </text>
          <rect x="42" y="90" width="280" height="56" rx="10" fill="#0A1018" stroke="#5B2020" strokeWidth="0.8" />
          <text x="182" y="114" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">You type your event:</text>
          <text x="182" y="134" fontFamily="monospace" fontSize="11" fill="#EF4444" textAnchor="middle">&quot;Therapy session — Thursday 3pm&quot;</text>

          {/* Arrow down */}
          <line x1="182" y1="150" x2="182" y2="176" stroke="#EF4444" strokeWidth="1.5" opacity="0.5" />
          <polygon points="176,174 182,184 188,174" fill="#EF4444" opacity="0.5" />
          <text x="210" y="168" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3">TLS only</text>

          {/* Step 2: Google Server */}
          <text x="182" y="200" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle" fontWeight="500">
            GOOGLE SERVER
          </text>
          <rect x="42" y="210" width="280" height="56" rx="10" fill="#0A1018" stroke="#5B2020" strokeWidth="0.8" />
          <text x="182" y="234" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">Server stores plaintext:</text>
          <text x="182" y="254" fontFamily="monospace" fontSize="11" fill="#EF4444" textAnchor="middle">&quot;Therapy session — Thursday 3pm&quot;</text>

          {/* Eye icon — they can read it */}
          <g transform="translate(150, 280)">
            <ellipse cx="32" cy="16" rx="28" ry="13" fill="none" stroke="#EF4444" strokeWidth="2" />
            <circle cx="32" cy="16" r="8" fill="none" stroke="#EF4444" strokeWidth="1.5" />
            <circle cx="32" cy="16" r="3.5" fill="#EF4444" />
          </g>

          <text x="182" y="326" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fill="#EF4444" textAnchor="middle" fontWeight="600">
            Google can read everything
          </text>

          {/* What they extract */}
          <g transform="translate(32, 340)">
            <rect x="0" y="0" width="300" height="24" rx="5" fill="#2D1515" opacity="0.5" />
            <circle cx="14" cy="12" r="3.5" fill="#EF4444" opacity="0.6" />
            <text x="26" y="16" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;Therapy session — Thursday 3pm&quot;</text>
          </g>
          <g transform="translate(32, 370)">
            <rect x="0" y="0" width="300" height="24" rx="5" fill="#2D1515" opacity="0.5" />
            <circle cx="14" cy="12" r="3.5" fill="#EF4444" opacity="0.6" />
            <text x="26" y="16" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;123 Main St, Dr. Mueller&apos;s Office&quot;</text>
          </g>
          <g transform="translate(32, 400)">
            <rect x="0" y="0" width="300" height="24" rx="5" fill="#2D1515" opacity="0.5" />
            <circle cx="14" cy="12" r="3.5" fill="#EF4444" opacity="0.6" />
            <text x="26" y="16" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;Meeting with: custody lawyer&quot;</text>
          </g>
        </g>

        {/* VS divider */}
        <line x1="400" y1="90" x2="400" y2="510" stroke="#253549" strokeWidth="1" strokeDasharray="4 4" />
        <g transform="translate(388, 290)">
          <rect x="0" y="0" width="24" height="24" rx="12" fill="#1B2838" stroke="#253549" strokeWidth="1" />
          <text x="12" y="17" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="700" fill="#677FA3" textAnchor="middle">vs</text>
        </g>

        {/* === Right Column: SilentSuite === */}
        <g transform="translate(412, 78)">
          <rect x="0" y="0" width="364" height="444" rx="14" fill="url(#ecGreenGlow)" />
          <rect x="0" y="0" width="364" height="444" rx="14" fill="#131D2A" stroke="#0D5E3B" strokeWidth="1.2" />

          {/* Header */}
          <rect x="0" y="0" width="364" height="52" rx="14" fill="#0D2E1F" />
          <rect x="0" y="26" width="364" height="26" fill="#0D2E1F" />
          <text x="182" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="15" fontWeight="700" fill="#34d399" textAnchor="middle">
            SilentSuite
          </text>

          {/* Step 1: Your Device */}
          <text x="182" y="80" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle" fontWeight="500">
            YOUR DEVICE
          </text>
          <rect x="42" y="90" width="280" height="56" rx="10" fill="#0A1018" stroke="#0D5E3B" strokeWidth="0.8" />
          <text x="182" y="114" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">You type your event:</text>
          <text x="182" y="134" fontFamily="monospace" fontSize="11" fill="#34d399" textAnchor="middle">&quot;Therapy session — Thursday 3pm&quot;</text>

          {/* Lock icon between device and server */}
          <g transform="translate(168, 152)">
            <rect x="5" y="8" width="18" height="13" rx="3" fill="#0D2E1F" stroke="#34d399" strokeWidth="1.5" />
            <path d="M9,8 V5 A5,5 0 0,1 19,5 V8" fill="none" stroke="#34d399" strokeWidth="1.5" />
          </g>

          {/* Arrow down */}
          <line x1="182" y1="150" x2="182" y2="176" stroke="#34d399" strokeWidth="1.5" opacity="0.5" />
          <polygon points="176,174 182,184 188,174" fill="#34d399" opacity="0.5" />
          <text x="210" y="168" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#34d399">E2EE + TLS</text>

          {/* Step 2: SilentSuite Server */}
          <text x="182" y="200" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle" fontWeight="500">
            SILENTSUITE SERVER
          </text>
          <rect x="42" y="210" width="280" height="56" rx="10" fill="#0A1018" stroke="#0D5E3B" strokeWidth="0.8" />
          <text x="182" y="234" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">Server stores ciphertext:</text>
          <text x="182" y="254" fontFamily="monospace" fontSize="11" fill="#34d399" textAnchor="middle" opacity="0.7">xK8mP2qR7vN3bF5jL9wT2hQ6...</text>

          {/* Shield + checkmark */}
          <g transform="translate(148, 276)">
            <path
              d="M34 6C26 13 19 14.5 16 14.5v22c0 11 8 17 18 21 10-4 18-10 18-21V14.5C48 14.5 42 13 34 6z"
              fill="#0D2E1F" stroke="#34d399" strokeWidth="2" filter="url(#ecGlow)"
            />
            <polyline points="26,28 32,34 44,22" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          <text x="182" y="326" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fill="#34d399" textAnchor="middle" fontWeight="600">
            We can&apos;t read anything
          </text>

          {/* What server sees — gibberish */}
          <g transform="translate(32, 340)">
            <rect x="0" y="0" width="300" height="24" rx="5" fill="#0D2E1F" opacity="0.4" />
            <circle cx="14" cy="12" r="3.5" fill="#34d399" opacity="0.4" />
            <text x="26" y="16" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.7">xK8mP2qR7vN3bF5jL9wT2hQ6dR4k...</text>
          </g>
          <g transform="translate(32, 370)">
            <rect x="0" y="0" width="300" height="24" rx="5" fill="#0D2E1F" opacity="0.4" />
            <circle cx="14" cy="12" r="3.5" fill="#34d399" opacity="0.4" />
            <text x="26" y="16" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.7">bW9yZSBjb2RlIHRoYW4geW91Li4u...</text>
          </g>
          <g transform="translate(32, 400)">
            <rect x="0" y="0" width="300" height="24" rx="5" fill="#0D2E1F" opacity="0.4" />
            <circle cx="14" cy="12" r="3.5" fill="#34d399" opacity="0.4" />
            <text x="26" y="16" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.7">dCBkZWNvZGUgdGhpcyBlaXRoZXIu...</text>
          </g>
        </g>

        {/* Bottom labels */}
        <text x="206" y="534" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">
          Keys held by Google. Decrypted on demand.
        </text>
        <text x="594" y="534" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">
          Keys on your device only. We can&apos;t decrypt.
        </text>
      </svg>
    </div>
  )
}
