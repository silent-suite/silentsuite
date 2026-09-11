'use client'

import { useEffect, useRef, useState } from 'react'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  readOnly?: boolean
  placeholder?: string
  className?: string
}

/** Marks document replacements that come from props, so they are not reported as edits. */
const externalChange = Annotation.define<boolean>()

// Colours come from the app's theme variables so light and dark mode both work.
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.9375rem',
    color: 'rgb(var(--foreground))',
    backgroundColor: 'rgb(var(--surface))',
  },
  '.cm-scroller': {
    // Prose is set in the app's face; code spans switch back to monospace below.
    fontFamily: 'inherit',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { padding: '0.75rem' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--foreground))' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(16, 185, 129, 0.25)',
  },
  '.cm-selectionMatch': { backgroundColor: 'rgba(16, 185, 129, 0.15)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(245, 158, 11, 0.35)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(245, 158, 11, 0.6)' },
  '.cm-placeholder': { color: 'rgb(var(--muted))' },
  '.cm-panels': {
    backgroundColor: 'rgb(var(--background))',
    color: 'rgb(var(--foreground))',
    borderColor: 'rgb(var(--border))',
  },
  '.cm-panel.cm-search': { padding: '0.5rem 0.75rem' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    backgroundColor: 'rgb(var(--surface))',
    color: 'rgb(var(--foreground))',
    border: '1px solid rgb(var(--border))',
    borderRadius: '0.375rem',
    padding: '0.125rem 0.5rem',
    margin: '0.125rem',
  },
  '.cm-panel.cm-search label': { marginRight: '0.5rem' },
})

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.heading1, fontSize: '1.25em' },
  { tag: tags.heading2, fontSize: '1.15em' },
  { tag: tags.heading3, fontSize: '1.05em' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'rgb(16, 185, 129)', textDecoration: 'underline' },
  {
    tag: tags.monospace,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '0.9em',
    backgroundColor: 'rgb(var(--background))',
    borderRadius: '0.25rem',
  },
  { tag: tags.quote, color: 'rgb(var(--muted))', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.meta, tags.labelName, tags.contentSeparator], color: 'rgb(var(--muted))' },
])

function readOnlyExtension(readOnly: boolean): Extension {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ 'aria-readonly': readOnly ? 'true' : 'false' }),
  ]
}

function placeholderFor(text: string): Extension {
  return text ? placeholderExtension(text) : []
}

/**
 * Plain-text Markdown editor built on CodeMirror 6: syntax highlighting, list
 * and quote continuation on Enter, Tab/Shift-Tab indentation, undo history,
 * find and replace (Mod-f). Keyboard focus can still leave the editor through
 * CodeMirror's tab-focus mode: Escape then Tab, or Ctrl-m to toggle it.
 * Text is set in the app font and wraps to the editor width; code spans stay monospace.
 * The document is never transformed; what the user types is what gets encrypted.
 */
export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  readOnly = false,
  placeholder = '',
  className,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const initialRef = useRef({ value, ariaLabel, readOnly, placeholder })
  // Compartments let individual extensions be swapped later without rebuilding the editor.
  const [compartments] = useState(() => ({
    readOnly: new Compartment(),
    placeholder: new Compartment(),
    label: new Compartment(),
  }))

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = initialRef.current
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          markdown(),
          history(),
          // Draw the caret and selection here rather than with the browser's own
          // caret, which sits above the placeholder text on an empty note.
          drawSelection(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.lineWrapping,
          syntaxHighlighting(markdownHighlight),
          editorTheme,
          compartments.label.of(EditorView.contentAttributes.of({ 'aria-label': initial.ariaLabel })),
          compartments.placeholder.of(placeholderFor(initial.placeholder)),
          compartments.readOnly.of(readOnlyExtension(initial.readOnly)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (update.transactions.some((transaction) => transaction.annotation(externalChange))) return
            onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [compartments])

  // A value that differs from the document came from outside (a sync refresh
  // the parent adopted); replace the document without reporting it as an edit.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: externalChange.of(true),
    })
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.readOnly.reconfigure(readOnlyExtension(readOnly)) })
  }, [readOnly, compartments])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.placeholder.reconfigure(placeholderFor(placeholder)) })
  }, [placeholder, compartments])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': ariaLabel })),
    })
  }, [ariaLabel, compartments])

  return <div ref={hostRef} className={className} />
}
