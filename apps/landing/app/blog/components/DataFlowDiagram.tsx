/**
 * Data Flow Diagram: Shows what Google extracts from your calendar data.
 * Central calendar node with spokes to data categories, flowing into a profile result.
 */
export default function DataFlowDiagram() {
  const categories = [
    { label: 'Where you go', sub: 'Locations, patterns, routines', x: 120, y: 100 },
    { label: 'Who you meet', sub: 'Relationships, social graph', x: 680, y: 100 },
    { label: 'Health data', sub: 'Doctors, therapists, conditions', x: 80, y: 210 },
    { label: 'Work schedule', sub: 'Employer, meetings, interviews', x: 720, y: 210 },
    { label: 'Life events', sub: 'Weddings, births, funerals', x: 120, y: 320 },
    { label: 'Habits', sub: 'Gym, church, recurring patterns', x: 680, y: 320 },
  ]

  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 520"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="dfBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
          <linearGradient id="dfRedGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#EF4444" stopOpacity="0" />
          </linearGradient>
          <filter id="dfGlow">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="dfGlowStrong">
            <feGaussianBlur stdDeviation="8" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="800" height="520" fill="url(#dfBg)" />

        {/* Subtle grid */}
        <g opacity="0.03">
          {Array.from({ length: 21 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="520" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="38" fontFamily="Inter, system-ui, sans-serif" fontSize="20" fontWeight="700" fill="white" textAnchor="middle">
          What Google builds from your calendar
        </text>
        <text x="400" y="58" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#677FA3" textAnchor="middle">
          Every event you create feeds a surveillance profile
        </text>

        {/* Connecting lines from calendar center (400, 210) to each category */}
        {categories.map((cat, i) => (
          <line
            key={`spoke-${i}`}
            x1="400"
            y1="210"
            x2={cat.x}
            y2={cat.y}
            stroke="#EF4444"
            strokeWidth="1.5"
            opacity="0.2"
            strokeDasharray="4 3"
          />
        ))}

        {/* Arrow from calendar down to profile */}
        <line x1="400" y1="268" x2="400" y2="400" stroke="#EF4444" strokeWidth="2" opacity="0.4" />
        <polygon points="393,398 400,412 407,398" fill="#EF4444" opacity="0.5" />

        {/* === Central Calendar Node === */}
        <g transform="translate(340, 148)">
          {/* Outer glow ring */}
          <rect x="-8" y="-8" width="136" height="136" rx="22" fill="none" stroke="#EF4444" strokeWidth="0.5" opacity="0.15" filter="url(#dfGlowStrong)" />

          {/* Card */}
          <rect x="0" y="0" width="120" height="120" rx="16" fill="#131D2A" stroke="#EF4444" strokeWidth="1.8" />

          {/* Calendar header bar */}
          <rect x="0" y="0" width="120" height="34" rx="16" fill="#2D1515" />
          <rect x="0" y="16" width="120" height="18" fill="#2D1515" />

          {/* Calendar pins */}
          <rect x="30" y="-4" width="4" height="12" rx="2" fill="#EF4444" opacity="0.6" />
          <rect x="86" y="-4" width="4" height="12" rx="2" fill="#EF4444" opacity="0.6" />

          <text x="60" y="26" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="700" fill="#EF4444" textAnchor="middle">
            CALENDAR
          </text>

          {/* Calendar grid */}
          {[0, 1, 2].map((row) =>
            [0, 1, 2, 3].map((col) => (
              <rect
                key={`cell-${row}-${col}`}
                x={16 + col * 24}
                y={44 + row * 22}
                width="18"
                height="16"
                rx="3"
                fill={row === 1 && col === 1 ? '#EF4444' : '#1B2838'}
                opacity={row === 1 && col === 1 ? 0.4 : 0.5}
                stroke="#5B2020"
                strokeWidth="0.5"
              />
            ))
          )}
        </g>

        {/* === Data Category Cards === */}

        {/* Top-left: Locations */}
        <g transform="translate(28, 80)">
          <rect x="0" y="0" width="184" height="48" rx="10" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />
          <g transform="translate(16, 12)">
            {/* Pin icon */}
            <circle cx="8" cy="8" r="6" fill="none" stroke="#EF4444" strokeWidth="1.5" />
            <circle cx="8" cy="7" r="2.5" fill="#EF4444" />
            <path d="M8,14 L8,22" stroke="#EF4444" strokeWidth="1.2" />
          </g>
          <text x="46" y="18" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="600">Where you go</text>
          <text x="46" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3">Locations, patterns, routines</text>
        </g>

        {/* Top-right: People */}
        <g transform="translate(588, 80)">
          <rect x="0" y="0" width="184" height="48" rx="10" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />
          <g transform="translate(16, 12)">
            {/* People icon */}
            <circle cx="6" cy="8" r="4" fill="none" stroke="#EF4444" strokeWidth="1.3" />
            <circle cx="16" cy="8" r="4" fill="none" stroke="#EF4444" strokeWidth="1.3" />
            <path d="M0,22 Q6,16 12,22" fill="none" stroke="#EF4444" strokeWidth="1.2" />
            <path d="M10,22 Q16,16 22,22" fill="none" stroke="#EF4444" strokeWidth="1.2" />
          </g>
          <text x="46" y="18" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="600">Who you meet</text>
          <text x="46" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3">Relationships, social graph</text>
        </g>

        {/* Mid-left: Health */}
        <g transform="translate(8, 190)">
          <rect x="0" y="0" width="194" height="48" rx="10" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />
          <g transform="translate(16, 12)">
            {/* Cross/medical icon */}
            <rect x="4" y="0" width="8" height="22" rx="2" fill="none" stroke="#EF4444" strokeWidth="1.3" />
            <rect x="-3" y="7" width="22" height="8" rx="2" fill="none" stroke="#EF4444" strokeWidth="1.3" />
          </g>
          <text x="46" y="18" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="600">Health data</text>
          <text x="46" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3">Doctors, therapists, conditions</text>
        </g>

        {/* Mid-right: Work */}
        <g transform="translate(598, 190)">
          <rect x="0" y="0" width="194" height="48" rx="10" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />
          <g transform="translate(14, 10)">
            {/* Briefcase icon */}
            <rect x="0" y="6" width="20" height="14" rx="3" fill="none" stroke="#EF4444" strokeWidth="1.3" />
            <path d="M6,6 V3 A2,2 0 0,1 8,1 H12 A2,2 0 0,1 14,3 V6" fill="none" stroke="#EF4444" strokeWidth="1.2" />
          </g>
          <text x="46" y="18" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="600">Work schedule</text>
          <text x="46" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3">Employer, meetings, interviews</text>
        </g>

        {/* Bottom-left: Life events */}
        <g transform="translate(28, 300)">
          <rect x="0" y="0" width="194" height="48" rx="10" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />
          <g transform="translate(14, 10)">
            {/* Heart icon */}
            <path
              d="M10,8 C10,4 5,2 3,6 C1,10 10,18 10,18 C10,18 19,10 17,6 C15,2 10,4 10,8 Z"
              fill="none" stroke="#EF4444" strokeWidth="1.3"
            />
          </g>
          <text x="46" y="18" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="600">Life events</text>
          <text x="46" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3">Weddings, births, funerals</text>
        </g>

        {/* Bottom-right: Habits */}
        <g transform="translate(578, 300)">
          <rect x="0" y="0" width="194" height="48" rx="10" fill="#131D2A" stroke="#5B2020" strokeWidth="1" />
          <g transform="translate(14, 10)">
            {/* Circular arrow / repeat icon */}
            <path d="M16,4 A8,8 0 1,1 4,12" fill="none" stroke="#EF4444" strokeWidth="1.3" />
            <polygon points="4,8 4,16 8,12" fill="#EF4444" opacity="0.8" />
          </g>
          <text x="46" y="18" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="600">Habits and routines</text>
          <text x="46" y="34" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3">Gym, church, recurring patterns</text>
        </g>

        {/* === Profile Result Box === */}
        <g transform="translate(200, 420)">
          <rect x="-4" y="-4" width="408" height="84" rx="18" fill="url(#dfRedGlow)" filter="url(#dfGlowStrong)" />
          <rect x="0" y="0" width="400" height="76" rx="14" fill="#2D1515" stroke="#EF4444" strokeWidth="1.5" />

          {/* Eye icon in result */}
          <g transform="translate(160, 10)">
            <ellipse cx="40" cy="14" rx="30" ry="12" fill="none" stroke="#EF4444" strokeWidth="2" opacity="0.6" />
            <circle cx="40" cy="14" r="8" fill="none" stroke="#EF4444" strokeWidth="1.5" opacity="0.5" />
            <circle cx="40" cy="14" r="3" fill="#EF4444" opacity="0.6" />
          </g>

          <text x="200" y="52" fontFamily="Inter, system-ui, sans-serif" fontSize="14" fontWeight="700" fill="#EF4444" textAnchor="middle">
            = A complete profile of your life
          </text>
          <text x="200" y="68" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#677FA3" textAnchor="middle">
            Fed into ads, AI training, and government requests
          </text>
        </g>
      </svg>
    </div>
  )
}
