import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pnpmStore = resolve('node_modules/.pnpm');
const entries = readdirSync(pnpmStore);
const expected = [
  [/^minimatch@3\.1\.5_patch_hash=/, '3.1.5'],
  [/^minimatch@5\.1\.9_patch_hash=/, '5.1.9'],
  [/^minimatch@10\.2\.4$/, '10.2.4'],
];

for (const [pattern, version] of expected) {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new Error(`Expected one installed minimatch ${version}, found ${matches.length}`);
  }

  const loaded = require(resolve(pnpmStore, matches[0], 'node_modules/minimatch'));
  const minimatch = typeof loaded === 'function' ? loaded : loaded.minimatch;
  if (
    typeof minimatch !== 'function' ||
    !minimatch('a.js', '{a,b}.js') ||
    minimatch('c.js', '{a,b}.js')
  ) {
    throw new Error(`Brace glob compatibility failed for minimatch ${version}`);
  }
}

console.log('Minimatch brace compatibility: 3.1.5, 5.1.9, and 10.2.4 passed.');
