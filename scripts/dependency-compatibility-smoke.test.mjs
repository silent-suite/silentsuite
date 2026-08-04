import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

function requireFrom(packagePath) {
  return createRequire(resolve(import.meta.dirname, '..', packagePath))
}

const minimatch3 = requireFrom('node_modules/.pnpm/minimatch@3.1.5/node_modules/minimatch/package.json')('.')
const minimatch5 = requireFrom('node_modules/.pnpm/minimatch@5.1.9/node_modules/minimatch/package.json')('.')
const minimatch10 = requireFrom('node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/package.json')('.').minimatch
const Ajv = requireFrom('node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/package.json')('.')
const addFormats = requireFrom('node_modules/.pnpm/ajv-formats@2.1.1_ajv@8.18.0/node_modules/ajv-formats/package.json')('.')
const { JSDOM } = requireFrom('apps/web/package.json')('jsdom')

for (const [line, minimatch] of [['3', minimatch3], ['5', minimatch5], ['10', minimatch10]]) {
  test(`minimatch ${line} preserves brace alternation, ranges, escapes, matches, and non-matches`, () => {
    assert.equal(minimatch('src/a.js', 'src/{a,b}.js'), true)
    assert.equal(minimatch('file3.txt', 'file{1..3}.txt'), true)
    assert.equal(minimatch('file4.txt', 'file{1..3}.txt'), false)
    assert.equal(minimatch('literal{a}.txt', 'literal\\{a\\}.txt'), true)
    assert.equal(minimatch('src/c.js', 'src/{a,b}.js'), false)
  })
}

test('AJV 8 validates URI format through patched fast-uri', () => {
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  const validate = ajv.compile({ type: 'string', format: 'uri' })
  assert.equal(validate('https://silent-suite.example/path?item=1'), true)
  assert.equal(validate('not a uri'), false)
})

test('jsdom constructs and tears down through its patched undici dependency path', () => {
  const dom = new JSDOM('<!doctype html><p id="status">ready</p>', { url: 'https://silent-suite.example/' })
  assert.equal(dom.window.document.querySelector('#status')?.textContent, 'ready')
  assert.equal(dom.window.location.origin, 'https://silent-suite.example')
  dom.window.close()
})
