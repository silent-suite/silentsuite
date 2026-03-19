/**
 * Key Holder Diagram: Shows who holds the encryption keys for each provider category.
 * Three columns with large, clear illustrations.
 */
export default function KeyHolderDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 540"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="khBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
          <linearGradient id="redGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#EF4444" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="amberGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F59E0B" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#F59E0B" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="greenGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
          <filter id="khGlow">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="800" height="540" fill="url(#khBg)" />

        {/* Grid */}
        <g opacity="0.03">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="540" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="38" fontFamily="Inter, system-ui, sans-serif" fontSize="20" fontWeight="700" fill="white" textAnchor="middle">
          Who holds the keys to your calendar?
        </text>
        <text x="400" y="58" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#677FA3" textAnchor="middle">
          The key holder determines who can actually read your data
        </text>

        {/* === Column 1: Big Tech === */}
        <g transform="translate(28, 78)">
          <rect x="0" y="0" width="236" height="444" rx="14" fill="url(#redGlow)" />
          <rect x="0" y="0" width="236" height="444" rx="14" fill="#131D2A" stroke="#5B2020" strokeWidth="1.2" />

          {/* Header */}
          <rect x="0" y="0" width="236" height="52" rx="14" fill="#2D1515" />
          <rect x="0" y="26" width="236" height="26" fill="#2D1515" />
          <text x="118" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="700" fill="#EF4444" textAnchor="middle">
            Google / Apple / Microsoft
          </text>

          {/* Large key icon — the hero of this card */}
          <g transform="translate(68, 68)">
            <circle cx="22" cy="22" r="18" fill="#2D1515" stroke="#EF4444" strokeWidth="2.5" />
            <circle cx="22" cy="22" r="7" fill="none" stroke="#EF4444" strokeWidth="1.5" opacity="0.5" />
            <line x1="40" y1="22" x2="90" y2="22" stroke="#EF4444" strokeWidth="2.5" />
            <line x1="72" y1="22" x2="72" y2="34" stroke="#EF4444" strokeWidth="2.5" />
            <line x1="82" y1="22" x2="82" y2="34" stroke="#EF4444" strokeWidth="2.5" />
          </g>

          <text x="118" y="128" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="600" fill="#EF4444" textAnchor="middle">
            Provider holds your keys
          </text>

          {/* Data box */}
          <rect x="18" y="146" width="200" height="100" rx="8" fill="#0A1018" stroke="#5B2020" strokeWidth="0.8" />
          <text x="118" y="168" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="500" fill="#8D9FBA" textAnchor="middle">They can see:</text>

          <g transform="translate(30, 180)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#2D1515" opacity="0.6" />
            <circle cx="10" cy="9" r="3.5" fill="#EF4444" opacity="0.7" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;Therapy 3pm Tuesday&quot;</text>
          </g>
          <g transform="translate(30, 202)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#2D1515" opacity="0.6" />
            <circle cx="10" cy="9" r="3.5" fill="#EF4444" opacity="0.7" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;Dr. Mueller Friday&quot;</text>
          </g>
          <g transform="translate(30, 224)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#2D1515" opacity="0.6" />
            <circle cx="10" cy="9" r="3.5" fill="#EF4444" opacity="0.7" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#EF4444">&quot;Date night Saturday&quot;</text>
          </g>

          {/* Eye icon */}
          <g transform="translate(93, 270)">
            <ellipse cx="25" cy="12" rx="22" ry="11" fill="none" stroke="#EF4444" strokeWidth="1.8" />
            <circle cx="25" cy="12" r="6" fill="none" stroke="#EF4444" strokeWidth="1.5" />
            <circle cx="25" cy="12" r="2.5" fill="#EF4444" />
          </g>

          {/* Verdict */}
          <text x="118" y="326" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" textAnchor="middle" fontWeight="500">
            Encrypted at rest, but they
          </text>
          <text x="118" y="344" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" textAnchor="middle" fontWeight="500">
            can decrypt anytime
          </text>

          {/* Badge */}
          <rect x="38" y="370" width="160" height="36" rx="18" fill="#1B2838" stroke="#5B2020" strokeWidth="1" />
          <text x="118" y="393" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="500" fill="#8D9FBA" textAnchor="middle">
            Works with any app
          </text>
        </g>

        {/* === Column 2: Proton / Tuta === */}
        <g transform="translate(282, 78)">
          <rect x="0" y="0" width="236" height="444" rx="14" fill="url(#amberGlow)" />
          <rect x="0" y="0" width="236" height="444" rx="14" fill="#131D2A" stroke="#6B5210" strokeWidth="1.2" />

          <rect x="0" y="0" width="236" height="52" rx="14" fill="#2D250A" />
          <rect x="0" y="26" width="236" height="26" fill="#2D250A" />
          <text x="118" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="700" fill="#FBBF24" textAnchor="middle">
            Proton / Tuta
          </text>

          {/* Large key icon */}
          <g transform="translate(68, 68)">
            <circle cx="22" cy="22" r="18" fill="#2D250A" stroke="#FBBF24" strokeWidth="2.5" />
            <circle cx="22" cy="22" r="7" fill="none" stroke="#FBBF24" strokeWidth="1.5" opacity="0.5" />
            <line x1="40" y1="22" x2="90" y2="22" stroke="#FBBF24" strokeWidth="2.5" />
            <line x1="72" y1="22" x2="72" y2="34" stroke="#FBBF24" strokeWidth="2.5" />
            <line x1="82" y1="22" x2="82" y2="34" stroke="#FBBF24" strokeWidth="2.5" />
          </g>

          <text x="118" y="128" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="600" fill="#FBBF24" textAnchor="middle">
            You hold your keys
          </text>

          {/* Data box */}
          <rect x="18" y="146" width="200" height="100" rx="8" fill="#0A1018" stroke="#6B5210" strokeWidth="0.8" />
          <text x="118" y="168" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="500" fill="#8D9FBA" textAnchor="middle">Server sees:</text>

          <g transform="translate(30, 180)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#2D250A" opacity="0.4" />
            <circle cx="10" cy="9" r="3.5" fill="#FBBF24" opacity="0.5" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#FBBF24" opacity="0.8">xK8mP2qR7vN3bF...</text>
          </g>
          <g transform="translate(30, 202)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#2D250A" opacity="0.4" />
            <circle cx="10" cy="9" r="3.5" fill="#FBBF24" opacity="0.5" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#FBBF24" opacity="0.8">bW9yZSBjb2Rl...</text>
          </g>
          <g transform="translate(30, 224)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#2D250A" opacity="0.4" />
            <circle cx="10" cy="9" r="3.5" fill="#FBBF24" opacity="0.5" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#FBBF24" opacity="0.8">encrypted blobs only</text>
          </g>

          {/* Shield */}
          <g transform="translate(88, 268)">
            <path
              d="M30 6C24 11 19 12.5 17 12.5v18c0 9 7 14.5 13 17 6-2.5 13-8 13-17V12.5C40 12.5 36 11 30 6z"
              fill="#2D250A" stroke="#FBBF24" strokeWidth="2"
            />
          </g>

          <text x="118" y="326" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#FBBF24" textAnchor="middle" fontWeight="500">
            Truly encrypted, but
          </text>
          <text x="118" y="344" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#FBBF24" textAnchor="middle" fontWeight="500">
            locked to their apps only
          </text>

          <rect x="38" y="370" width="160" height="36" rx="18" fill="#2D250A" stroke="#6B5210" strokeWidth="1" />
          <text x="118" y="393" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="500" fill="#FBBF24" textAnchor="middle">
            Own apps only
          </text>
        </g>

        {/* === Column 3: SilentSuite === */}
        <g transform="translate(536, 78)">
          <rect x="0" y="0" width="236" height="444" rx="14" fill="url(#greenGlow)" />
          <rect x="0" y="0" width="236" height="444" rx="14" fill="#131D2A" stroke="#0D5E3B" strokeWidth="1.2" />

          <rect x="0" y="0" width="236" height="52" rx="14" fill="#0D2E1F" />
          <rect x="0" y="26" width="236" height="26" fill="#0D2E1F" />
          <text x="118" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="700" fill="#34d399" textAnchor="middle">
            SilentSuite
          </text>

          {/* Large key icon */}
          <g transform="translate(68, 68)">
            <circle cx="22" cy="22" r="18" fill="#0D2E1F" stroke="#34d399" strokeWidth="2.5" />
            <circle cx="22" cy="22" r="7" fill="none" stroke="#34d399" strokeWidth="1.5" opacity="0.5" />
            <line x1="40" y1="22" x2="90" y2="22" stroke="#34d399" strokeWidth="2.5" />
            <line x1="72" y1="22" x2="72" y2="34" stroke="#34d399" strokeWidth="2.5" />
            <line x1="82" y1="22" x2="82" y2="34" stroke="#34d399" strokeWidth="2.5" />
          </g>

          <text x="118" y="128" fontFamily="Inter, system-ui, sans-serif" fontSize="13" fontWeight="600" fill="#34d399" textAnchor="middle">
            You hold your keys
          </text>

          {/* Data box */}
          <rect x="18" y="146" width="200" height="100" rx="8" fill="#0A1018" stroke="#0D5E3B" strokeWidth="0.8" />
          <text x="118" y="168" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="500" fill="#8D9FBA" textAnchor="middle">Server sees:</text>

          <g transform="translate(30, 180)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#0D2E1F" opacity="0.4" />
            <circle cx="10" cy="9" r="3.5" fill="#34d399" opacity="0.5" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.8">aG9wZSB5b3UgZG9...</text>
          </g>
          <g transform="translate(30, 202)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#0D2E1F" opacity="0.4" />
            <circle cx="10" cy="9" r="3.5" fill="#34d399" opacity="0.5" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.8">dCBkZWNvZGUgdGh...</text>
          </g>
          <g transform="translate(30, 224)">
            <rect x="0" y="0" width="176" height="18" rx="4" fill="#0D2E1F" opacity="0.4" />
            <circle cx="10" cy="9" r="3.5" fill="#34d399" opacity="0.5" />
            <text x="22" y="13" fontFamily="monospace" fontSize="10" fill="#34d399" opacity="0.8">encrypted blobs only</text>
          </g>

          {/* Shield + checkmark */}
          <g transform="translate(88, 268)">
            <path
              d="M30 6C24 11 19 12.5 17 12.5v18c0 9 7 14.5 13 17 6-2.5 13-8 13-17V12.5C40 12.5 36 11 30 6z"
              fill="#0D2E1F" stroke="#34d399" strokeWidth="2" filter="url(#khGlow)"
            />
            <polyline points="24,26 28,30 37,21" fill="none" stroke="#34d399" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          <text x="118" y="326" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" fontWeight="500">
            Truly encrypted +
          </text>
          <text x="118" y="344" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#34d399" textAnchor="middle" fontWeight="500">
            use any app you want
          </text>

          <rect x="38" y="370" width="160" height="36" rx="18" fill="#0D2E1F" stroke="#0D5E3B" strokeWidth="1" />
          <text x="118" y="393" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="500" fill="#34d399" textAnchor="middle">
            Works with any app
          </text>
        </g>
      </svg>
    </div>
  )
}
