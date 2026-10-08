import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The etebase SDK is consumed through a pnpm patch (patches/etebase@0.43.1.patch).
// pnpm refuses a frozen install when a declared patch file is missing, so every
// image that installs dependencies must copy the patches before installing.

const repoRoot = resolve(import.meta.dirname, '../../../..');
const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const patchedDependencies: Record<string, string> = rootManifest.pnpm?.patchedDependencies ?? {};

describe('etebase SDK patch packaging contract', () => {
  it('declares the etebase patch and ships the patch file', () => {
    expect(patchedDependencies['etebase@0.43.1']).toBe('patches/etebase@0.43.1.patch');
    for (const patchPath of Object.values(patchedDependencies)) {
      expect(existsSync(resolve(repoRoot, patchPath)), patchPath).toBe(true);
    }
  });

  it('copies patches into Dockerfile.web before the frozen dependency install', () => {
    const lines = readFileSync(resolve(repoRoot, 'Dockerfile.web'), 'utf8').split('\n');
    const install = lines.findIndex((line) => /^RUN pnpm install --frozen-lockfile\b/.test(line));
    expect(install).toBeGreaterThan(-1);
    const depsStage = lines.slice(0, install).filter((line) => /^COPY\s/.test(line));
    for (const patchPath of Object.values(patchedDependencies)) {
      const dir = patchPath.split('/')[0];
      expect(
        depsStage.some((line) => new RegExp(`^COPY\\s+${dir}/?\\s+${dir}/?$`).test(line.trim())),
        `Dockerfile.web must COPY ${dir}/ before pnpm install --frozen-lockfile`,
      ).toBe(true);
    }
  });
});
