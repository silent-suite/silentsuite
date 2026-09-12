// Immutable Android identity from the release source tree, read as data.
// Never execute Gradle, never run scripts from the tag.

const DEFAULT_CONFIG = /defaultConfig\s*\{([\s\S]*?)\n    \}/
const VERSION_CODE = /^\s*versionCode\s+([0-9]+)\s*$/gm
const VERSION_NAME = /^\s*versionName\s+"([0-9A-Za-z.+-]+)"\s*$/gm
const SOURCE_PATH = 'android/app/build.gradle'

export const SOURCE_BUILD_GRADLE = SOURCE_PATH

export function parseSourceBuildMetadata(text) {
  if (typeof text !== 'string' || text === '') throw new Error(`${SOURCE_PATH} is empty`)
  const block = DEFAULT_CONFIG.exec(text)
  if (!block) throw new Error(`${SOURCE_PATH} has no defaultConfig block`)
  const body = block[1]
  if (/\bversionCode\b(?!\s+[0-9]+\s*$)/m.test(body) || /\bversionName\s+(?!"[0-9A-Za-z.+-]+")/m.test(body)) {
    throw new Error(`${SOURCE_PATH} defaultConfig identity is not a literal versionCode/versionName`)
  }
  const codes = [...body.matchAll(VERSION_CODE)]
  const names = [...body.matchAll(VERSION_NAME)]
  if (codes.length !== 1) throw new Error(`${SOURCE_PATH} must declare exactly one literal versionCode`)
  if (names.length !== 1) throw new Error(`${SOURCE_PATH} must declare exactly one literal versionName`)
  const versionCode = Number(codes[0][1])
  if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error(`${SOURCE_PATH} versionCode is not a positive integer`)
  return { versionCode, versionName: names[0][1], path: SOURCE_PATH }
}
