/**
 * Checklist Graphic: Visual version of "What to look for when choosing a calendar provider"
 * Five key questions with detailed icons and generous row height for clarity.
 */
export default function ChecklistGraphic() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 480"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="clBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
        </defs>

        <rect width="800" height="480" fill="url(#clBg)" />

        {/* Grid */}
        <g opacity="0.03">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="480" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 12 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="40" fontFamily="Inter, system-ui, sans-serif" fontSize="20" fontWeight="700" fill="white" textAnchor="middle">
          5 questions to ask any calendar provider
        </text>
        <text x="400" y="62" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#677FA3" textAnchor="middle">
          Use this checklist to evaluate the privacy of any service
        </text>

        {/* === Item 1: E2EE — row height 68, icon area 36x36, text starts at x=110 === */}
        <g transform="translate(50, 82)">
          <rect x="0" y="0" width="700" height="68" rx="12" fill="#131D2A" stroke="#1E3A4F" strokeWidth="1" />
          <rect x="0" y="0" width="5" height="68" rx="2" fill="#34d399" />

          <circle cx="38" cy="34" r="18" fill="#0D2E1F" stroke="#34d399" strokeWidth="2" />
          <text x="38" y="40" fontFamily="Inter, system-ui, sans-serif" fontSize="16" fontWeight="700" fill="#34d399" textAnchor="middle">1</text>

          {/* Lock icon — fits in 30x36 area */}
          <g transform="translate(68, 16)">
            <rect x="2" y="14" width="24" height="18" rx="4" fill="#0D2E1F" stroke="#34d399" strokeWidth="1.8" />
            <path d="M8 14V10a6 6 0 0 1 12 0v4" fill="none" stroke="#34d399" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="14" cy="24" r="2.5" fill="#34d399" />
            <line x1="14" y1="26" x2="14" y2="30" stroke="#34d399" strokeWidth="1.5" />
          </g>

          <text x="110" y="28" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="600" fill="white">
            Is it actually end-to-end encrypted?
          </text>
          <text x="110" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            &quot;Encrypted&quot; alone means nothing. Can the provider decrypt it? If they hold the keys, they can.
          </text>
        </g>

        {/* === Item 2: Key holder === */}
        <g transform="translate(50, 160)">
          <rect x="0" y="0" width="700" height="68" rx="12" fill="#131D2A" stroke="#1E3A4F" strokeWidth="1" />
          <rect x="0" y="0" width="5" height="68" rx="2" fill="#34d399" />

          <circle cx="38" cy="34" r="18" fill="#0D2E1F" stroke="#34d399" strokeWidth="2" />
          <text x="38" y="40" fontFamily="Inter, system-ui, sans-serif" fontSize="16" fontWeight="700" fill="#34d399" textAnchor="middle">2</text>

          {/* Key icon */}
          <g transform="translate(68, 18)">
            <circle cx="12" cy="12" r="10" fill="#0D2E1F" stroke="#34d399" strokeWidth="1.8" />
            <circle cx="12" cy="12" r="4" fill="none" stroke="#34d399" strokeWidth="1" />
            <line x1="22" y1="12" x2="42" y2="12" stroke="#34d399" strokeWidth="1.8" />
            <line x1="34" y1="12" x2="34" y2="19" stroke="#34d399" strokeWidth="1.8" />
            <line x1="40" y1="12" x2="40" y2="19" stroke="#34d399" strokeWidth="1.8" />
          </g>

          <text x="110" y="28" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="600" fill="white">
            Who holds the encryption keys?
          </text>
          <text x="110" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            The single most important question. Provider-held keys protect against outsiders, not the provider itself.
          </text>
        </g>

        {/* === Item 3: Open source === */}
        <g transform="translate(50, 238)">
          <rect x="0" y="0" width="700" height="68" rx="12" fill="#131D2A" stroke="#1E3A4F" strokeWidth="1" />
          <rect x="0" y="0" width="5" height="68" rx="2" fill="#34d399" />

          <circle cx="38" cy="34" r="18" fill="#0D2E1F" stroke="#34d399" strokeWidth="2" />
          <text x="38" y="40" fontFamily="Inter, system-ui, sans-serif" fontSize="16" fontWeight="700" fill="#34d399" textAnchor="middle">3</text>

          {/* Code brackets — centred in icon area */}
          <g transform="translate(70, 18)">
            <polyline points="8,2 1,14 8,26" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="22,2 29,14 22,26" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="18" y1="0" x2="13" y2="28" stroke="#34d399" strokeWidth="1.2" opacity="0.5" />
          </g>

          <text x="110" y="28" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="600" fill="white">
            Is the code open source?
          </text>
          <text x="110" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            Privacy claims without transparency are marketing. Open source lets anyone verify the encryption works.
          </text>
        </g>

        {/* === Item 4: Jurisdiction === */}
        <g transform="translate(50, 316)">
          <rect x="0" y="0" width="700" height="68" rx="12" fill="#131D2A" stroke="#1E3A4F" strokeWidth="1" />
          <rect x="0" y="0" width="5" height="68" rx="2" fill="#34d399" />

          <circle cx="38" cy="34" r="18" fill="#0D2E1F" stroke="#34d399" strokeWidth="2" />
          <text x="38" y="40" fontFamily="Inter, system-ui, sans-serif" fontSize="16" fontWeight="700" fill="#34d399" textAnchor="middle">4</text>

          {/* Globe icon — centred */}
          <g transform="translate(70, 16)">
            <circle cx="14" cy="14" r="13" fill="none" stroke="#34d399" strokeWidth="1.8" />
            <ellipse cx="14" cy="14" rx="6.5" ry="13" fill="none" stroke="#34d399" strokeWidth="1" />
            <line x1="1" y1="14" x2="27" y2="14" stroke="#34d399" strokeWidth="1" />
            <path d="M3 8h22" fill="none" stroke="#34d399" strokeWidth="0.8" opacity="0.5" />
            <path d="M3 20h22" fill="none" stroke="#34d399" strokeWidth="0.8" opacity="0.5" />
          </g>

          <text x="110" y="28" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="600" fill="white">
            Where is your data stored?
          </text>
          <text x="110" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            EU (GDPR) vs US (CLOUD Act) are meaningfully different legal frameworks for your personal data.
          </text>
        </g>

        {/* === Item 5: Export === */}
        <g transform="translate(50, 394)">
          <rect x="0" y="0" width="700" height="68" rx="12" fill="#131D2A" stroke="#1E3A4F" strokeWidth="1" />
          <rect x="0" y="0" width="5" height="68" rx="2" fill="#34d399" />

          <circle cx="38" cy="34" r="18" fill="#0D2E1F" stroke="#34d399" strokeWidth="2" />
          <text x="38" y="40" fontFamily="Inter, system-ui, sans-serif" fontSize="16" fontWeight="700" fill="#34d399" textAnchor="middle">5</text>

          {/* Export icon — centred */}
          <g transform="translate(70, 16)">
            <rect x="2" y="12" width="26" height="20" rx="3" fill="none" stroke="#34d399" strokeWidth="1.8" />
            <polyline points="15,24 15,4" fill="none" stroke="#34d399" strokeWidth="2" />
            <polyline points="9,10 15,4 21,10" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          <text x="110" y="28" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="600" fill="white">
            Can you export your data?
          </text>
          <text x="110" y="48" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fill="#8D9FBA">
            If you can&apos;t leave, you don&apos;t own your data. Look for standard formats like ICS and VCF.
          </text>
        </g>

        <text x="740" y="474" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#566B88" textAnchor="end" opacity="0.5">
          silentsuite.io
        </text>
      </svg>
    </div>
  )
}
