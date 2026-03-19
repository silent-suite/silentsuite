/**
 * Architecture diagram showing E2EE data flow:
 * Device -> Encrypt locally -> Encrypted transit -> Server (ciphertext only) -> Encrypted transit -> Device -> Decrypt locally
 */
export default function ArchitectureDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 340"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="archBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#111B27" />
            <stop offset="100%" stopColor="#0A1018" />
          </linearGradient>
        </defs>

        <rect width="800" height="340" fill="url(#archBg)" />

        {/* Title */}
        <text
          x="400"
          y="35"
          fontFamily="Inter, system-ui, sans-serif"
          fontSize="16"
          fontWeight="600"
          fill="white"
          textAnchor="middle"
        >
          How SilentSuite syncs your data
        </text>

        {/* === Device A === */}
        <g transform="translate(40, 70)">
          {/* Phone outline */}
          <rect x="20" y="0" width="80" height="130" rx="10" fill="#1B2838" stroke="#677FA3" strokeWidth="1.5" />
          <text x="60" y="35" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="600" fill="white" textAnchor="middle">Device A</text>

          {/* Plaintext data */}
          <rect x="30" y="48" width="60" height="40" rx="4" fill="#0D2E1F" fillOpacity="0.5" />
          <text x="60" y="64" fontFamily="monospace" fontSize="8" fill="#34d399" textAnchor="middle">Meeting</text>
          <text x="60" y="76" fontFamily="monospace" fontSize="8" fill="#34d399" textAnchor="middle">3pm Tue</text>

          {/* Lock indicator */}
          <g transform="translate(46, 95)">
            <rect x="3" y="5" width="14" height="10" rx="2" fill="none" stroke="#34d399" strokeWidth="1" />
            <path d="M6 5V3a4 4 0 0 1 8 0v2" fill="none" stroke="#34d399" strokeWidth="1" />
          </g>
          <text x="60" y="125" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#34d399" textAnchor="middle">Encrypted here</text>
        </g>

        {/* === Arrow A -> Server === */}
        <g transform="translate(150, 120)">
          <line x1="0" y1="0" x2="130" y2="0" stroke="#34d399" strokeWidth="1.5" strokeDasharray="6 4" />
          <polygon points="128,-4 138,0 128,4" fill="#34d399" />
          <text x="65" y="-10" fontFamily="monospace" fontSize="8" fill="#34d399" textAnchor="middle" opacity="0.7">TLS + E2EE</text>

          {/* Encrypted blob */}
          <rect x="30" y="8" width="80" height="22" rx="4" fill="#1B2838" stroke="#253549" strokeWidth="0.8" />
          <text x="70" y="23" fontFamily="monospace" fontSize="7" fill="#677FA3" textAnchor="middle">aG9wZSB5b3U...</text>
        </g>

        {/* === Server === */}
        <g transform="translate(310, 70)">
          {/* Server box */}
          <rect x="0" y="0" width="180" height="190" rx="12" fill="#1B2838" stroke="#253549" strokeWidth="1.5" />

          {/* Server rack visual */}
          <rect x="55" y="15" width="70" height="14" rx="3" fill="#253549" />
          <circle cx="112" cy="22" r="3" fill="#34d399" opacity="0.6" />
          <rect x="55" y="33" width="70" height="14" rx="3" fill="#253549" />
          <circle cx="112" cy="40" r="3" fill="#34d399" opacity="0.6" />
          <rect x="55" y="51" width="70" height="14" rx="3" fill="#253549" />
          <circle cx="112" cy="58" r="3" fill="#34d399" opacity="0.6" />

          <text x="90" y="86" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fontWeight="600" fill="white" textAnchor="middle">SilentSuite Server</text>
          <text x="90" y="102" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">EU Infrastructure</text>

          {/* What server sees */}
          <rect x="20" y="115" width="140" height="55" rx="6" fill="#0A1018" stroke="#253549" strokeWidth="0.8" />
          <text x="90" y="132" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">Server stores:</text>
          <text x="90" y="147" fontFamily="monospace" fontSize="8" fill="#677FA3" textAnchor="middle">xK8mP2q...encrypted</text>
          <text x="90" y="160" fontFamily="monospace" fontSize="8" fill="#677FA3" textAnchor="middle">No keys. No access.</text>
        </g>

        {/* === Arrow Server -> B === */}
        <g transform="translate(515, 120)">
          <line x1="0" y1="0" x2="130" y2="0" stroke="#34d399" strokeWidth="1.5" strokeDasharray="6 4" />
          <polygon points="128,-4 138,0 128,4" fill="#34d399" />
          <text x="65" y="-10" fontFamily="monospace" fontSize="8" fill="#34d399" textAnchor="middle" opacity="0.7">TLS + E2EE</text>

          {/* Encrypted blob */}
          <rect x="30" y="8" width="80" height="22" rx="4" fill="#1B2838" stroke="#253549" strokeWidth="0.8" />
          <text x="70" y="23" fontFamily="monospace" fontSize="7" fill="#677FA3" textAnchor="middle">aG9wZSB5b3U...</text>
        </g>

        {/* === Device B === */}
        <g transform="translate(660, 70)">
          <rect x="20" y="0" width="80" height="130" rx="10" fill="#1B2838" stroke="#677FA3" strokeWidth="1.5" />
          <text x="60" y="35" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="600" fill="white" textAnchor="middle">Device B</text>

          {/* Lock -> unlock */}
          <g transform="translate(46, 48)">
            <rect x="3" y="5" width="14" height="10" rx="2" fill="none" stroke="#34d399" strokeWidth="1" />
            <path d="M6 5V3a4 4 0 0 1 8 0v2" fill="none" stroke="#34d399" strokeWidth="1" />
          </g>
          <text x="60" y="78" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#34d399" textAnchor="middle">Decrypted here</text>

          {/* Plaintext result */}
          <rect x="30" y="85" width="60" height="40" rx="4" fill="#0D2E1F" fillOpacity="0.5" />
          <text x="60" y="101" fontFamily="monospace" fontSize="8" fill="#34d399" textAnchor="middle">Meeting</text>
          <text x="60" y="113" fontFamily="monospace" fontSize="8" fill="#34d399" textAnchor="middle">3pm Tue</text>
        </g>

        {/* Bottom caption */}
        <text
          x="400"
          y="300"
          fontFamily="Inter, system-ui, sans-serif"
          fontSize="11"
          fill="#677FA3"
          textAnchor="middle"
        >
          Your data is only ever readable on your own devices. The server never has the keys.
        </text>

        {/* Protocol label */}
        <rect x="310" y="310" width="180" height="22" rx="11" fill="#253549" />
        <text x="400" y="325" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fontWeight="500" fill="#34d399" textAnchor="middle">
          Powered by the Etebase protocol
        </text>
      </svg>
    </div>
  )
}
