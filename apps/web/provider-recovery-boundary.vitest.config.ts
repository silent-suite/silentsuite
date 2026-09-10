import path from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

// Explicit cross-repository gate. Missing private source is an error, never a skip.
const billing = process.env.ANNUAL_BILLING_WORKTREE
if (!billing) throw new Error('ANNUAL_BILLING_WORKTREE must identify the private candidate root')
const config = mergeConfig(base, defineConfig({
  resolve: { alias: { '@billing-recovery-fixture': path.resolve(billing, 'apps/billing/src/services/__tests__/fixtures/provider-recovery-boundary.ts') } },
  test: { include: ['app/(auth)/signup/pending-payment/__tests__/provider-runtime-boundary.contract.tsx'] },
}))

// mergeConfig concatenates arrays; run only this explicit boundary gate.
config.test!.include = ['app/(auth)/signup/pending-payment/__tests__/provider-runtime-boundary.contract.tsx']
export default config
