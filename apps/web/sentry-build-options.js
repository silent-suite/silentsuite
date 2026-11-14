// Source maps go to GlitchTip only when every upload setting is present at
// build time; otherwise none are generated. They are deleted after upload and
// never served.
function glitchtipSourceMapUpload(env = process.env) {
  const ready = Boolean(env.GLITCHTIP_URL && env.GLITCHTIP_ORG && env.GLITCHTIP_PROJECT && env.GLITCHTIP_AUTH_TOKEN)
    && /^[0-9a-f]{40}$/.test(env.SILENTSUITE_PUBLIC_BUILD_SHA ?? '')
  if (!ready) return { sourcemaps: { disable: true }, release: { create: false, finalize: false } }
  return {
    sentryUrl: env.GLITCHTIP_URL,
    org: env.GLITCHTIP_ORG,
    project: env.GLITCHTIP_PROJECT,
    authToken: env.GLITCHTIP_AUTH_TOKEN,
    sourcemaps: { deleteSourcemapsAfterUpload: true },
    release: { name: env.SILENTSUITE_PUBLIC_BUILD_SHA, create: true, finalize: true },
  }
}

module.exports = { glitchtipSourceMapUpload }
