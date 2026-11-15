/*
 * Microsoft OAuth callback for the one-time import (#48). Loaded only by
 * microsoft-callback.html, which pulls in nothing else: no app bundle, no error reporting,
 * no third-party code.
 *
 * Runs in <head>, before the page renders. It first removes the fragment (which carries the
 * authorization code) from the address bar and history, then checks `state` against the
 * single-use value the opener stored, posts the result to window.opener with this exact
 * origin as targetOrigin, and closes. It forwards only the code, or an OAuth error code plus
 * the bare AADSTS numbers from error_description, never its free text. The code is useless
 * without the PKCE verifier, which only the opener holds. Nothing is stored or logged here.
 * Keep STATE_KEY and MESSAGE_TYPE in step with app/lib/microsoft-import/oauth.ts.
 */
(function (win) {
  'use strict'
  var STATE_KEY = 'silentsuite-microsoft-import-oauth-state'
  var MESSAGE_TYPE = 'silentsuite-microsoft-import-oauth'
  var MAX_CODE_LENGTH = 16384
  var MAX_ERROR_CODES = 5

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
  function param(name) {
    return params.get(name) || queryParams.get(name)
  }
  var state = param('state')

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
  var error = param('error')
  var code = param('code')
  if (error) {
    // An OAuth error code is a short token; anything else is replaced rather than forwarded.
    message.error = /^[A-Za-z0-9_]{1,64}$/.test(error) ? error : 'invalid_response'
    var codes = []
    var pattern = /AADSTS(\d{1,8})/g
    var description = String(param('error_description') || '').slice(0, 4096)
    var match
    while ((match = pattern.exec(description)) && codes.length < MAX_ERROR_CODES) codes.push(match[1])
    message.errorCodes = codes
  } else if (code && code.length <= MAX_CODE_LENGTH) {
    message.code = code
  } else {
    message.error = 'invalid_response'
    message.errorCodes = []
  }
  opener.postMessage(message, win.location.origin)
  show('Done. You can close this window.')
  win.close()
})(window)
