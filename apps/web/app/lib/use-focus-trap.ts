import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Containers of the traps that are open, innermost last. Only the innermost
// trap handles Tab, so a dialog opened over another dialog (for example
// RecurrenceScopeDialog over EventDialog) keeps focus instead of the outer
// trap pulling it back.
const openTraps: HTMLElement[] = []

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    // `offsetParent` is null for fixed-position controls, so using it
    // alone lets focus escape otherwise valid modal dialogs. Preserve the
    // normal visibility test while accepting rendered fixed descendants.
    if (el.closest('[hidden], [aria-hidden="true"]')) return false
    if (el.offsetParent !== null) return true
    const style = window.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

/**
 * Focus the element after (or, with `backwards`, before) `from`, wrapping at
 * the ends. When `from` is not one of the focusable elements, focus the first
 * (or last) one instead.
 */
function focusNeighbour(focusable: HTMLElement[], from: Element | null, backwards: boolean) {
  const index = from ? focusable.indexOf(from as HTMLElement) : -1
  const next =
    index === -1
      ? focusable[backwards ? focusable.length - 1 : 0]
      : focusable[(index + (backwards ? -1 : 1) + focusable.length) % focusable.length]
  next?.focus()
}

/**
 * Trap keyboard focus within a container element.
 * When the dialog is open, Tab and Shift+Tab cycle through focusable elements
 * inside the container, preventing focus from escaping to the background.
 * If focus still ends up outside the container (for example because the
 * element Tab moved to was removed when the previous one blurred, which drops
 * focus to the page body), it is moved back inside.
 *
 * `restoreFocusTo` is the element to return focus to on cleanup. Callers that
 * inert the background must pass the opener captured in their own click
 * handler: React applies `inert`/`aria-hidden` during the mutation phase, and
 * the browser blurs the focused opener before this passive effect ever runs,
 * so `document.activeElement` read from here is already `document.body`.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean = true,
  restoreFocusTo?: HTMLElement | null,
) {
  const restoreFocusToRef = useRef(restoreFocusTo)
  restoreFocusToRef.current = restoreFocusTo

  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    // Store the previously focused element to restore on cleanup
    const previouslyFocused = restoreFocusToRef.current ?? (document.activeElement as HTMLElement | null)

    openTraps.push(container)
    let pendingCheck: ReturnType<typeof setTimeout> | undefined

    function isInnermost() {
      return openTraps[openTraps.length - 1] === container
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !container || !isInnermost()) return

      const focusable = getFocusable(container)

      if (focusable.length === 0) {
        e.preventDefault()
        return
      }

      const current = document.activeElement
      const backwards = e.shiftKey

      // Focus is already outside the dialog (on the page body, say): bring it
      // back in rather than letting Tab continue through the background.
      if (!current || !container.contains(current)) {
        e.preventDefault()
        focusNeighbour(focusable, null, backwards)
        return
      }

      // On the first or last element: wrap around.
      if (current === (backwards ? focusable[0] : focusable[focusable.length - 1])) {
        e.preventDefault()
        focusNeighbour(focusable, current, backwards)
        return
      }

      // Let the browser move focus, then check where it landed. If the target
      // disappeared on blur (the label editor hides its suggestions then),
      // focus falls to the page body; continue from the element Tab started on.
      clearTimeout(pendingCheck)
      pendingCheck = setTimeout(() => {
        if (!isInnermost()) return
        const landed = document.activeElement
        if (landed && container.contains(landed)) return
        const fresh = getFocusable(container)
        if (fresh.length > 0) focusNeighbour(fresh, current, backwards)
      }, 0)
    }

    // Auto-focus the first focusable element inside the container
    requestAnimationFrame(() => {
      if (!container) return
      const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      // Try to focus the first input/textarea, or fall back to first focusable
      const firstInput = container.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled])',
      )
      if (firstInput) {
        firstInput.focus()
      } else if (focusable.length > 0) {
        focusable[0]!.focus()
      }
    })

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      clearTimeout(pendingCheck)
      const index = openTraps.lastIndexOf(container)
      if (index !== -1) openTraps.splice(index, 1)
      // Restore focus to the previously focused element
      previouslyFocused?.focus()
    }
  }, [ref, active])
}
