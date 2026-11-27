import { T, utils } from '@start9labs/start-sdk'
import { chmod } from 'node:fs/promises'
import { storeJson } from '../fileModels/store.json'
import { newSecrets, Secrets, validateSecrets } from '../secrets'
import { sdk } from '../sdk'

// The SDK creates a new file with ordinary creation attributes (usually 0644) and keeps
// the existing mode on later writes, so the store is made owner-only here, on every init.
async function makeStorePrivate() {
  await chmod(sdk.volumes.startos.path, 0o700)
  await chmod(sdk.volumes.startos.subpath('store.json'), 0o600)
}

// FileHelper.json parses with JSON.parse, whose error message can quote part of the file.
// Never let that text (part of a secret) reach the logs: rethrow a fixed message.
async function readStore<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch {
    throw new Error('SilentSuite store.json is unreadable or not valid JSON')
  }
}

export const initializeService = sdk.setupOnInit(async (effects, kind) => {
  if (kind === 'install') {
    await chmod(sdk.volumes.startos.path, 0o700)
    // One write of all three secrets, only for a fresh installation.
    await storeJson.write(effects, newSecrets(utils.getDefaultString))
    await makeStorePrivate()
    return
  }
  // Restart, update or restore: the existing secrets must be complete. Never
  // regenerate them over an existing database or installation credential.
  validateSecrets(await readStore(() => storeJson.read().once()))
  await makeStorePrivate()
})

export async function secretsFromStore(effects: T.Effects): Promise<Secrets> {
  return validateSecrets(await readStore(() => storeJson.read().const(effects)))
}

export async function secretsFromStoreOnce(): Promise<Secrets> {
  return validateSecrets(await readStore(() => storeJson.read().once()))
}
