import { expect, it, vi } from 'vitest'
import CalendarPage from '../page'

const observation = vi.hoisted(() => ({ gridImports: 0 }))
vi.mock('../components/CalendarGrid', () => {
  observation.gridImports += 1
  return { CalendarGrid: () => null }
})

it('does not eagerly import the calendar grid merely by resolving the route entry', () => {
  expect(typeof CalendarPage).toBe('function')
  expect(observation.gridImports).toBe(0)
})
