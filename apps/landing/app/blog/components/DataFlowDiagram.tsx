/**
 * Data Flow Diagram: Shows what Google sees from your calendar data
 * — the full picture of metadata and patterns they build.
 */
export default function DataFlowDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 320"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="dfBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
        </defs>

        <rect width="800" height="320" fill="url(#dfBg)" />

        {/* Grid */}
        <g opacity="0.03">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="320" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 8 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="36" fontFamily="Inter, system-ui, sans-serif" fontSize="18" fontWeight="700" fill="white" textAnchor="middle">
          What Google builds from your calendar
        </text>

        {/* Center: Calendar icon */}
        <g transform="translate(360, 80)">
          <rect x="0" y="0" width="80" height="80" rx="12" fill="#131D2A" stroke="#EF4444" strokeWidth="1.5" />
          <rect x="0" y="0" width="80" height="24" rx="12" fill="#2D1515" />
          <rect x="0" y="12" width="80" height="12" fill="#2D1515" />
          <text x="40" y="18" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#EF4444" textAnchor="middle">CALENDAR</text>
          <text x="40" y="60" fontFamily="Inter, system-ui, sans-serif" fontSize="24" fill="#EF4444" textAnchor="middle">📅</text>
        </g>

        {/* Spokes: data types flowing out */}
        {/* Top-left: Locations */}
        <line x1="370" y1="100" x2="180" y2="70" stroke="#EF4444" strokeWidth="1" opacity="0.4" />
        <rect x="80" y="52" width="160" height="36" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <text x="110" y="68" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA">📍</text>
        <text x="125" y="68" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#EF4444">Where you go</text>
        <text x="160" y="80" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#677FA3">Patterns, frequency, routine</text>

        {/* Top-right: People */}
        <line x1="430" y1="100" x2="620" y2="70" stroke="#EF4444" strokeWidth="1" opacity="0.4" />
        <rect x="560" y="52" width="160" height="36" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <text x="590" y="68" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA">👥</text>
        <text x="605" y="68" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#EF4444">Who you meet</text>
        <text x="640" y="80" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#677FA3">Relationships, social graph</text>

        {/* Left: Health */}
        <line x1="360" y1="130" x2="180" y2="140" stroke="#EF4444" strokeWidth="1" opacity="0.4" />
        <rect x="40" y="122" width="160" height="36" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <text x="70" y="138" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA">🏥</text>
        <text x="85" y="138" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#EF4444">Health appointments</text>
        <text x="120" y="150" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#677FA3">Doctors, therapists, conditions</text>

        {/* Right: Work */}
        <line x1="440" y1="130" x2="620" y2="140" stroke="#EF4444" strokeWidth="1" opacity="0.4" />
        <rect x="600" y="122" width="160" height="36" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <text x="630" y="138" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA">💼</text>
        <text x="645" y="138" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#EF4444">Work schedule</text>
        <text x="680" y="150" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#677FA3">Employer, meetings, interviews</text>

        {/* Bottom-left: Life events */}
        <line x1="370" y1="160" x2="180" y2="210" stroke="#EF4444" strokeWidth="1" opacity="0.4" />
        <rect x="60" y="192" width="180" height="36" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <text x="90" y="208" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA">💍</text>
        <text x="105" y="208" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#EF4444">Life events</text>
        <text x="150" y="220" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#677FA3">Weddings, births, divorces, funerals</text>

        {/* Bottom-right: Habits */}
        <line x1="430" y1="160" x2="620" y2="210" stroke="#EF4444" strokeWidth="1" opacity="0.4" />
        <rect x="560" y="192" width="180" height="36" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <text x="590" y="208" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#8D9FBA">🔄</text>
        <text x="605" y="208" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#EF4444">Routines and habits</text>
        <text x="650" y="220" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="#677FA3">Gym, AA, church, recurring slots</text>

        {/* Bottom: Aggregate arrow */}
        <line x1="400" y1="170" x2="400" y2="254" stroke="#EF4444" strokeWidth="1.5" opacity="0.5" />
        <polygon points="393,254 400,264 407,254" fill="#EF4444" opacity="0.5" />

        {/* Profile box */}
        <rect x="280" y="268" width="240" height="40" rx="10" fill="#2D1515" stroke="#EF4444" strokeWidth="1.2" />
        <text x="400" y="286" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="600" fill="#EF4444" textAnchor="middle">
          = Complete profile of your life
        </text>
        <text x="400" y="300" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">
          Fed into ads, AI training, and government requests
        </text>
      </svg>
    </div>
  )
}
