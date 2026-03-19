/**
 * Blog post header image — branded hero graphic for "Why We're Building SilentSuite"
 * Inline SVG, no external dependencies, renders at any resolution.
 */
export default function BlogHeaderImage() {
  return (
    <div className="my-8 rounded-xl overflow-hidden border border-navy-700">
      <svg
        viewBox="0 0 800 400"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="headerBg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0A1018" />
            <stop offset="100%" stopColor="#1B2838" />
          </linearGradient>
          <pattern
            id="headerGrid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="#253549"
              strokeWidth="0.5"
              opacity="0.3"
            />
          </pattern>
        </defs>

        <rect width="800" height="400" fill="url(#headerBg)" />
        <rect width="800" height="400" fill="url(#headerGrid)" />

        {/* Shield */}
        <g transform="translate(400, 140) scale(3.5)">
          <path
            d="M16 5C12.5 7.5 9 8 7 8v10c0 5 4 8.5 9 10 5-1.5 9-5 9-10V8c-2 0-5.5-.5-9-3z"
            fill="none"
            stroke="#34d399"
            strokeWidth="2"
          />
        </g>

        {/* Calendar icon inside shield */}
        <g transform="translate(388, 138)" opacity="0.6">
          <rect
            x="0"
            y="4"
            width="24"
            height="20"
            rx="3"
            fill="none"
            stroke="#34d399"
            strokeWidth="1.5"
          />
          <line
            x1="0"
            y1="10"
            x2="24"
            y2="10"
            stroke="#34d399"
            strokeWidth="1.5"
          />
          <line
            x1="6"
            y1="0"
            x2="6"
            y2="7"
            stroke="#34d399"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="18"
            y1="0"
            x2="18"
            y2="7"
            stroke="#34d399"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>

        {/* Title */}
        <text
          x="400"
          y="270"
          fontFamily="Inter, system-ui, sans-serif"
          fontSize="28"
          fontWeight="700"
          fill="white"
          textAnchor="middle"
        >
          Why We&apos;re Building an Encrypted
        </text>
        <text
          x="400"
          y="305"
          fontFamily="Inter, system-ui, sans-serif"
          fontSize="28"
          fontWeight="700"
          fill="white"
          textAnchor="middle"
        >
          Alternative to Google Calendar
        </text>

        {/* Tagline */}
        <text
          x="400"
          y="345"
          fontFamily="Inter, system-ui, sans-serif"
          fontSize="16"
          fontWeight="400"
          fill="#8D9FBA"
          textAnchor="middle"
        >
          silentsuite.io
        </text>

        {/* Bottom accent */}
        <rect x="0" y="396" width="800" height="4" fill="#34d399" opacity="0.6" />
      </svg>
    </div>
  )
}
