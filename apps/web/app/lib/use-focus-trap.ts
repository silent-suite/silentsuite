import { useEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Trap keyboard focus within a container element.
 * When the dialog is open, Tab and Shift+Tab cycle through focusable elements
 * inside the container, preventing focus from escaping to the background.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean = true) {
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    // Store the previously focused element to restore on cleanup
    const previouslyFocused = document.activeElement as HTMLElement | null

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !container) return

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null) // visible only

      if (focusable.length === 0) {
        e.preventDefault()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!

      if (e.shiftKey) {
        // Shift+Tab: if focus is on first element, wrap to last
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab: if focus is on last element, wrap to first
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
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
      // Restore focus to the previously focused element
      previouslyFocused?.focus()
    }
  }, [ref, active])
}
