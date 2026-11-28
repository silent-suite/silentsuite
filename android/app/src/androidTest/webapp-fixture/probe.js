// Runs inside the fixture pages of WebAppActivityRuntimeTest. The test starts a
// probe with fixture.run(name) and polls fixture.result(name) for its outcome.
(function () {
  'use strict'

  var out = {}

  function nameOf(error) {
    return String((error && error.name) || error)
  }

  function hex(buffer) {
    var bytes = new Uint8Array(buffer)
    var text = ''
    for (var i = 0; i < bytes.length; i++) text += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
    return text
  }

  function within(milliseconds, promise) {
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        setTimeout(function () { resolve('timeout') }, milliseconds)
      }),
    ])
  }

  /** Opens a database, writes one value and reads it back. */
  function indexedDbRoundTrip() {
    return new Promise(function (resolve, reject) {
      var open = indexedDB.open('fixture', 1)
      open.onupgradeneeded = function () { open.result.createObjectStore('values') }
      open.onerror = function () { reject(open.error) }
      open.onsuccess = function () {
        var db = open.result
        var read
        var transaction = db.transaction('values', 'readwrite')
        var store = transaction.objectStore('values')
        store.put('stored', 'key')
        var get = store.get('key')
        get.onsuccess = function () { read = get.result }
        transaction.oncomplete = function () { db.close(); resolve(read) }
        transaction.onerror = function () { db.close(); reject(transaction.error) }
        transaction.onabort = function () { db.close(); reject(transaction.error) }
      }
    })
  }

  function policy() {
    var result = {
      hashedInline: window.fixtureHashedInline === true,
      unhashedInline: window.fixtureUnhashedInline === true,
    }
    try { result.eval = 'ran:' + (0, eval)('1 + 1') } catch (error) { result.eval = nameOf(error) }
    try { result.newFunction = 'ran:' + new Function('return 2')() } catch (error) { result.newFunction = nameOf(error) }
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')).then(function (digest) {
      result.digest = hex(digest)
      return indexedDbRoundTrip()
    }).then(function (read) {
      result.indexedDb = read
      return result
    })
  }

  /** The status and text of an answer, or the name of the error that prevented one. */
  function answer(request) {
    return request.then(function (response) {
      return response.text().then(function (text) { return { status: response.status, body: text } })
    }).catch(function (error) {
      return { error: nameOf(error) }
    })
  }

  /** Puts a bundled page into a frame and reports whether its document arrived. */
  function frame() {
    return new Promise(function (resolve) {
      var element = document.createElement('iframe')
      var finished = false
      function finish(event) {
        if (finished) return
        finished = true
        var title = null
        try { title = element.contentDocument ? element.contentDocument.title : null } catch (error) { title = null }
        element.remove()
        resolve({ event: event, title: title })
      }
      element.onload = function () { finish('load') }
      element.onerror = function () { finish('error') }
      setTimeout(function () { finish('timeout') }, 3000)
      element.src = '/calendar/'
      document.body.appendChild(element)
    })
  }

  function serviceWorker() {
    if (!navigator.serviceWorker) return Promise.resolve('unavailable')
    return within(10000, navigator.serviceWorker.register('/sw.js').then(function (registration) {
      return registration.unregister().then(function () { return 'registered' })
    }, function (error) {
      return 'rejected:' + nameOf(error)
    }))
  }

  function boundary() {
    var result = {}
    return answer(fetch('/not-in-the-bundle')).then(function (missing) {
      result.missing = missing
      return answer(fetch('https://foreign.invalid/data'))
    }).then(function (foreign) {
      result.foreign = foreign
      return answer(fetch('/login/', { method: 'POST', body: 'x' }))
    }).then(function (post) {
      result.post = post
      return frame()
    }).then(function (framed) {
      result.frame = framed
      return serviceWorker()
    }).then(function (worker) {
      result.serviceWorker = worker
      return result
    })
  }

  /** One round trip through the app's request handling; the test uses it to let a navigation settle. */
  function ping() {
    return answer(fetch('/probe.js')).then(function (probe) { return { status: probe.status } })
  }

  function cookie() {
    var match = /(?:^|; )fixture=([^;]*)/.exec(document.cookie)
    return match ? match[1] : null
  }

  var probes = { policy: policy, boundary: boundary, ping: ping }

  window.fixture = {
    run: function (name) {
      out[name] = null
      var started
      try { started = probes[name]() } catch (error) { started = Promise.reject(error) }
      started.then(function (value) {
        out[name] = { value: value }
      }, function (error) {
        out[name] = { error: nameOf(error) }
      })
      return name
    },
    result: function (name) {
      return out[name] ? JSON.stringify(out[name]) : null
    },
    stored: function () {
      return JSON.stringify({ local: localStorage.getItem('fixture'), cookie: cookie() })
    },
    store: function (value) {
      localStorage.setItem('fixture', value)
      document.cookie = 'fixture=' + value + '; Path=/; Secure; Max-Age=3600; SameSite=Lax'
      return window.fixture.stored()
    },
  }
})()
