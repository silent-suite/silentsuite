/**
 * Data Flow Diagram: Shows what Google sees from your calendar data.
 * Uses pure SVG icons instead of emoji for consistent rendering.
 */
export default function DataFlowDiagram() {
  return (
    <div className="my-10 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 340"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="dfBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1923" />
            <stop offset="100%" stopColor="#080E15" />
          </linearGradient>
          <marker id="arrowDown" viewBox="0 0 10 10" refX="5" refY="10" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L5,10 L10,0" fill="#EF4444" opacity="0.6" />
          </marker>
        </defs>

        <rect width="800" height="340" fill="url(#dfBg)" />

        {/* Subtle grid */}
        <g opacity="0.03">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="340" stroke="white" strokeWidth="0.5" />
          ))}
          {Array.from({ length: 9 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 40} x2="800" y2={i * 40} stroke="white" strokeWidth="0.5" />
          ))}
        </g>

        {/* Title */}
        <text x="400" y="36" fontFamily="Inter, system-ui, sans-serif" fontSize="18" fontWeight="700" fill="white" textAnchor="middle">
          What Google builds from your calendar
        </text>

        {/* Center: Calendar icon (pure SVG) */}
        <g transform="translate(360, 90)">
          <rect x="0" y="0" width="80" height="74" rx="10" fill="#131D2A" stroke="#EF4444" strokeWidth="1.5" />
          <rect x="0" y="0" width="80" height="22" rx="10" fill="#2D1515" />
          <rect x="0" y="10" width="80" height="12" fill="#2D1515" />
          <text x="40" y="17" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#EF4444" textAnchor="middle">CALENDAR</text>
          {/* Calendar grid lines */}
          <line x1="15" y1="38" x2="65" y2="38" stroke="#EF4444" strokeWidth="0.5" opacity="0.3" />
          <line x1="15" y1="50" x2="65" y2="50" stroke="#EF4444" strokeWidth="0.5" opacity="0.3" />
          <line x1="30" y1="28" x2="30" y2="62" stroke="#EF4444" strokeWidth="0.5" opacity="0.3" />
          <line x1="50" y1="28" x2="50" y2="62" stroke="#EF4444" strokeWidth="0.5" opacity="0.3" />
          {/* Highlight a cell */}
          <rect x="31" y="39" width="18" height="10" rx="2" fill="#EF4444" opacity="0.3" />
        </g>

        {/* Connecting lines from center */}
        <line x1="370" y1="110" x2="200" y2="80" stroke="#EF4444" strokeWidth="1.2" opacity="0.35" />
        <line x1="430" y1="110" x2="600" y2="80" stroke="#EF4444" strokeWidth="1.2" opacity="0.35" />
        <line x1="360" y1="130" x2="190" y2="148" stroke="#EF4444" strokeWidth="1.2" opacity="0.35" />
        <line x1="440" y1="130" x2="610" y2="148" stroke="#EF4444" strokeWidth="1.2" opacity="0.35" />
        <line x1="370" y1="160" x2="200" y2="218" stroke="#EF4444" strokeWidth="1.2" opacity="0.35" />
        <line x1="430" y1="160" x2="600" y2="218" stroke="#EF4444" strokeWidth="1.2" opacity="0.35" />

        {/* Top-left: Locations */}
        <rect x="80" y="60" width="180" height="38" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <circle cx="100" cy="75" r="5" fill="none" stroke="#EF4444" strokeWidth="1.2" />
        <circle cx="100" cy="73" r="2" fill="#EF4444" />
        <text x="114" y="74" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="500">Where you go</text>
        <text x="114" y="89" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3">Patterns, frequency, routine</text>

        {/* Top-right: People */}
        <rect x="540" y="60" width="180" height="38" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <circle cx="560" cy="73" r="5" fill="none" stroke="#EF4444" strokeWidth="1.2" />
        <circle cx="557" cy="73" r="3" fill="none" stroke="#EF4444" strokeWidth="1" />
        <circle cx="563" cy="73" r="3" fill="none" stroke="#EF4444" strokeWidth="1" />
        <text x="574" y="74" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="500">Who you meet</text>
        <text x="574" y="89" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3">Relationships, social graph</text>

        {/* Mid-left: Health */}
        <rect x="60" y="130" width="190" height="38" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <text x="80" y="148" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444">+</text>
        <rect x="75" y="140" width="12" height="12" rx="2" fill="none" stroke="#EF4444" strokeWidth="1" />
        <text x="96" y="148" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="500">Health appointments</text>
        <text x="96" y="161" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3">Doctors, therapists, conditions</text>

        {/* Mid-right: Work */}
        <rect x="550" y="130" width="190" height="38" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <rect x="568" y="141" width="12" height="9" rx="1.5" fill="none" stroke="#EF4444" strokeWidth="1" />
        <line x1="568" y1="144" x2="580" y2="144" stroke="#EF4444" strokeWidth="0.8" />
        <text x="588" y="148" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="500">Work schedule</text>
        <text x="588" y="161" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3">Employer, meetings, interviews</text>

        {/* Bottom-left: Life events */}
        <rect x="60" y="200" width="200" height="38" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <circle cx="82" cy="215" r="6" fill="none" stroke="#EF4444" strokeWidth="1" />
        <path d="M79,213 L82,218 L85,213" fill="none" stroke="#EF4444" strokeWidth="1" />
        <text x="96" y="216" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="500">Life events</text>
        <text x="96" y="229" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3">Weddings, births, divorces, funerals</text>

        {/* Bottom-right: Habits */}
        <rect x="540" y="200" width="200" height="38" rx="8" fill="#131D2A" stroke="#5B2020" strokeWidth="0.8" />
        <path d="M558,220 A6,6 0 1,1 558,210" fill="none" stroke="#EF4444" strokeWidth="1.2" />
        <polygon points="560,210 558,206 556,210" fill="#EF4444" />
        <text x="572" y="216" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fill="#EF4444" fontWeight="500">Routines and habits</text>
        <text x="572" y="229" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3">Gym, church, recurring weekly slots</text>

        {/* Bottom: Aggregate arrow */}
        <line x1="400" y1="174" x2="400" y2="268" stroke="#EF4444" strokeWidth="1.8" opacity="0.5" />
        <polygon points="393,268 400,280 407,268" fill="#EF4444" opacity="0.6" />

        {/* Profile box */}
        <rect x="260" y="284" width="280" height="44" rx="10" fill="#2D1515" stroke="#EF4444" strokeWidth="1.2" />
        <text x="400" y="303" fontFamily="Inter, system-ui, sans-serif" fontSize="12" fontWeight="600" fill="#EF4444" textAnchor="middle">
          = Complete profile of your life
        </text>
        <text x="400" y="319" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="#677FA3" textAnchor="middle">
          Fed into ads, AI training, and government requests
        </text>
      </svg>
    </div>
  )
}
