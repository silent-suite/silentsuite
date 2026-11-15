/**
 * Service-worker routes placed ahead of next-pwa's default runtime caching.
 *
 * The defaults send every cross-origin GET through NetworkFirst into a "cross-origin"
 * CacheStorage cache, which would keep the Google import's requests (with their
 * Authorization header) and plaintext responses (#48). Google's API hosts are therefore
 * NetworkOnly: never read from or written to any cache. No `options`, so next-pwa adds no
 * fallback plugin and no cache name to it.
 */
const GOOGLE_API_URL = /^https:\/\/(?:www|people)\.googleapis\.com\//

const googleApiNetworkOnly = {
  urlPattern: GOOGLE_API_URL,
  handler: 'NetworkOnly',
  method: 'GET',
}

module.exports = { GOOGLE_API_URL, runtimeCachingBeforeDefaults: [googleApiNetworkOnly] }
