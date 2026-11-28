// The Android bundle carries no error reporter: next.config.js points
// `@sentry/nextjs` here for that build, so every call is a no-op and the
// reporter's code never reaches the app.
const noop = () => undefined

module.exports = new Proxy({ __esModule: false }, {
  get: (target, prop) => (prop in target ? target[prop] : noop),
})
