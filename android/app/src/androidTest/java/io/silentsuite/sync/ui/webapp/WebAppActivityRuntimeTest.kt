/*
 * Copyright © SilentSuite contributors.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.webapp

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.utils.AndroidCompat
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The debug web screen on the device's real WebView, showing a small fixture
 * bundle from this test APK (`src/androidTest/assets/webapp`, written by
 * `src/androidTest/webapp-fixture/generate.mjs`) instead of the web app. No
 * test needs the network: every page and script is answered from the fixture.
 *
 * A WebView without storage profiles (the API 29 emulator image) refuses the
 * screen; there each test checks that refusal instead of being skipped.
 */
@RunWith(AndroidJUnit4::class)
class WebAppActivityRuntimeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val manager: AccountManager get() = AccountManager.get(context)
    private val profiles = LinkedHashSet<String>()

    @Before
    fun setUp() {
        // The screen picks "the only account"; rows another test left behind would change that.
        for (account in manager.getAccountsByType(App.accountType)) removeAccountAndWait(account)
        WebAppActivity.assetsOverride = instrumentation.context.assets
    }

    @After
    fun tearDown() {
        WebAppActivity.assetsOverride = null
        var failure: Throwable? = null
        for (account in manager.getAccountsByType(App.accountType)) {
            try { removeAccountAndWait(account) } catch (t: Throwable) { if (failure == null) failure = t }
        }
        try { deleteProfiles() } catch (t: Throwable) { if (failure == null) failure = t }
        failure?.let { throw it }
    }

    @Test
    fun theStartPageLoadsFromTheBundleForTheOnlyHostedAccountAndNamesIt() {
        if (refusedByAWebViewWithoutProfiles()) return
        val account = addHostedAccount("start")
        launch(null).use { scenario ->
            awaitPage(scenario, START_TITLE)
            val expected = "$ORIGIN/login/#android-account=" + Uri.encode(account.name)
            assertEquals(expected, url(scenario))
            assertEquals(expected, evaluate(scenario, "location.href"))
            assertEquals(account.name, evaluate(scenario, "decodeURIComponent(location.hash.slice('#android-account='.length))"))
            assertEquals("The page's own script file comes from the fixture bundle", "object", evaluate(scenario, "typeof window.fixture"))
        }
    }

    @Test
    fun thePagePolicyRunsOnlyListedInlineScriptsRefusesEvalAndKeepsWebCryptoAndIndexedDb() {
        if (refusedByAWebViewWithoutProfiles()) return
        val account = addHostedAccount("policy")
        launch(account).use { scenario ->
            awaitPage(scenario, START_TITLE)
            val policy = probe(scenario, "policy")
            assertTrue("The inline script whose hash the policy lists must run: $policy", policy.optBoolean("hashedInline", false))
            assertFalse("An inline script the policy does not list must not run: $policy", policy.optBoolean("unhashedInline", true))
            assertEquals("eval must be refused: $policy", "EvalError", policy.optString("eval"))
            assertEquals("new Function must be refused: $policy", "EvalError", policy.optString("newFunction"))
            assertEquals("WebCrypto must work: $policy", SHA256_OF_ABC, policy.optString("digest"))
            assertEquals("IndexedDB must store and return a value: $policy", "stored", policy.optString("indexedDb"))
        }
    }

    @Test
    fun requestsOutsideTheBundleAreAnsweredLocallyOrRefused() {
        if (refusedByAWebViewWithoutProfiles()) return
        val account = addHostedAccount("boundary")
        launch(account).use { scenario ->
            awaitPage(scenario, START_TITLE)
            val boundary = probe(scenario, "boundary")

            val missing = boundary.getJSONObject("missing")
            assertEquals("A path the bundle lacks answers 404: $boundary", 404, missing.optInt("status", -1))
            assertTrue("A path the bundle lacks shows the bundled not-found page: $boundary",
                missing.optString("body").contains("<title>$NOT_FOUND_TITLE</title>"))

            val foreign = boundary.getJSONObject("foreign")
            assertFalse("A request to another host must get no answer: $boundary", foreign.has("status"))
            assertTrue("A request to another host must fail: $boundary", foreign.has("error"))

            assertEquals("A POST to the app's own address answers 405: $boundary",
                405, boundary.getJSONObject("post").optInt("status", -1))

            assertNotEquals("A frame must not load, not even a bundled page: $boundary",
                SECOND_TITLE, boundary.getJSONObject("frame").optString("title"))

            val worker = boundary.optString("serviceWorker")
            assertTrue("A service worker must not register: $boundary", worker == "unavailable" || worker.startsWith("rejected:"))

            assertEquals("The page is still the start page", START_TITLE, evaluate(scenario, "document.title"))
        }
    }

    @Test
    fun aScriptCannotNavigateToAnotherAddressButCanOpenABundledPage() {
        if (refusedByAWebViewWithoutProfiles()) return
        val account = addHostedAccount("navigation")
        launch(account).use { scenario ->
            awaitPage(scenario, START_TITLE)
            val start = url(scenario)
            evaluate(scenario, "window.fixtureMarker = 'kept'; location.href = 'https://foreign.invalid/away'; 'asked'")
            // One more request through the app gives the refused navigation time to be decided.
            assertEquals(200, probe(scenario, "ping").optInt("status", -1))
            assertEquals("The page that asked is still loaded", "kept", evaluate(scenario, "window.fixtureMarker"))
            assertEquals(START_TITLE, evaluate(scenario, "document.title"))
            assertEquals(start, url(scenario))

            evaluate(scenario, "location.href = '/calendar/'; 'asked'")
            awaitPage(scenario, SECOND_TITLE)
            assertEquals("$ORIGIN/calendar/", url(scenario))
        }
    }

    @Test
    fun eachAccountHasItsOwnStorageAndOpeningOneKeepsTheOthers() {
        if (refusedByAWebViewWithoutProfiles()) return
        val first = addHostedAccount("storage-first")
        val second = addHostedAccount("storage-second")
        launch(first).use { scenario ->
            awaitPage(scenario, START_TITLE)
            assertStored(scenario, null)
            store(scenario, "first")
        }
        launch(second).use { scenario ->
            awaitPage(scenario, START_TITLE)
            assertStored(scenario, null)
            store(scenario, "second")
        }
        // Each launch above ran the clean-up of unused profiles with the other account registered.
        launch(first).use { scenario ->
            awaitPage(scenario, START_TITLE)
            assertStored(scenario, "first")
        }
        launch(second).use { scenario ->
            awaitPage(scenario, START_TITLE)
            assertStored(scenario, "second")
        }
    }

    @Test
    fun removingTheAccountOfAnOpenScreenClosesIt() {
        if (refusedByAWebViewWithoutProfiles()) return
        val account = addHostedAccount("removed")
        launch(account).use { scenario ->
            awaitPage(scenario, START_TITLE)
            removeAccountAndWait(account)
            await("the screen to close after its account was removed") {
                if (scenario.state == Lifecycle.State.DESTROYED) true else null
            }
        }
    }

    @Test
    fun anAccountAddedAgainUnderItsOldNameStartsWithEmptyStorage() {
        if (refusedByAWebViewWithoutProfiles()) return
        val original = addHostedAccount("again", creationId = "first-row")
        launch(original).use { scenario ->
            awaitPage(scenario, START_TITLE)
            store(scenario, "original")
        }
        removeAccountAndWait(original)
        val replacement = addAccount(original.name, "second-row", HOSTED_SERVER)
        assertEquals(original, replacement)
        launch(replacement).use { scenario ->
            awaitPage(scenario, START_TITLE)
            assertStored(scenario, null)
        }
    }

    @Test
    fun launchesWithoutOneUsableHostedAccountShowTheMessageAndKeepRegisteredAccountsData() {
        if (refusedByAWebViewWithoutProfiles()) return
        launch(null).use { scenario -> assertShowsOnlyTheMessage(scenario, NEEDS_ACCOUNT) }

        val kept = addHostedAccount("kept")
        launch(kept).use { scenario ->
            awaitPage(scenario, START_TITLE)
            store(scenario, "kept")
        }

        // Two usable accounts and no name: the screen does not choose.
        addHostedAccount("second")
        launch(null).use { scenario -> assertShowsOnlyTheMessage(scenario, NEEDS_ACCOUNT) }

        val selfHosted = addAccount(uniqueName("self-hosted"), "self-hosted-row", "https://etebase.example.invalid/")
        launch(selfHosted).use { scenario -> assertShowsOnlyTheMessage(scenario, NEEDS_ACCOUNT) }

        val withoutCreationId = addAccount(uniqueName("no-creation-id"), null, HOSTED_SERVER)
        assertNull(manager.getUserData(withoutCreationId, AccountSettings.KEY_CREATION_ID))
        launch(withoutCreationId).use { scenario -> assertShowsOnlyTheMessage(scenario, NEEDS_ACCOUNT) }

        launch(Account(uniqueName("never-added"), App.accountType)).use { scenario ->
            assertShowsOnlyTheMessage(scenario, NEEDS_ACCOUNT)
        }

        // Every refused launch ran the clean-up of unused profiles; the registered account kept its data.
        launch(kept).use { scenario ->
            awaitPage(scenario, START_TITLE)
            assertStored(scenario, "kept")
        }
    }

    @Test
    fun recreationKeepsTheCurrentPageForTheSameAccount() {
        if (refusedByAWebViewWithoutProfiles()) return
        val account = addHostedAccount("recreation")
        launch(account).use { scenario ->
            awaitPage(scenario, START_TITLE)
            evaluate(scenario, "location.href = '/calendar/'; 'asked'")
            awaitPage(scenario, SECOND_TITLE)

            scenario.recreate()

            awaitPage(scenario, SECOND_TITLE)
            assertEquals("$ORIGIN/calendar/", url(scenario))
            var canGoBack = false
            scenario.onActivity { activity -> canGoBack = activity.webViewForTesting?.canGoBack() == true }
            assertTrue("The restored history still has the start page behind the current one", canGoBack)
        }
    }

    // --- WebViews without storage profiles ---

    /**
     * On a WebView without storage profiles, checks that the screen refuses a
     * usable account with its message and creates no web view, and returns true.
     */
    private fun refusedByAWebViewWithoutProfiles(): Boolean {
        if (onMain { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }) return false
        val account = addHostedAccount("old-webview")
        launch(account).use { scenario -> assertShowsOnlyTheMessage(scenario, NEEDS_NEWER_WEBVIEW) }
        return true
    }

    // --- accounts ---

    private fun uniqueName(prefix: String) = "webapp-$prefix-${System.nanoTime()}@example.invalid"

    private fun addHostedAccount(prefix: String, creationId: String = "$prefix-row"): Account =
        addAccount(uniqueName(prefix), creationId, HOSTED_SERVER)

    private fun addAccount(name: String, creationId: String?, server: String): Account {
        val account = Account(name, App.accountType)
        check(manager.addAccountExplicitly(account, null, null)) { "could not add $name" }
        // Fixture rows are not synced: no adapter may schedule work for them.
        ContentResolver.getSyncAdapterTypes()
            .filter { it.accountType == account.type }
            .forEach { adapter ->
                ContentResolver.setSyncAutomatically(account, adapter.authority, false)
                ContentResolver.setIsSyncable(account, adapter.authority, 0)
                ContentResolver.removePeriodicSync(account, adapter.authority, Bundle())
            }
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString()))
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_URI, server))
        if (creationId != null) check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, creationId))
        WebAppAccountBinding.profileName(account.type, account.name, creationId)?.let { profiles += it }
        return account
    }

    private fun removeAccountAndWait(account: Account) {
        if (account !in manager.getAccountsByType(account.type)) return
        val completed = CountDownLatch(1)
        AndroidCompat.removeAccount(manager, account) { completed.countDown() }
        assertTrue("Timed out removing ${account.name}", completed.await(10, TimeUnit.SECONDS))
        await("account ${account.name} to be gone", 5_000) {
            if (account !in manager.getAccountsByType(account.type)) true else null
        }
    }

    /** Best effort: a profile this process has loaded cannot be deleted until the app starts again. */
    private fun deleteProfiles() {
        if (profiles.isEmpty()) return
        onMain {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                val store = ProfileStore.getInstance()
                for (name in profiles) {
                    try { store.deleteProfile(name) } catch (_: IllegalStateException) { }
                }
            }
        }
    }

    // --- the screen ---

    private fun launch(account: Account?): ActivityScenario<WebAppActivity> {
        val intent = Intent(context, WebAppActivity::class.java)
        if (account != null) intent.putExtra(WebAppActivity.EXTRA_ACCOUNT, account.name)
        return ActivityScenario.launch<WebAppActivity>(intent)
    }

    private fun assertShowsOnlyTheMessage(scenario: ActivityScenario<WebAppActivity>, message: String) {
        val texts = ArrayList<String>()
        var webViews = 0
        var held: WebView? = null
        scenario.onActivity { activity ->
            held = activity.webViewForTesting
            walk(activity.window.decorView) { view ->
                if (view is TextView) texts += view.text.toString()
                if (view is WebView) webViews++
            }
        }
        assertTrue("Expected the message \"$message\" on screen, found $texts", message in texts)
        assertNull("The screen must hold no web view", held)
        assertEquals("The screen must show no web view", 0, webViews)
    }

    private fun walk(view: View, visit: (View) -> Unit) {
        visit(view)
        if (view is ViewGroup) for (index in 0 until view.childCount) walk(view.getChildAt(index), visit)
    }

    private fun url(scenario: ActivityScenario<WebAppActivity>): String? {
        var url: String? = null
        scenario.onActivity { activity -> url = activity.webViewForTesting?.url }
        return url
    }

    // --- the page ---

    /** Waits until the fixture page with this title has loaded and its script file has run. */
    private fun awaitPage(scenario: ActivityScenario<WebAppActivity>, title: String) {
        val script = "document.readyState === 'complete' && window.fixture ? document.title : null"
        var last: Any? = null
        try {
            await("the page titled \"$title\"") {
                last = evaluateOrNull(scenario, script)
                if (last == title) true else null
            }
        } catch (e: AssertionError) {
            throw AssertionError("${e.message}; last title: $last, address: ${url(scenario)}", e)
        }
    }

    /** Starts a probe of the fixture's script file and returns what it found. */
    private fun probe(scenario: ActivityScenario<WebAppActivity>, name: String): JSONObject {
        evaluate(scenario, "window.fixture.run('$name')")
        val result = JSONObject(await("the $name probe") { evaluateOrNull(scenario, "window.fixture.result('$name')") as? String })
        assertFalse("The $name probe failed: $result", result.has("error"))
        return result.getJSONObject("value")
    }

    private fun store(scenario: ActivityScenario<WebAppActivity>, value: String) {
        val stored = JSONObject(evaluate(scenario, "window.fixture.store('$value')") as String)
        assertEquals("localStorage keeps what was written: $stored", value, stored.optString("local"))
        assertEquals("The cookie that was set is readable: $stored", value, stored.optString("cookie"))
    }

    /** Asserts what localStorage and the cookie hold; null means neither holds anything. */
    private fun assertStored(scenario: ActivityScenario<WebAppActivity>, value: String?) {
        val stored = JSONObject(evaluate(scenario, "window.fixture.stored()") as String)
        val local = if (stored.isNull("local")) null else stored.getString("local")
        val cookie = if (stored.isNull("cookie")) null else stored.getString("cookie")
        assertEquals("localStorage: $stored", value, local)
        assertEquals("cookie: $stored", value, cookie)
    }

    /** Runs a script in the page and returns its decoded value; fails when the page does not answer. */
    private fun evaluate(scenario: ActivityScenario<WebAppActivity>, script: String): Any? {
        val answer = evaluateRaw(scenario, script, 15_000)
        assertTrue("The page did not answer: $script", answer != null)
        return decode(answer!!)
    }

    /** Like [evaluate], but null when the page does not answer, as can happen while a page is replaced. */
    private fun evaluateOrNull(scenario: ActivityScenario<WebAppActivity>, script: String): Any? =
        evaluateRaw(scenario, script, 5_000)?.let { decode(it) }

    private fun decode(json: String): Any? {
        val value = JSONTokener(json).nextValue()
        return if (value == JSONObject.NULL) null else value
    }

    private fun evaluateRaw(scenario: ActivityScenario<WebAppActivity>, script: String, timeoutMillis: Long): String? {
        val answered = CountDownLatch(1)
        val answer = AtomicReference<String?>()
        var present = false
        scenario.onActivity { activity ->
            val view = activity.webViewForTesting ?: return@onActivity
            present = true
            view.evaluateJavascript(script) { value ->
                answer.set(value ?: "null")
                answered.countDown()
            }
        }
        assertTrue("The screen shows no web view", present)
        return if (answered.await(timeoutMillis, TimeUnit.MILLISECONDS)) answer.get() else null
    }

    // --- waiting ---

    private fun <T : Any> await(description: String, timeoutMillis: Long = 30_000, attempt: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (true) {
            attempt()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) throw AssertionError("Timed out waiting for $description")
            SystemClock.sleep(50)
        }
    }

    private fun <T> onMain(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }

    private companion object {
        const val ORIGIN = "https://app.silentsuite.io"
        const val HOSTED_SERVER = "https://server.silentsuite.io/"
        const val START_TITLE = "fixture start"
        const val SECOND_TITLE = "fixture second"
        const val NOT_FOUND_TITLE = "fixture not found"
        const val NEEDS_ACCOUNT = "This screen needs one SilentSuite account on the hosted service."
        const val NEEDS_NEWER_WEBVIEW = "This screen needs a newer Android System WebView."
        const val SHA256_OF_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    }
}
