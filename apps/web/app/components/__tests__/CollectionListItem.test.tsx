import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CollectionListItem } from '../CollectionListItem'

// Class checks record the intended mobile hit area. They are not measured geometry.

function expectMobileSquare(element: HTMLElement) {
  expect(element.className).toContain('max-md:min-h-[44px]')
  expect(element.className).toContain('max-md:min-w-[44px]')
  expect(element.className).not.toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
}

function renderItem(onDelete = vi.fn()) {
  render(
    <CollectionListItem
      name="Personal"
      color="#f59e0b"
      visible
      isDefault={false}
      canDelete
      itemLabel="notebook"
      defaultLabel="Default notebook"
      deleteLabel="Delete notebook"
      onToggleVisibility={vi.fn()}
      onRename={vi.fn()}
      onSetDefault={vi.fn()}
      onColorChange={vi.fn()}
      onDelete={onDelete}
    />,
  )
  return onDelete
}

describe('CollectionListItem mobile targets', () => {
  it('uses mobile-only 44px classes on the toggle, actions button, and menu items', () => {
    renderItem()
    expectMobileSquare(screen.getByRole('button', { name: 'Hide Personal' }))
    const actions = screen.getByRole('button', { name: 'Open Personal actions' })
    expectMobileSquare(actions)
    expect(actions.parentElement?.className).toContain('w-10')
    expect(actions.parentElement?.className).toContain('max-md:w-auto')

    fireEvent.click(actions)
    for (const name of ['Rename', 'Set as default', 'Change color', 'Delete notebook']) {
      const item = screen.getByRole('menuitem', { name })
      expect(item.className).toContain('max-md:min-h-[44px]')
      expect(item.className).not.toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
    }
  })

  it('focuses the actions button before calling onDelete', () => {
    const onDelete = renderItem()
    const actions = screen.getByRole('button', { name: 'Open Personal actions' })
    fireEvent.click(actions)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete notebook' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(actions)
  })
})
