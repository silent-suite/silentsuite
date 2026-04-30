interface PhoneFrameProps {
  children: React.ReactNode
  className?: string
}

/**
 * Generic rounded-rectangle phone frame. No notch — faked notches look cheap at
 * 1x. Just a thin speaker bar + matte bezel + a single soft drop shadow.
 *
 * Inner aspect ratio targets a 9:19.5 phone screen (modern iPhone / flagship
 * Android). The viewport size is fixed at 280×608 so the mock UI inside can be
 * laid out with stable Tailwind utilities rather than vw-based sizing.
 */
export default function PhoneFrame({ children, className = '' }: PhoneFrameProps) {
  return (
    <div
      className={`relative inline-block rounded-[2.5rem] bg-[#1a232f] p-[10px] ring-1 ring-white/10 ${className}`}
      style={{
        boxShadow:
          '0 30px 60px -15px rgba(15, 23, 42, 0.55), 0 12px 24px -8px rgba(15, 23, 42, 0.35)',
      }}
    >
      <div className="rounded-[2rem] overflow-hidden bg-navy-950 w-[280px] h-[608px] relative">
        {/* Speaker bar — no faked Dynamic Island */}
        <div
          aria-hidden="true"
          className="absolute top-2 left-1/2 -translate-x-1/2 w-16 h-1 rounded-full bg-[#0a1018] z-20"
        />
        {children}
      </div>
    </div>
  )
}
