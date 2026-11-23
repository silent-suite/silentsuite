import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadNextConfig } from '@/app/lib/__tests__/load-next-config'

const require = createRequire(import.meta.url)
const { REQUEST } = require('../../../../note-markdown-worker-webpack.js') as { REQUEST: RegExp }

describe('the build settings the Notes preview worker depends on', () => {
  it('adds the plain entity decoder replacement to the webpack config', () => {
    const { config } = loadNextConfig()
    class FakeReplacement {
      constructor(
        public pattern: RegExp,
        public rewrite: (resource: { request: string; context: string }) => void,
      ) {}
    }
    const webpackConfig: { resolve: Record<string, unknown>; plugins: unknown[] } = { resolve: {}, plugins: [] }

    config.webpack?.(webpackConfig, { webpack: { NormalModuleReplacementPlugin: FakeReplacement } })

    const replacements = webpackConfig.plugins.filter((plugin): plugin is FakeReplacement => plugin instanceof FakeReplacement)
    expect(replacements).toHaveLength(1)
    expect(replacements[0].pattern).toBe(REQUEST)
    expect(replacements[0].pattern.test('decode-named-character-reference')).toBe(true)
  })

  it('creates the worker from the file next to the page, in the form the bundler can find', () => {
    const notes = path.resolve(__dirname, '..')
    const source = readFileSync(path.join(notes, 'NoteMarkdownPreview.tsx'), 'utf8')

    // The bundler finds a worker file from this exact call; a variable or a wrapper
    // would leave it out of the build, and every note would show as plain text.
    expect(source).toContain("new Worker(new URL('./note-markdown-probe.worker.ts', import.meta.url))")
    expect(readFileSync(path.join(notes, 'note-markdown-probe.worker.ts'), 'utf8')).toContain('scope.onmessage')
  })
})
