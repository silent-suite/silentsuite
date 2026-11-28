package io.silentsuite.sync.ui.webapp

import io.silentsuite.sync.ui.webapp.WebAppRequestPolicy.Navigation
import io.silentsuite.sync.ui.webapp.WebAppRequestPolicy.Origin
import io.silentsuite.sync.ui.webapp.WebAppRequestPolicy.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WebAppRequestPolicyTest {
    private val policy = WebAppRequestPolicy(
        appOrigin = Origin("https", "app.silentsuite.io", 443),
        connectOrigins = setOf(Origin("https", "server.silentsuite.io", 443), Origin("https", "api.silentsuite.io", 443)),
        bundledPaths = setOf("/login/", "/calendar/", "/calendar/index.txt", "/_next/static/chunks/app/(app)/calendar/page-1.js"),
    )

    private fun get(url: String, mainFrame: Boolean = false) = policy.request(url, "GET", mainFrame)

    @Test
    fun bundledPagesAndFilesAreAnsweredLocally() {
        assertEquals(Request.Bundled("/login/"), get("https://app.silentsuite.io/login/", mainFrame = true))
        assertEquals(Request.Bundled("/calendar/index.txt"), get("https://app.silentsuite.io/calendar/index.txt?_rsc=abc"))
        assertEquals(
            Request.Bundled("/_next/static/chunks/app/(app)/calendar/page-1.js"),
            get("https://app.silentsuite.io/_next/static/chunks/app/(app)/calendar/page-1.js"),
        )
        assertEquals(Request.Bundled("/login/"), get("HTTPS://APP.SilentSuite.io:443/login/#android-account=a%40b.example"))
        assertEquals(Request.Bundled("/login/"), policy.request("https://app.silentsuite.io/login/", "HEAD", false))
    }

    @Test
    fun theAppAddressIsNeverFetchedFromTheNetwork() {
        // Pages the web app has but the bundle leaves out, and its server routes.
        for (path in listOf("/settings/", "/signup/", "/api/event", "/sw.js", "/calendar", "/login/index.html", "/calendar/../settings/", "/%2e%2e/")) {
            assertEquals(path, Request.NotFound, get("https://app.silentsuite.io$path"))
            assertEquals(path, Request.NotFound, get("https://app.silentsuite.io$path", mainFrame = true))
        }
        assertEquals(Request.MethodNotAllowed, policy.request("https://app.silentsuite.io/api/event", "POST", false))
        assertEquals(Request.MethodNotAllowed, policy.request("https://app.silentsuite.io/login/", "POST", true))
    }

    @Test
    fun onlyTheSyncServerAndBillingApiAreReachedAndNeverAsAPage() {
        assertEquals(Request.Network, policy.request("https://server.silentsuite.io/api/v1/authentication/login/", "POST", false))
        assertEquals(Request.Network, get("https://api.silentsuite.io/subscription"))
        assertEquals(Request.Blocked, get("https://server.silentsuite.io/", mainFrame = true))
        assertEquals(Request.Blocked, get("https://api.silentsuite.io/", mainFrame = true))
    }

    @Test
    fun everythingElseIsBlocked() {
        for (url in listOf(
            "https://example.org/x.js",
            "https://o1.ingest.sentry.io/api/1/envelope/",
            "https://plausible.silentsuite.io/api/event",
            "https://js.stripe.com/v3/",
            "http://app.silentsuite.io/login/",
            "http://server.silentsuite.io/",
            "https://app.silentsuite.io:8443/login/",
            "https://server.silentsuite.io:444/",
            "https://app.silentsuite.io.example.org/login/",
            "https://user@app.silentsuite.io/login/",
            "https://app.silentsuite.io@example.org/login/",
            "https://server.silentsuite.io\\@example.org/",
            "file:///android_asset/webapp/manifest.json",
            "content://io.silentsuite.android/x",
            "ftp://server.silentsuite.io/",
            "javascript:alert(1)",
            "intent://x#Intent;end",
            "about:blank",
            "not a url",
            "",
        )) {
            assertEquals(url, Request.Blocked, get(url))
            assertEquals(url, Request.Blocked, get(url, mainFrame = true))
        }
    }

    @Test
    fun dataUrlsLoadOnlyInsideAPage() {
        assertEquals(Request.Network, get("data:application/wasm;base64,AGFzbQ=="))
        assertEquals(Request.Blocked, get("data:text/html,<script>1</script>", mainFrame = true))
    }

    @Test
    fun navigationStaysInTheBundleAndTappedLinksOpenInTheBrowser() {
        assertEquals(Navigation.IN_APP, policy.navigation("https://app.silentsuite.io/calendar/", hasGesture = false, isRedirect = false))
        assertEquals(Navigation.IN_APP, policy.navigation("https://app.silentsuite.io/settings/", hasGesture = true, isRedirect = true))
        assertEquals(Navigation.EXTERNAL_BROWSER, policy.navigation("https://example.org/meeting", hasGesture = true, isRedirect = false))
        // Without a tap, after a redirect, or for anything but https, nothing opens.
        assertEquals(Navigation.BLOCKED, policy.navigation("https://example.org/meeting", hasGesture = false, isRedirect = false))
        assertEquals(Navigation.BLOCKED, policy.navigation("https://example.org/meeting", hasGesture = true, isRedirect = true))
        assertEquals(Navigation.BLOCKED, policy.navigation("http://example.org/", hasGesture = true, isRedirect = false))
        assertEquals(Navigation.BLOCKED, policy.navigation("intent://x#Intent;end", hasGesture = true, isRedirect = false))
        assertEquals(Navigation.BLOCKED, policy.navigation("file:///sdcard/x.html", hasGesture = true, isRedirect = false))
        assertEquals(Navigation.BLOCKED, policy.navigation("https://server.silentsuite.io/", hasGesture = false, isRedirect = true))
    }

    @Test
    fun originsAreExact() {
        assertEquals(Origin("https", "app.silentsuite.io", 443), Origin.of("https://app.silentsuite.io"))
        assertEquals(Origin("https", "app.silentsuite.io", 443), Origin.of("https://App.SilentSuite.io:443/x?y#z"))
        assertEquals(Origin("http", "localhost", 8080), Origin.of("http://localhost:8080/"))
        assertNull(Origin.of("https:///x"))
        assertNull(Origin.of("wss://server.silentsuite.io/"))
        assertNull(Origin.of("//app.silentsuite.io/login/"))
        assertNull(Origin.of("/login/"))
    }
}
