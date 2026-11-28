#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const otherRoot = process.argv[2]
assert(otherRoot && process.argv.length === 3, 'usage: node scripts/check-annual-public-contract-copy.mjs <private-checkout>')
const files = ['contracts/annual-only-billing-v2.schema.json', 'contracts/annual-only-billing-v2.schema.sha256']
for (const file of files) assert.deepEqual(readFileSync(file), readFileSync(path.join(otherRoot, file)), `${file} is not byte-identical across worktrees`)
console.log(`annual billing v2 contract copy check passed (${files.length} bounded files)`)
