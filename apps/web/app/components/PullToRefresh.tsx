'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useSyncStore } from '@/app/stores/use-sync-store'

const PULL_THRESHOLD = 80
const MAX_PULL = 120

export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const startY = useRef(0)
  const pulling = useRef(false)
  const simulateSyncCycle = useSyncStore((s) => s.simulateSyncCycle)

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const container = containerRef.current
    if (!container || isRefreshing) return
    // Only activate when scrolled to top
    if (container.scrollTop > 0) return
    startY.current = e.touches[0]!.clientY
    pulling.current = true
  }, [isRefreshing])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!pulling.current) return
    const deltaY = e.touches[0]!.clientY - startY.current
    if (deltaY < 0) {
      pulling.current = false
      setPullDistance(0)
      return
    }
    // Apply resistance
    const distance = Math.min(deltaY * 0.5, MAX_PULL)
    setPullDistance(distance)
    if (distance > 10) {
      e.preventDefault()
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (!pulling.current) return
    pulling.current = false

    if (pullDistance >= PULL_THRESHOLD) {
      setIsRefreshing(true)
      simulateSyncCycle()
      // Reset after a brief delay to show the animation
      setTimeout(() => {
        setIsRefreshing(false)
        setPullDistance(0)
      }, 800)
    } else {
      setPullDistance(0)
    }
  }, [pullDistance, simulateSyncCycle])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd)

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
    }
  }, [handleTouchStart, handleTouchMove, handleTouchEnd])

  const progress = Math.min(pullDistance / PULL_THRESHOLD, 1)
  const showIndicator = pullDistance > 10 || isRefreshing

  return (
    <div ref={containerRef} className="relative h-full overflow-y-auto">
      {/* Pull indicator */}
      {showIndicator && (
        <div
          className="absolute inset-x-0 top-0 z-10 flex items-center justify-center transition-opacity"
          style={{ height: `${Math.max(pullDistance, isRefreshing ? 48 : 0)}px` }}
        >
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full bg-[rgb(var(--surface))] border border-[rgb(var(--border))] shadow-sm ${
              isRefreshing ? 'animate-spin' : ''
            }`}
            style={{
              opacity: isRefreshing ? 1 : progress,
              transform: `rotate(${progress * 360}deg)`,
            }}
          >
            <RefreshCw
              className={`h-4 w-4 ${
                progress >= 1 || isRefreshing
                  ? 'text-emerald-400'
                  : 'text-[rgb(var(--muted))]'
              }`}
            />
          </div>
        </div>
      )}

      {/* Content with pull offset */}
      <div
        style={{
          transform: showIndicator
            ? `translateY(${isRefreshing ? 48 : pullDistance}px)`
            : undefined,
          transition: pulling.current ? 'none' : 'transform 0.2s ease-out',
        }}
      >
        {children}
      </div>
    </div>
  )
}
