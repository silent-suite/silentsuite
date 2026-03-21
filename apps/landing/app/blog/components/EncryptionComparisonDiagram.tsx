/**
 * Encryption Comparison Diagram: Google "encrypted at rest" vs SilentSuite E2EE.
 * Two-column visual with clear data flow and readable text.
 */
export default function EncryptionComparisonDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 420"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="ecBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
        </defs>

        <rect width="800" height="420" fill="url(#ecBg)" />

        {/* Grid */}
        <g opacity="0.03">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="420" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 11 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="36" fontFamily="Inter, system-ui, sans-serif" fontSize="18" fontWeight="700" fill="white" textAnchor="middle">
          &quot;Encrypted at rest&quot; vs end-to-end encryption
        </text>

        {/* === Left: Google Calendar === */}
        <g transform="translate(30, 56)">
          <rect x="0" y="0" width="360" height="340" rx="12" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />

          {/* Header */}
          <rect x="0" y="0" width="360" height="48" rx="12" fill="#2D1515" />
          <rect x="0" y="24" width="360" height="24" fill="#2D1515" />
          <text x="180" y="32" fontFamily="Inter, system-ui, sans-serif" fontSize="15" fontWeight="700" fill="#EF4444" textAnchor="middle">
            Google Calendar
          </text>

          {/* Device box */}
          <rect x="24" y="68" width="140" height="52" rx="8" fill="#0A1018" stroke="#5B2020" strokeWidth="0.8" />
          <text x="94" y="88" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">Your device</text>
          <text x="94" y="106" fontFamily="monospace" fontSize="10" fill="#EF4444" textAnchor="middle">&quot;Therapy 3pm&quot;</text>

          {/* Arrow with TLS label */}
          <line x1="164" y1="94" x2="196" y2="94" stroke="#EF4444" strokeWidth="2" opacity="0.6" />
          <polygon points="196,90 204,94 196,98" fill="#EF4444" opacity="0.6" />
          <text x="184" y="84" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">TLS</text>

          {/* Server box */}
          <rect x="204" y="68" width="140" height="52" rx="8" fill="#0A1018" stroke="#5B2020" strokeWidth="0.8" />
          <text x="274" y="88" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">Google server</text>
          <text x="274" y="106" fontFamily="monospace" fontSize="10" fill="#EF4444" textAnchor="middle">&quot;Therapy 3pm&quot;</text>

          {/* Eye icon */}
          <g transform="translate(152, 140)">
            <ellipse cx="28" cy="12" rx="22" ry="10" fill="none" stroke="#EF4444" strokeWidth="1.8" />
            <circle cx="28" cy="12" r="6" fill="none" stroke="#EF4444" strokeWidth="1.3" />
            <circle cx="28" cy="12" r="2.5" fill="#EF4444" />
          </g>

          <text x="180" y="178" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" textAnchor="middle" fontWeight="600">
            Google can read everything
          </text>

          {/* What they see */}
          <g transform="translate(24, 194)">
            <rect x="0" y="0" width="312" height="26" rx="5" fill="#2D1515" opacity="0.5" />
            <text x="14" y="18" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;Therapy session, Thursday 3pm&quot;</text>
          </g>
          <g transform="translate(24, 226)">
            <rect x="0" y="0" width="312" height="26" rx="5" fill="#2D1515" opacity="0.5" />
            <text x="14" y="18" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;123 Main St, Dr. Mueller&apos;s Office&quot;</text>
          </g>
          <g transform="translate(24, 258)">
            <rect x="0" y="0" width="312" height="26" rx="5" fill="#2D1515" opacity="0.5" />
            <text x="14" y="18" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;Meeting with: custody lawyer&quot;</text>
          </g>

          {/* Bottom label */}
          <text x="180" y="316" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">
            Keys held by Google. Decrypted on demand.
          </text>
        </g>

        {/* VS divider */}
        <text x="400" y="236" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="700" fill="#677FA3" textAnchor="middle" opacity="0.5">
          vs
        </text>

        {/* === Right: SilentSuite === */}
        <g transform="translate(410, 56)">
          <rect x="0" y="0" width="360" height="340" rx="12" fill="#131D2A" stroke="#0D5E3B" strokeWidth="1" />

          {/* Header */}
          <rect x="0" y="0" width="360" height="48" rx="12" fill="#0D2E1F" />
          <rect x="0" y="24" width="360" height="24" fill="#0D2E1F" />
          <text x="180" y="32" fontFamily="Inter, system-ui, sans-serif" fontSize="15" fontWeight="700" fill="#34d399" textAnchor="middle">
            SilentSuite
          </text>

          {/* Device box */}
          <rect x="24" y="68" width="140" height="52" rx="8" fill="#0A1018" stroke="#0D5E3B" strokeWidth="0.8" />
          <text x="94" y="88" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">Your device</text>
          <text x="94" y="106" fontFamily="monospace" fontSize="10" fill="#34d399" textAnchor="middle">&quot;Therapy 3pm&quot;</text>

          {/* Arrow with lock icon */}
          <line x1="164" y1="94" x2="196" y2="94" stroke="#34d399" strokeWidth="2" opacity="0.6" />
          <polygon points="196,90 204,94 196,98" fill="#34d399" opacity="0.6" />
          {/* Lock icon */}
          <rect x="176" y="76" width="10" height="7" rx="1.5" fill="none" stroke="#34d399" strokeWidth="1.2" />
          <path d="M178,76 L178,73 A3.5,3.5 0 0,1 185,73 L185,76" fill="none" stroke="#34d399" strokeWidth="1.2" />
          <text x="184" y="72" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#34d399" textAnchor="middle">E2EE</text>

          {/* Server box */}
          <rect x="204" y="68" width="140" height="52" rx="8" fill="#0A1018" stroke="#0D5E3B" strokeWidth="0.8" />
          <text x="274" y="88" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA" textAnchor="middle">Our server</text>
          <text x="274" y="106" fontFamily="monospace" fontSize="10" fill="#34d399" textAnchor="middle" opacity="0.7">aG9wZSB5b3U...</text>

          {/* Shield + checkmark */}
          <g transform="translate(150, 136)">
            <path
              d="M28 4C22 10 17 11.5 15 11.5v18c0 9 6 14 13 17 7-3 13-8 13-17V11.5C38 11.5 34 10 28 4z"
              fill="#0D2E1F" stroke="#34d399" strokeWidth="2"
            />
            <polyline points="22,24 26,28 35,19" fill="none" stroke="#34d399" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          <text x="180" y="178" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" fontWeight="600">
            We see only encrypted blobs
          </text>

          {/* What server sees */}
          <g transform="translate(24, 194)">
            <rect x="0" y="0" width="312" height="26" rx="5" fill="#0D2E1F" opacity="0.4" />
            <text x="14" y="18" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.7">xK8mP2qR7vN3bF5jL9wT2hQ6dR4...</text>
          </g>
          <g transform="translate(24, 226)">
            <rect x="0" y="0" width="312" height="26" rx="5" fill="#0D2E1F" opacity="0.4" />
            <text x="14" y="18" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.7">bW9yZSBjb2RlIHRoYW4geW91Li4...</text>
          </g>
          <g transform="translate(24, 258)">
            <rect x="0" y="0" width="312" height="26" rx="5" fill="#0D2E1F" opacity="0.4" />
            <text x="14" y="18" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.7">dCBkZWNvZGUgdGhpcyBlaXRoZXI...</text>
          </g>

          {/* Bottom label */}
          <text x="180" y="316" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">
            Keys on your device only. We can&apos;t decrypt.
          </text>
        </g>
      </svg>
    </div>
  )
}
