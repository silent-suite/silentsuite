/**
 * Comparison diagram: traditional cloud sync vs SilentSuite E2EE sync.
 * Shows Google/Apple reading your data vs SilentSuite seeing only ciphertext.
 */
export default function ComparisonDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 500"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="compBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#111B27" />
            <stop offset="100%" stopColor="#0A1018" />
          </linearGradient>
        </defs>

        <rect width="800" height="500" fill="url(#compBg)" />

        {/* Title */}
        <text
          x="400"
          y="40"
          fontFamily="Inter, system-ui, sans-serif"
          fontSize="18"
          fontWeight="600"
          fill="white"
          textAnchor="middle"
        >
          How your calendar data is handled
        </text>

        {/* === LEFT SIDE: Traditional cloud === */}
        <g transform="translate(40, 70)">
          {/* Label */}
          <rect x="50" y="0" width="260" height="30" rx="15" fill="#3B1C1C" />
          <text
            x="180"
            y="20"
            fontFamily="Inter, system-ui, sans-serif"
            fontSize="12"
            fontWeight="600"
            fill="#F87171"
            textAnchor="middle"
          >
            Traditional Cloud (Google, Apple)
          </text>

          {/* Phone */}
          <rect x="130" y="55" width="60" height="90" rx="8" fill="none" stroke="#677FA3" strokeWidth="1.5" />
          <text x="160" y="95" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">Your</text>
          <text x="160" y="107" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">Device</text>

          {/* Data flowing out — readable text */}
          <line x1="160" y1="148" x2="160" y2="185" stroke="#F87171" strokeWidth="1.5" strokeDasharray="4 3" />
          <polygon points="155,183 160,193 165,183" fill="#F87171" />

          {/* Readable data box */}
          <rect x="95" y="170" width="130" height="60" rx="6" fill="#1B2838" stroke="#677FA3" strokeWidth="1" />
          <text x="160" y="191" fontFamily="monospace" fontSize="9" fill="#F87171" textAnchor="middle">&quot;Therapy 3pm Tue&quot;</text>
          <text x="160" y="204" fontFamily="monospace" fontSize="9" fill="#F87171" textAnchor="middle">&quot;Dr. Mueller Fri&quot;</text>
          <text x="160" y="217" fontFamily="monospace" fontSize="9" fill="#F87171" textAnchor="middle">&quot;Date night Sat&quot;</text>

          {/* Arrow to server */}
          <line x1="160" y1="232" x2="160" y2="265" stroke="#F87171" strokeWidth="1.5" strokeDasharray="4 3" />
          <polygon points="155,263 160,273 165,263" fill="#F87171" />

          {/* Server */}
          <rect x="105" y="275" width="110" height="70" rx="8" fill="#3B1C1C" fillOpacity="0.3" stroke="#F87171" strokeWidth="1.5" />
          <text x="160" y="300" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="600" fill="#F87171" textAnchor="middle">Server</text>
          <text x="160" y="316" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#F87171" textAnchor="middle" opacity="0.8">Can read</text>
          <text x="160" y="330" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#F87171" textAnchor="middle" opacity="0.8">everything</text>

          {/* Eye icon */}
          <g transform="translate(143, 350)">
            <ellipse cx="17" cy="10" rx="14" ry="8" fill="none" stroke="#F87171" strokeWidth="1.2" />
            <circle cx="17" cy="10" r="4" fill="#F87171" />
          </g>
        </g>

        {/* === Divider === */}
        <line x1="400" y1="80" x2="400" y2="460" stroke="#253549" strokeWidth="1" strokeDasharray="6 4" />
        <text x="400" y="480" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#677FA3" textAnchor="middle">vs</text>

        {/* === RIGHT SIDE: SilentSuite E2EE === */}
        <g transform="translate(440, 70)">
          {/* Label */}
          <rect x="50" y="0" width="260" height="30" rx="15" fill="#0D2E1F" />
          <text
            x="180"
            y="20"
            fontFamily="Inter, system-ui, sans-serif"
            fontSize="12"
            fontWeight="600"
            fill="#34d399"
            textAnchor="middle"
          >
            SilentSuite (End-to-End Encrypted)
          </text>

          {/* Phone */}
          <rect x="130" y="55" width="60" height="90" rx="8" fill="none" stroke="#677FA3" strokeWidth="1.5" />
          <text x="160" y="95" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">Your</text>
          <text x="160" y="107" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">Device</text>

          {/* Lock icon on device */}
          <g transform="translate(149, 113)">
            <rect x="3" y="5" width="16" height="12" rx="2" fill="none" stroke="#34d399" strokeWidth="1.2" />
            <path d="M7 5V3a4 4 0 0 1 8 0v2" fill="none" stroke="#34d399" strokeWidth="1.2" />
          </g>

          {/* Arrow with encryption */}
          <line x1="160" y1="148" x2="160" y2="185" stroke="#34d399" strokeWidth="1.5" strokeDasharray="4 3" />
          <polygon points="155,183 160,193 165,183" fill="#34d399" />

          {/* Encrypted data box */}
          <rect x="95" y="170" width="130" height="60" rx="6" fill="#1B2838" stroke="#253549" strokeWidth="1" />
          <text x="160" y="191" fontFamily="monospace" fontSize="9" fill="#34d399" textAnchor="middle">aG9wZSB5b3UgZG9</text>
          <text x="160" y="204" fontFamily="monospace" fontSize="9" fill="#34d399" textAnchor="middle">udCBkZWNvZGUgdGh</text>
          <text x="160" y="217" fontFamily="monospace" fontSize="9" fill="#34d399" textAnchor="middle">pcyBsb2wK......</text>

          {/* Arrow to server */}
          <line x1="160" y1="232" x2="160" y2="265" stroke="#34d399" strokeWidth="1.5" strokeDasharray="4 3" />
          <polygon points="155,263 160,273 165,263" fill="#34d399" />

          {/* Server */}
          <rect x="105" y="275" width="110" height="70" rx="8" fill="#0D2E1F" fillOpacity="0.3" stroke="#34d399" strokeWidth="1.5" />
          <text x="160" y="300" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="600" fill="#34d399" textAnchor="middle">Server</text>
          <text x="160" y="316" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#34d399" textAnchor="middle" opacity="0.8">Sees only</text>
          <text x="160" y="330" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#34d399" textAnchor="middle" opacity="0.8">ciphertext</text>

          {/* Shield icon */}
          <g transform="translate(144, 350) scale(0.7)">
            <path
              d="M16 5C12.5 7.5 9 8 7 8v10c0 5 4 8.5 9 10 5-1.5 9-5 9-10V8c-2 0-5.5-.5-9-3z"
              fill="none"
              stroke="#34d399"
              strokeWidth="2"
            />
          </g>
        </g>
      </svg>
    </div>
  )
}
