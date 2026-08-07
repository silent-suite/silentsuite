import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const endpoint = 'https://plausible.silentsuite.io/api/event'

async function withGeneratedAppTree(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'public-analytics-'))
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const file = path.join(root, relativePath)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, contents)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function checkGeneratedAppTree(root) {
  try {
    await execFileAsync(process.execPath, [
      'scripts/check-public-analytics.mjs',
      '--enabled-generated-build',
      `--generated-app-root=${root}`,
    ])
    return ''
  } catch (error) {
    return `${error.stdout}\n${error.stderr}`
  }
}

test('enabled generated app scan fails closed when the subscription route chunk lacks the approved endpoint', async () => {
  await withGeneratedAppTree({
    'settings/subscription/page-a.js': 'console.log("subscription")',
  }, async (root) => {
    assert.match(await checkGeneratedAppTree(root), /subscription route chunk: expected analytics endpoint absent/)
  })
})

test('enabled generated app scan rejects endpoint contamination in sibling authenticated chunks', async () => {
  await withGeneratedAppTree({
    'settings/subscription/page-a.js': endpoint,
    'calendar/page-b.js': endpoint,
  }, async (root) => {
    assert.match(await checkGeneratedAppTree(root), /calendar\/page-b\.js: analytics endpoint in authenticated production bundle/)
  })
})

test('enabled generated app scan permits the endpoint only in the subscription route chunk', async () => {
  await withGeneratedAppTree({
    'settings/subscription/page-a.js': endpoint,
  }, async (root) => {
    assert.equal(await checkGeneratedAppTree(root), '')
  })
})
