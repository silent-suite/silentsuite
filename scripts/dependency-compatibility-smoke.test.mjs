import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const eslintRequire = createRequire(requireFrom('apps/web/package.json').resolve('eslint/package.json'))
const yamlRequire = createRequire(eslintRequire.resolve('@eslint/eslintrc'))
const yaml = yamlRequire('js-yaml')
const { customAlphabet, nanoid } = requireFrom('node_modules/.pnpm/nanoid@3.3.18/node_modules/nanoid/package.json')('.')
const browserslist = requireFrom('node_modules/.pnpm/browserslist@4.28.8/node_modules/browserslist/package.json')('.')
const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))

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

test('js-yaml 4 parses representative ESLint configuration data', () => {
  assert.deepEqual(yaml.load('rules:\n  no-debugger: error\n'), {
    rules: { 'no-debugger': 'error' },
  })
})

test('js-yaml counts empty merge mappings against the CPU budget', () => {
  assert.equal(yamlRequire('js-yaml/package.json').version, '4.3.2')
  assert.throws(() => yaml.load('arr: &arr [{}, {}, {}]\ntarget: { <<: *arr }\n', {
    maxTotalMergeKeys: 2,
  }), /merge/i)
})

test('Next and its ESLint config stay on the patched compatible release', () => {
  const web = requireFrom('apps/web/package.json')
  assert.equal(web('next/package.json').version, '15.5.24')
  assert.equal(web('eslint-config-next/package.json').version, '15.5.24')
})

test('Next resolves patched Sharp and transforms image data with patched libheif', async () => {
  const web = requireFrom('apps/web/package.json')
  const nextRequire = createRequire(web.resolve('next/package.json'))
  const sharp = nextRequire('sharp')
  assert.equal(sharp.versions.sharp, '0.35.4')
  assert.equal(sharp.versions.heif, '1.23.2')
  assert.equal(requireFrom('package.json')('sharp').versions.sharp, '0.35.4')
  const image = sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } })
  const avif = await image.avif().toBuffer()
  const { info } = await sharp(avif).resize(2, 2).png().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 2)
  assert.equal(info.height, 2)
  assert.equal(info.format, 'png')
})

test('nanoid 3 patched generators preserve normal positive-size behavior', () => {
  assert.equal(nanoid(12).length, 12)
  assert.match(customAlphabet('abc', 8)(), /^[abc]{8}$/)
})

test('browserslist 4 resolves representative production targets', () => {
  const targets = browserslist('last 2 versions')
  assert.ok(targets.length > 0)
  assert.ok(targets.every((target) => typeof target === 'string' && target.length > 0))
})

test('security overrides remain scoped to compatible vulnerable major lines', () => {
  assert.equal(manifest.pnpm.overrides['js-yaml@>=4.0.0 <4.3.2'], '4.3.2')
  assert.equal(manifest.pnpm.overrides['js-yaml@>=3.0.0 <3.15.2'], '3.15.2')
  assert.equal(manifest.pnpm.overrides['nanoid@>=3.0.0 <3.3.18'], '3.3.18')
  assert.equal(manifest.pnpm.overrides['browserslist@>=4.0.0 <4.28.8'], '4.28.8')
  assert.equal(Object.hasOwn(manifest.pnpm.overrides, 'js-yaml'), false)
  assert.equal(Object.hasOwn(manifest.pnpm.overrides, 'nanoid@<3.3.18'), false)
  assert.equal(Object.hasOwn(manifest.pnpm.overrides, 'browserslist'), false)
})
