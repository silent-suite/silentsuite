import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { NoteMarkdownPreview } from '../NoteMarkdownPreview'

// A stand-in for the parser that overflows the stack on a body containing
// BOOM, the way react-markdown does on a note nested thousands of levels deep.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    if (children.includes('BOOM')) throw new RangeError('Maximum call stack size exceeded')
    return <p data-testid="parsed">{children}</p>
  },
}))

describe('NoteMarkdownPreview when the parser fails', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows the body as plain text, never as markup, instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = 'BOOM <b>bold</b> [x](https://example.com)'
    const view = renderWithIntl(<NoteMarkdownPreview content={body} />)

    const plain = view.container.querySelector('[data-note-preview="plain-text"]')
    expect(plain).toHaveTextContent(body)
    expect(view.container.querySelector('b, a')).toBeNull()
  })

  it('tries the next body again after a failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = renderWithIntl(<NoteMarkdownPreview content="BOOM" />)
    expect(view.container.querySelector('[data-note-preview="plain-text"]')).not.toBeNull()

    view.rerender(<NoteMarkdownPreview content="fine" />)
    expect(view.container.querySelector('[data-note-preview="plain-text"]')).toBeNull()
    expect(view.getByTestId('parsed')).toHaveTextContent('fine')
  })
})
