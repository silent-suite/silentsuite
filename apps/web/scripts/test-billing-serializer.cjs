// Optional cross-repository contract test: execute the real Billing routes and serializer.
// No schema copies: BILLING_CONTRACT_ROOT must point to an installed Billing app.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const root = process.argv[2]
const routePath = path.join(root, 'src/routes/annual-v2.ts')
const billingRequire = Module.createRequire(path.join(root, 'package.json'))
const compiled = ts.transpileModule(fs.readFileSync(routePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const routeModule = new Module(routePath)
routeModule.filename = routePath
routeModule.paths = Module._nodeModulePaths(path.dirname(routePath))
routeModule._compile(compiled, routePath)
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
async function main() {
  const app = billingRequire('fastify')()
  const result = { ...input.completed, createdAt: new Date(input.createdAt) }
  await app.register(routeModule.exports.createAnnualV2Routes({
    provision: async () => result,
    finalize: async () => result,
  }))
  try {
    const response = await app.inject({ method: 'POST', url: input.url, payload: input.payload })
    process.stdout.write(JSON.stringify({ status: response.statusCode, body: response.body }))
  } finally { await app.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
