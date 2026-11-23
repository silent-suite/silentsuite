import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { REQUEST, plainDecodeEntityPlugin, plainEntryFrom } = require('./note-markdown-worker-webpack.js') as {
  REQUEST: RegExp
  plainEntryFrom: (context: string) => string
  plainDecodeEntityPlugin: (webpack: unknown) => unknown
}

// The directory of the package that imports decode-named-character-reference for
// react-markdown, found the way the bundler finds it: through the dependency chain.
function importerDirectory(): string {
  let from = require.resolve('react-markdown')
  for (const name of ['remark-parse', 'mdast-util-from-markdown', 'micromark-util-decode-string']) {
    from = createRequire(from).resolve(name)
  }
  return path.dirname(from)
}

describe('the worker-safe entity decoder', () => {
  it('resolves to the entry that needs no document', () => {
    const entry = plainEntryFrom(importerDirectory())

    expect(path.basename(entry)).toBe('index.js')
    expect(path.basename(path.dirname(entry))).toBe('decode-named-character-reference')
  })

  it('matches only that package, by its exact name', () => {
    expect(REQUEST.test('decode-named-character-reference')).toBe(true)
    expect(REQUEST.test('decode-named-character-reference/index.dom.js')).toBe(false)
    expect(REQUEST.test('character-entities')).toBe(false)
  })

  it('rewrites the request of a module that imports it', () => {
    let seen: { pattern: RegExp; rewrite: (resource: { request: string; context: string }) => void } | undefined
    class FakeReplacement {
      constructor(pattern: RegExp, rewrite: (resource: { request: string; context: string }) => void) {
        seen = { pattern, rewrite }
      }
    }
    plainDecodeEntityPlugin({ NormalModuleReplacementPlugin: FakeReplacement })

    const resource = { request: 'decode-named-character-reference', context: importerDirectory() }
    seen?.rewrite(resource)
    expect(seen?.pattern).toBe(REQUEST)
    expect(path.basename(resource.request)).toBe('index.js')
    expect(path.isAbsolute(resource.request)).toBe(true)
  })
})
