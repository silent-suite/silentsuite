#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const otherRoot = process.argv[2]
assert(otherRoot && process.argv.length === 3, 'usage: node scripts/check-annual-public-contract-copy.mjs <other-worktree>')
const files = ['contracts/annual-only-public-review-v2.schema.json', 'contracts/annual-only-public-disclosure-v2.schema.json', 'contracts/annual-only-pre-public-admission.schema.json', 'contracts/annual-only-public-review-v2.wire-vector.json', 'contracts/annual-only-billing-v2.schema.json', 'contracts/annual-only-billing-v2.schema.sha256']
for (const file of files) assert.deepEqual(readFileSync(file), readFileSync(path.join(otherRoot, file)), `${file} is not byte-identical across worktrees`)
console.log(`annual public contract promotion gate passed (${files.length} bounded files)`)
