// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// Find the project and workspace directories
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo
config.watchFolders = [monorepoRoot];

// 2. Let Metro know where to resolve packages and in what order
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Redirect libsodium-wrappers to the -sumo build (asm.js, no WASM needed)
// Hermes engine in React Native does not support WebAssembly, so we need the
// pure-JS (asm.js) fallback from libsodium-wrappers-sumo.
config.resolver.extraNodeModules = {
  'libsodium-wrappers': require.resolve('libsodium-wrappers-sumo'),
};

// 4. Handle .js → .ts resolution for packages/core (uses Node ESM .js extensions)
// Metro needs to resolve `import './foo.js'` to `./foo.ts` in workspace packages
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // If importing from a .js file that doesn't exist, try .ts
  if (moduleName.endsWith('.js')) {
    const tsName = moduleName.replace(/\.js$/, '.ts');
    try {
      return context.resolveRequest(context, tsName, platform);
    } catch {
      // Fall through to default resolution
    }
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
