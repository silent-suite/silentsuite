'use client'

import { useEffect, useRef, useState } from 'react'

type Checkpoint = { step: string; view: string }
type Recovery = 'review' | 'setup' | 'payment'
const KEY = 'silentsuiteSignup'

/** History contains presentation state only, never proof, password or payment capabilities. */
export function useSignupNavigation({ enabled, step, view, restore, intercept }: {
  enabled: boolean
  step: string
  view: string
  intercept?: () => boolean
  restore: (checkpoint: Checkpoint) => boolean
}) {
  const journey = useRef<string | null>(null)
  const phase = useRef<Recovery>('review')
  const latest = useRef({ step, view, restore, intercept })
  latest.current = { step, view, restore, intercept }
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [notice, setNotice] = useState(false)

  useEffect(() => {
    const saved = window.history.state?.[KEY]
    const params = new URLSearchParams(window.location.search)
    // A fresh delivered link has its own validated continuation. Never replay
    // the old link or a mutation merely because the page was refreshed.
    if (!params.has('token') && !params.has('email_verification_token') && saved?.version === 1) {
      let mutation: string | null = null
      try { mutation = sessionStorage.getItem(`${KEY}:${saved.journey}`) } catch { /* Fall back to the current checkpoint. */ }
      const previousPhase = mutation ?? saved.phase
      setRecovery(previousPhase === 'setup' || previousPhase === 'payment' ? previousPhase : 'review')
    }
  }, [])

  useEffect(() => {
    if (!enabled || recovery) return
    if (!journey.current) journey.current = crypto.randomUUID()
    const saved = window.history.state?.[KEY]
    const checkpoint = { version: 1, journey: journey.current, step, view, phase: phase.current }
    if (saved?.journey !== journey.current) {
      window.history.replaceState({ ...window.history.state, [KEY]: checkpoint }, '')
    } else if (saved.step !== step || saved.view !== view) {
      window.history.pushState({ ...window.history.state, [KEY]: checkpoint }, '')
    }
  }, [enabled, recovery, step, view])

  useEffect(() => {
    if (!enabled || recovery) return
    const onPop = (event: PopStateEvent) => {
      const saved = event.state?.[KEY]
      if (!latest.current.intercept?.() && saved?.journey === journey.current && latest.current.restore(saved)) {
        setNotice(false)
        return
      }
      // Unsupported/irreversible checkpoints are not permission to rerun setup.
      setNotice(true)
      window.history.replaceState({ ...window.history.state, [KEY]: {
        version: 1, journey: journey.current, step: latest.current.step,
        view: latest.current.view, phase: phase.current,
      } }, '')
    }
    const onLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('popstate', onPop)
    window.addEventListener('beforeunload', onLeave)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('beforeunload', onLeave)
    }
  }, [enabled, recovery])

  const markMutation = (next: 'setup' | 'payment') => {
    try {
      sessionStorage.setItem(`${KEY}:${journey.current}`, next)
    } catch {
      throw new Error('Unable to save signup recovery progress. Free up browser storage or enable site storage, then retry.')
    }
    phase.current = next
    // Synchronous: a refresh during the very first request must be recovery,
    // even before React publishes loading state. This marker grants no authority.
    window.history.replaceState({ ...window.history.state, [KEY]: {
      version: 1, journey: journey.current, step, view, phase: next,
    } }, '')
  }
  const clear = () => {
    const state = { ...window.history.state }
    try { sessionStorage.removeItem(`${KEY}:${journey.current ?? state[KEY]?.journey}`) } catch { /* No authority is stored here. */ }
    delete state[KEY]
    window.history.replaceState(state, '')
    journey.current = null
    phase.current = 'review'
    setRecovery(null)
  }
  const retireCheckpoints = () => {
    // Retire stale Back/Forward presentation without forgetting possible account creation.
    journey.current = crypto.randomUUID()
    window.history.replaceState({ ...window.history.state, [KEY]: {
      version: 1, journey: journey.current, step: latest.current.step,
      view: latest.current.view, phase: phase.current,
    } }, '')
    setNotice(false)
  }
  return { recovery, notice, markMutation, clear, retireCheckpoints }
}
