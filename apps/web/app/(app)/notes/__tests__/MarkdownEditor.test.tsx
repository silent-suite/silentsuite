import { act, render, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from '../MarkdownEditor'

beforeAll(() => {
  // jsdom performs no layout; CodeMirror measures text through these ranges.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect
  const emptyRects = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = emptyRects
  Range.prototype.getBoundingClientRect = () => rect
})

function viewOf(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)
  if (!view) throw new Error('editor did not mount')
  return view
}

describe('MarkdownEditor', () => {
  it('renders the value as a labelled multiline textbox with Markdown highlighting', () => {
    const { container } = render(
      <MarkdownEditor value={'# Title\n\nSome **bold** text'} onChange={() => {}} ariaLabel="Note body" />,
    )
    const textbox = screen.getByRole('textbox', { name: 'Note body' })
    expect(textbox).toHaveAttribute('aria-multiline', 'true')
    expect(viewOf(container).state.doc.toString()).toBe('# Title\n\nSome **bold** text')
    // Highlighting wraps tokens in styled spans; plain text would render bare lines.
    expect(container.querySelector('.cm-line span')).not.toBeNull()
  })

  it('reports edits made in the document exactly, without transforming them', () => {
    const onChange = vi.fn()
    const { container } = render(<MarkdownEditor value="Hello" onChange={onChange} ariaLabel="Note body" />)

    act(() => {
      viewOf(container).dispatch({ changes: { from: 5, insert: ' <b>world</b>  ' } })
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('Hello <b>world</b>  ')
  })

  it('adopts a new value from props without reporting it as an edit', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<MarkdownEditor value="first" onChange={onChange} ariaLabel="Note body" />)

    rerender(<MarkdownEditor value="edited elsewhere" onChange={onChange} ariaLabel="Note body" />)

    expect(viewOf(container).state.doc.toString()).toBe('edited elsewhere')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('blocks editing while read-only and re-enables it afterwards', () => {
    const { container, rerender } = render(<MarkdownEditor value="locked" onChange={() => {}} ariaLabel="Note body" readOnly />)
    const view = viewOf(container)
    expect(view.state.readOnly).toBe(true)
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveAttribute('aria-readonly', 'true')

    rerender(<MarkdownEditor value="locked" onChange={() => {}} ariaLabel="Note body" readOnly={false} />)
    expect(view.state.readOnly).toBe(false)
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveAttribute('aria-readonly', 'false')
  })

  it('continues a Markdown list when Enter is pressed at the end of an item', () => {
    const onChange = vi.fn()
    const { container } = render(<MarkdownEditor value="- item" onChange={onChange} ariaLabel="Note body" />)
    const view = viewOf(container)
    act(() => {
      view.dispatch({ selection: { anchor: 6 } })
      insertNewlineContinueMarkup(view)
    })
    expect(view.state.doc.toString()).toBe('- item\n- ')
    expect(onChange).toHaveBeenLastCalledWith('- item\n- ')
  })

  it('shows the placeholder for an empty document', () => {
    const { container } = render(<MarkdownEditor value="" onChange={() => {}} ariaLabel="Note body" placeholder="Write in Markdown" />)
    expect(container.querySelector('.cm-placeholder')).toHaveTextContent('Write in Markdown')
  })

  it('opens find and replace on Ctrl-f', () => {
    const { container } = render(<MarkdownEditor value="a" onChange={() => {}} ariaLabel="Note body" />)
    const view = viewOf(container)
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    })
    expect(container.querySelector('.cm-panel.cm-search')).not.toBeNull()
  })

  it('indents with Tab, but Escape then Tab leaves the document alone so focus can move on', () => {
    const { container } = render(<MarkdownEditor value="- item" onChange={() => {}} ariaLabel="Note body" />)
    const view = viewOf(container)
    const press = (key: string, keyCode: number) => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true }))
    }
    act(() => {
      view.dispatch({ selection: { anchor: 6 } })
      press('Tab', 9)
    })
    expect(view.state.doc.toString()).toBe('  - item')

    act(() => {
      press('Escape', 27)
      press('Tab', 9)
    })
    expect(view.state.doc.toString()).toBe('  - item')
  })

  it('sets prose in the app font, keeps code monospace, and draws its own caret', () => {
    const { container } = render(<MarkdownEditor value="`code`" onChange={() => {}} ariaLabel="Note body" />)
    const css = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n')
    expect(css).toMatch(/\.cm-scroller\s*\{[^}]*font-family:\s*inherit/)
    expect(css).toMatch(/font-family:\s*ui-monospace/)
    // drawSelection replaces the native caret, which sits above the placeholder on an empty note.
    expect(container.querySelector('.cm-cursorLayer')).not.toBeNull()
  })

  it('keeps the same editor instance when only the class name changes', () => {
    const { container, rerender } = render(<MarkdownEditor value="kept" onChange={() => {}} ariaLabel="Note body" className="shown" />)
    const view = viewOf(container)
    act(() => {
      view.dispatch({ changes: { from: 4, insert: '!' } })
    })

    rerender(<MarkdownEditor value="kept!" onChange={() => {}} ariaLabel="Note body" className="hidden" />)

    expect(viewOf(container)).toBe(view)
    expect(container.firstElementChild).toHaveClass('hidden')
  })
})
