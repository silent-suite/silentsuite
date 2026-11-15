/*
 * Google OAuth callback for the one-time import (#48). Loaded only by google-callback.html,
 * which pulls in nothing else: no app bundle, no error reporting, no third-party code.
 *
 * Runs in <head>, before the page renders. It first removes the fragment (which carries the
 * access token) from the address bar and history, then checks `state` against the single-use
 * value the opener stored, posts the result to window.opener with this exact origin as
 * targetOrigin, and closes. The token is never stored or logged here.
 * Keep OAUTH_STATE_KEY and OAUTH_MESSAGE_TYPE in step with app/lib/google-import/oauth.ts.
 */
(function (win) {
  'use strict'
  var STATE_KEY = 'silentsuite-google-import-oauth-state'
  var MESSAGE_TYPE = 'silentsuite-google-import-oauth'

  var fragment = win.location.hash
  var query = win.location.search
  try {
    win.history.replaceState(null, '', win.location.pathname)
  } catch (e) {
    // Fall through: the page closes at once either way.
  }

  function show(text) {
    var put = function () {
      var el = win.document.getElementById('status')
      if (el) el.textContent = text
    }
    if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', put)
    else put()
  }

  var params = new URLSearchParams(fragment.charAt(0) === '#' ? fragment.slice(1) : fragment)
  var queryParams = new URLSearchParams(query)
  var state = params.get('state') || queryParams.get('state')

  var stored = null
  try {
    stored = JSON.parse(win.localStorage.getItem(STATE_KEY) || 'null')
    win.localStorage.removeItem(STATE_KEY)
  } catch (e) {
    stored = null
  }

  if (!stored || typeof stored.state !== 'string' || typeof state !== 'string' || stored.state !== state || !(stored.expiresAt > Date.now())) {
    show('This sign-in could not be verified. Close this window and start the import again.')
    return
  }

  var opener = null
  try {
    opener = win.opener
  } catch (e) {
    opener = null
  }
  if (!opener || opener.closed) {
    show('This window lost its connection to SilentSuite. Close it and start the import again.')
    return
  }

  var message = { type: MESSAGE_TYPE, state: state }
  var error = params.get('error') || queryParams.get('error')
  if (error) {
    message.error = String(error).slice(0, 64)
  } else {
    message.accessToken = params.get('access_token')
    message.expiresIn = params.get('expires_in')
    message.scope = params.get('scope')
  }
  opener.postMessage(message, win.location.origin)
  show('Done. You can close this window.')
  win.close()
})(window)
