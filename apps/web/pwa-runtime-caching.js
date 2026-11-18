/**
 * Service-worker routes placed ahead of next-pwa's default runtime caching.
 *
 * All cross-origin GETs use NetworkOnly before any default cache route, including
 * requests to user-configured servers and external assets. No options means no
 * cache name or fallback plugin. Keep the explicit Google and Microsoft routes
 * below for their existing exports and tests.
 */
// Match by origin, including user-configured servers, before any default route.
const crossOriginNetworkOnly = {
  urlPattern: ({ sameOrigin }) => !sameOrigin,
  handler: 'NetworkOnly',
  method: 'GET',
}

const GOOGLE_API_URL = /^https:\/\/(?:www|people)\.googleapis\.com\//

const googleApiNetworkOnly = {
  urlPattern: GOOGLE_API_URL,
  handler: 'NetworkOnly',
  method: 'GET',
}

/**
 * Microsoft Graph, for the Microsoft import (#48), likewise. The Microsoft sign-in endpoint
 * (login.microsoftonline.com) is only POSTed to, and runtime caching handles GET only.
 */
const MICROSOFT_GRAPH_URL = /^https:\/\/graph\.microsoft\.com\//

const microsoftGraphNetworkOnly = {
  urlPattern: MICROSOFT_GRAPH_URL,
  handler: 'NetworkOnly',
  method: 'GET',
}

module.exports = {
  GOOGLE_API_URL,
  MICROSOFT_GRAPH_URL,
  runtimeCachingBeforeDefaults: [crossOriginNetworkOnly, googleApiNetworkOnly, microsoftGraphNetworkOnly],
}
