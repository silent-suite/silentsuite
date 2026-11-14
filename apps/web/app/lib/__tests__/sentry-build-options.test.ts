// @vitest-environment node
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { glitchtipSourceMapUpload } = require('../../../sentry-build-options.js') as {
  glitchtipSourceMapUpload: (env: Record<string, string | undefined>) => Record<string, unknown>
}

const complete = {
  GLITCHTIP_URL: 'https://errors.silentsuite.io/',
  GLITCHTIP_ORG: 'silentsuite',
  GLITCHTIP_PROJECT: 'web',
  GLITCHTIP_AUTH_TOKEN: 'token',
  SILENTSUITE_PUBLIC_BUILD_SHA: 'b'.repeat(40),
}

describe('GlitchTip source map upload options', () => {
  it('generates no source maps and creates no release without every upload setting', () => {
    for (const missing of Object.keys(complete)) {
      expect(glitchtipSourceMapUpload({ ...complete, [missing]: undefined })).toEqual({
        sourcemaps: { disable: true },
        release: { create: false, finalize: false },
      })
    }
    expect(glitchtipSourceMapUpload({ ...complete, SILENTSUITE_PUBLIC_BUILD_SHA: 'main' })).toMatchObject({ sourcemaps: { disable: true } })
  })

  it('uploads to GlitchTip under the build SHA and deletes the maps afterwards', () => {
    expect(glitchtipSourceMapUpload(complete)).toEqual({
      sentryUrl: 'https://errors.silentsuite.io/',
      org: 'silentsuite',
      project: 'web',
      authToken: 'token',
      sourcemaps: { deleteSourcemapsAfterUpload: true },
      release: { name: 'b'.repeat(40), create: true, finalize: true },
    })
  })
})
