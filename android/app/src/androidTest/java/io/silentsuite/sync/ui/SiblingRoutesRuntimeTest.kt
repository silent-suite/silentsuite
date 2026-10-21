package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.view.menu.MenuBuilder
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.UiDevice
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.lifecycle.Lifecycle
import androidx.appcompat.app.AlertDialog
import com.google.android.material.tabs.TabLayout
import com.google.android.material.textfield.TextInputLayout
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.etebase.*
import io.silentsuite.sync.ui.importlocal.ImportActivity
import io.silentsuite.sync.ui.importlocal.ImportFragment
import io.silentsuite.sync.ui.importlocal.ResultFragment
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.utils.AndroidCompat
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.SyncResult
import android.provider.SyncStateContract
import android.provider.ContactsContract
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.notes.FakeEtebaseServer
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.syncadapter.ContactsSyncManager
import io.silentsuite.sync.syncadapter.SyncManager
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class SiblingRoutesRuntimeTest {
    @get:Rule
    val routePermissionRule: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CALENDAR,
        Manifest.permission.WRITE_CALENDAR,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.WRITE_CONTACTS,
    )

    private val localPageOneUrl = "https://silentsuite.invalid/runtime-page-one"
    private val localPageTwoUrl = "https://silentsuite.invalid/runtime-page-two"
    private val localPageOneHtml = "<html><head><title>runtime page one</title></head><body>one</body></html>"
    private val localPageTwoHtml = "<html><head><title>runtime page two</title></head><body>two</body></html>"

    /** Creates a fully-owned fixture row in one AccountManager transaction. */
    private fun addAccount(manager: AccountManager, namePrefix: String, creationId: String, setupComplete: Boolean = false): Account {
        val account = Account("$namePrefix-${System.nanoTime()}@example.invalid", App.accountType)
        val userdata = Bundle().apply {
            putString(AccountSettings.KEY_CREATION_ID, creationId)
            putString(AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString())
            if (setupComplete) putString(AccountSettings.KEY_POST_LOGIN_SETUP_STATE,
                io.silentsuite.sync.ui.setup.PostLoginSetupState.COMPLETE.name)
        }
        check(manager.addAccountExplicitly(account, null, userdata))
        assertEquals(creationId, manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
        return account
    }

    /** API-21-safe teardown: wait for the callback, then verify the row is absent. */
    private fun removeAccountAndWait(manager: AccountManager, account: Account, timeoutSeconds: Long = 10) {
        if (manager.getAccountsByType(account.type).none { it == account }) return
        val completed = CountDownLatch(1)
        var removed = false
        AndroidCompat.removeAccount(manager, account) { success -> removed = success; completed.countDown() }
        assertTrue("Timed out removing ${account.name}", completed.await(timeoutSeconds, TimeUnit.SECONDS))
        assertTrue("Account removal callback failed", removed)
        waitUntil("account ${account.name} to be absent", 5_000) {
            manager.getAccountsByType(account.type).none { it == account }
        }
    }

    private fun waitUntil(description: String, timeoutMillis: Long = 10_000, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (predicate()) return
            SystemClock.sleep(25)
        }
        assertTrue("Timed out waiting for $description", predicate())
    }


    private fun enterLocalCalendarPicker(scenario: ActivityScenario<ImportActivity>) {
        waitUntil("import chooser") {
            var ready = false
            scenario.onActivity { activity ->
                ready = activity.findViewById<View>(R.id.import_account)?.isShown == true
            }
            ready
        }
        scenario.onActivity { it.findViewById<View>(R.id.import_account).performClick() }
        waitUntil("local calendar picker") {
            var selected = false
            scenario.onActivity { activity ->
                selected = activity.supportFragmentManager.fragments.any {
                    it is io.silentsuite.sync.ui.importlocal.LocalCalendarImportFragment
                }
            }
            selected
        }
    }

    private fun assertImportChooser(scenario: ActivityScenario<ImportActivity>) {
        scenario.onActivity { activity ->
            assertEquals(activity.getString(R.string.import_dialog_title), activity.title)
            assertTrue(activity.supportFragmentManager.fragments.any { it is ImportActivity.SelectImportFragment })
        }
        assertEquals(Lifecycle.State.RESUMED, scenario.state)
    }

    private fun localWebViewIntent(context: Context) = android.content.Intent(context, WebViewActivity::class.java).apply {
        putExtra(WebViewActivity.EXTRA_URL, Constants.helpUri)
        putExtra(WebViewActivity.EXTRA_DEBUG_INITIAL_HTML, localPageOneHtml)
    }

    private fun installLocalWebViewClient(
        pageOneLoaded: CountDownLatch,
        pageTwoLoaded: CountDownLatch,
        pageOneRestored: CountDownLatch,
    ) {
        val pageOneDeliveries = AtomicInteger()
        WebViewActivity.debugWebViewClientOverride = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                when (url) {
                    localPageOneUrl -> if (pageOneDeliveries.incrementAndGet() == 1) {
                        pageOneLoaded.countDown()
                    } else {
                        pageOneRestored.countDown()
                    }
                    localPageTwoUrl -> pageTwoLoaded.countDown()
                }
            }
        }
    }

    private fun loadLocalPageTwo(scenario: ActivityScenario<WebViewActivity>, pageTwoLoaded: CountDownLatch) {
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.webView).loadDataWithBaseURL(
                localPageTwoUrl, localPageTwoHtml, "text/html", "UTF-8", null
            )
        }
        assertTrue("Timed out loading deterministic page two", pageTwoLoaded.await(10, TimeUnit.SECONDS))
        scenario.onActivity { activity -> assertTrue(activity.findViewById<WebView>(R.id.webView).canGoBack()) }
    }
    @Test
    fun encryptionPasswordCompletionRecreatesAndReturnsToCallerForExactGeneration() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "password", "password-generation")

        val passwordCalls = AtomicInteger()
        val syncCalls = AtomicInteger()
        val successDialogShown = CountDownLatch(1)
        ChangeEncryptionPasswordActivity.passwordChangeOverride = { activity, _, _ ->
            assertEquals(account, activity.intent.getParcelableExtra(ChangeEncryptionPasswordActivity.EXTRA_ACCOUNT))
            passwordCalls.incrementAndGet()
            true
        }
        ChangeEncryptionPasswordActivity.syncRequestOverride = { _, syncedAccount ->
            assertEquals(account, syncedAccount)
            syncCalls.incrementAndGet()
            // Production invokes this only after showing the success dialog.
            successDialogShown.countDown()
        }
        try {
            ActivityScenario.launchActivityForResult<ChangeEncryptionPasswordActivity>(
                ChangeEncryptionPasswordActivity.newIntent(context, account, "password-generation")
            ).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals(account.name, activity.findViewById<TextView>(R.id.account_name).text.toString())
                    val oldPassword = activity.findViewById<TextInputLayout>(R.id.encryption_password).editText!!
                    val newPassword = activity.findViewById<TextInputLayout>(R.id.new_encryption_password).editText!!
                    assertFalse(oldPassword.isSaveEnabled)
                    assertFalse(newPassword.isSaveEnabled)
                    assertTrue(activity.findViewById<View>(R.id.set_password).minimumHeight >=
                        activity.resources.getDimensionPixelSize(R.dimen.touch_target_min))
                    oldPassword.setText("old")
                    newPassword.setText("new")
                    activity.changePasswordClicked(activity.findViewById(R.id.set_password))
                }
                waitUntil("password confirmation dialog") {
                    try {
                        onView(withText(context.getString(R.string.change_encryption_password_are_you_sure)))
                            .check(matches(isDisplayed()))
                        true
                    } catch (_: Throwable) {
                        false
                    }
                }
                onView(withText(context.getString(R.string.change_encryption_password_are_you_sure)))
                    .check(matches(isDisplayed()))
                onView(withText(android.R.string.yes)).perform(click())
                assertTrue("Timed out waiting for password success dialog",
                    successDialogShown.await(10, TimeUnit.SECONDS))
                // The password work uses Dispatchers.IO, which Espresso does not own.  Wait for
                // the rendered dialog rather than assuming the sync callback has reached a frame.
                waitUntil("rendered password success dialog") {
                    try {
                        onView(withText(context.getString(R.string.change_encryption_password_success_title)))
                            .check(matches(isDisplayed()))
                        true
                    } catch (_: Throwable) {
                        false
                    }
                }
                onView(withText(context.getString(R.string.change_encryption_password_success_title))).check(matches(isDisplayed()))
                onView(withText(context.getString(R.string.change_encryption_password_success_body))).check(matches(isDisplayed()))
                onView(withText(android.R.string.ok)).perform(click())
                waitUntil("password caller return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
            assertEquals(1, passwordCalls.get())
            assertEquals(1, syncCalls.get())
        } finally {
            ChangeEncryptionPasswordActivity.passwordChangeOverride = null
            ChangeEncryptionPasswordActivity.syncRequestOverride = null
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun encryptionPasswordCancelReturnsToCallerAfterRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "password-cancel", "password-cancel-generation")

        try {
            ActivityScenario.launch<ChangeEncryptionPasswordActivity>(
                ChangeEncryptionPasswordActivity.newIntent(context, account, "password-cancel-generation")
            ).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity -> activity.onCancelClicked(View(activity)) }
                waitUntil("password cancel return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(Lifecycle.State.DESTROYED, scenario.state)
            }
        } finally {
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun importDispatcherBackPopsNestedStackThenFinishesWithCanceledResult() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "import-cancel", "import-cancel-generation")
        val info = CollectionInfo().apply {
            uid = "collection-uid"
            enumType = CollectionInfo.Type.CALENDAR
        }

        try {
            ActivityScenario.launchActivityForResult<ImportActivity>(
                ImportActivity.newIntent(context, account, "import-cancel-generation", info)
            ).use { scenario ->
                scenario.recreate()
                enterLocalCalendarPicker(scenario)
                scenario.onActivity { activity ->
                    activity.onBackPressedDispatcher.onBackPressed()
                }
                assertImportChooser(scenario)
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                waitUntil("import cancel return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(Lifecycle.State.DESTROYED, scenario.state)
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
        } finally {
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun importToolbarUpPopsNestedStackThenFinishesWithCanceledResult() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "import-toolbar", "import-toolbar-generation")
        val info = CollectionInfo().apply { uid = "toolbar-collection-uid"; enumType = CollectionInfo.Type.CALENDAR }

        try {
            ActivityScenario.launchActivityForResult<ImportActivity>(
                ImportActivity.newIntent(context, account, "import-toolbar-generation", info)
            ).use { scenario ->
                enterLocalCalendarPicker(scenario)
                scenario.onActivity { activity ->
                    assertTrue(activity.onOptionsItemSelected(MenuBuilder(activity).add(0, android.R.id.home, 0, "Up")))
                }
                assertImportChooser(scenario)
                scenario.onActivity { activity ->
                    assertTrue(activity.onOptionsItemSelected(MenuBuilder(activity).add(0, android.R.id.home, 0, "Up")))
                }
                waitUntil("import toolbar root return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
        } finally {
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun importSystemBackPopsNestedStackThenFinishesWithCanceledResult() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "import-system-back", "import-system-back-generation")
        val info = CollectionInfo().apply { uid = "system-back-collection-uid"; enumType = CollectionInfo.Type.CALENDAR }

        try {
            ActivityScenario.launchActivityForResult<ImportActivity>(
                ImportActivity.newIntent(context, account, "import-system-back-generation", info)
            ).use { scenario ->
                enterLocalCalendarPicker(scenario)
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
                assertImportChooser(scenario)
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
                waitUntil("import system Back root return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
        } finally {
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun webViewDispatcherBackConsumesLocalHistoryThenFinishes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val pageOneLoaded = CountDownLatch(1)
        val pageTwoLoaded = CountDownLatch(1)
        val pageOneRestored = CountDownLatch(1)
        installLocalWebViewClient(pageOneLoaded, pageTwoLoaded, pageOneRestored)

        try {
            ActivityScenario.launchActivityForResult<WebViewActivity>(localWebViewIntent(context)).use { scenario ->
                assertTrue("Timed out loading deterministic page one", pageOneLoaded.await(10, TimeUnit.SECONDS))
                loadLocalPageTwo(scenario, pageTwoLoaded)
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                assertTrue("Timed out restoring deterministic page one", pageOneRestored.await(10, TimeUnit.SECONDS))
                assertEquals(Lifecycle.State.RESUMED, scenario.state)
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                waitUntil("WebView dispatcher root Back return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
        } finally {
            WebViewActivity.debugWebViewClientOverride = null
        }
    }

    @Test
    fun webViewToolbarUpFinishesInsteadOfTraversingLocalHistory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val pageOneLoaded = CountDownLatch(1)
        val pageTwoLoaded = CountDownLatch(1)
        installLocalWebViewClient(pageOneLoaded, pageTwoLoaded, CountDownLatch(1))

        try {
            ActivityScenario.launchActivityForResult<WebViewActivity>(localWebViewIntent(context)).use { scenario ->
                assertTrue("Timed out loading deterministic page one", pageOneLoaded.await(10, TimeUnit.SECONDS))
                loadLocalPageTwo(scenario, pageTwoLoaded)
                scenario.onActivity { activity ->
                    assertTrue(activity.onOptionsItemSelected(MenuBuilder(activity).add(0, android.R.id.home, 0, "Up")))
                }
                waitUntil("WebView toolbar Up return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
        } finally {
            WebViewActivity.debugWebViewClientOverride = null
        }
    }

    @Test
    fun webViewSystemBackConsumesLocalHistoryThenFinishes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val pageOneLoaded = CountDownLatch(1)
        val pageTwoLoaded = CountDownLatch(1)
        val pageOneRestored = CountDownLatch(1)
        installLocalWebViewClient(pageOneLoaded, pageTwoLoaded, pageOneRestored)

        try {
            ActivityScenario.launchActivityForResult<WebViewActivity>(localWebViewIntent(context)).use { scenario ->
                assertTrue("Timed out loading deterministic page one", pageOneLoaded.await(10, TimeUnit.SECONDS))
                loadLocalPageTwo(scenario, pageTwoLoaded)
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
                assertTrue("Timed out restoring deterministic page one", pageOneRestored.await(10, TimeUnit.SECONDS))
                assertEquals(Lifecycle.State.RESUMED, scenario.state)
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
                waitUntil("WebView system Back root return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
        } finally {
            WebViewActivity.debugWebViewClientOverride = null
        }
    }

    @Test
    fun importCompletionShowsResultAndReturnsToCallerForExactCollection() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "import-complete", "import-complete-generation")
        val info = CollectionInfo().apply { uid = "import-uid"; enumType = CollectionInfo.Type.CALENDAR }
        var completions = 0
        ImportFragment.importCompletionOverride = { identity ->
            assertEquals(account, identity.account)
            assertEquals("import-complete-generation", identity.creationId)
            assertEquals("import-uid", identity.collectionUid)
            assertEquals(Constants.ETEBASE_TYPE_CALENDAR, identity.collectionType)
            completions++
            ResultFragment.ImportResult().apply { total = 3; added = 2; updated = 1 }
        }
        try {
            ActivityScenario.launchActivityForResult<ImportActivity>(
                ImportActivity.newIntent(context, account, "import-complete-generation", info)
            ).use { scenario ->
                scenario.recreate()
                scenario.onActivity { it.findViewById<View>(R.id.import_file).performClick() }
                val expectedMessage = context.getString(R.string.import_dialog_success, 3L, 2L, 1L, 0L)
                waitUntil("import result dialog") {
                    var shown = false
                    scenario.onActivity { activity ->
                        val dialog = (activity.supportFragmentManager.findFragmentByTag("importResult")
                            as? androidx.fragment.app.DialogFragment)?.dialog as? AlertDialog
                        shown = dialog?.isShowing == true &&
                            dialog.findViewById<TextView>(android.R.id.message)?.text?.toString() == expectedMessage
                    }
                    shown
                }
                scenario.onActivity { activity ->
                    val dialog = (activity.supportFragmentManager.findFragmentByTag("importResult")
                        as androidx.fragment.app.DialogFragment).dialog as AlertDialog
                    assertEquals(expectedMessage,
                        dialog.findViewById<TextView>(android.R.id.message)?.text?.toString())
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
                }
                waitUntil("import caller return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
            }
            assertEquals(1, completions)
        } finally {
            ImportFragment.importCompletionOverride = null
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun fingerprintCopyRevalidatesGenerationBeforeWritingClipboard() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "fingerprint", "fingerprint-generation")
        lateinit var clipboard: ClipboardManager
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("sentinel", "sentinel"))
        }
        FingerprintDialogFragment.fingerprintProviderOverride = { _, _ -> "test fingerprint" }

        try {
            ActivityScenario.launch<AboutActivity>(android.content.Intent(context, AboutActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    FingerprintDialogFragment.newInstance(account, "fingerprint-generation")
                        .show(activity.supportFragmentManager, FingerprintDialogFragment.TAG)
                    activity.supportFragmentManager.executePendingTransactions()
                }
                check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "replacement-generation"))
                scenario.onActivity { activity ->
                    val fragment = activity.supportFragmentManager
                        .findFragmentByTag(FingerprintDialogFragment.TAG) as FingerprintDialogFragment
                    (fragment.dialog as AlertDialog).getButton(AlertDialog.BUTTON_NEUTRAL).performClick()
                }
                scenario.onActivity {
                    assertEquals("sentinel", clipboard.primaryClip!!.getItemAt(0).text)
                }
            }
        } finally {
            FingerprintDialogFragment.fingerprintProviderOverride = null
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun fingerprintCopyCompletesAfterRecreationForItsExactGeneration() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "fingerprint-complete", "fingerprint-complete-generation")
        lateinit var clipboard: ClipboardManager
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        }
        FingerprintDialogFragment.fingerprintProviderOverride = { _, _ -> "completed fingerprint" }

        try {
            ActivityScenario.launch<AboutActivity>(android.content.Intent(context, AboutActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    FingerprintDialogFragment.newInstance(account, "fingerprint-complete-generation")
                        .show(activity.supportFragmentManager, FingerprintDialogFragment.TAG)
                }
                scenario.recreate()
                scenario.onActivity { activity ->
                    val fragment = activity.supportFragmentManager
                        .findFragmentByTag(FingerprintDialogFragment.TAG) as FingerprintDialogFragment
                    (fragment.dialog as AlertDialog).getButton(AlertDialog.BUTTON_NEUTRAL).performClick()
                }
                scenario.onActivity {
                    assertEquals("completed fingerprint", clipboard.primaryClip!!.getItemAt(0).text)
                }
            }
        } finally {
            FingerprintDialogFragment.fingerprintProviderOverride = null
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun fingerprintCancelAfterRecreationReturnsToExactDashboard() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "fingerprint-dashboard", "fingerprint-dashboard-generation", setupComplete = true)
        val reads = mutableListOf<Pair<Account, String>>()
        val previousBootstrap = App.postLoginBootstrapSucceeded
        App.postLoginBootstrapSucceeded = true
        AccountActivity.AccountInfoViewModel.accountLoaderOverride = { _, exact, creationId ->
            AccountActivity.AccountInfo().also { check(exact == account); check(creationId == "fingerprint-dashboard-generation") }
        }
        FingerprintDialogFragment.fingerprintProviderOverride = { _, exact ->
            reads += exact to requireNotNull(manager.getUserData(exact, AccountSettings.KEY_CREATION_ID))
            "dashboard fingerprint"
        }
        try {
            ActivityScenario.launch<AccountActivity>(
                AccountActivity.newIntent(context, account, "fingerprint-dashboard-generation")
            ).use { scenario ->
                val originalActivity = AtomicReference<AccountActivity>()
                waitUntil("rendered dashboard") {
                    var rendered = false
                    scenario.onActivity {
                        originalActivity.set(it)
                        rendered = it.findViewById<TextView>(R.id.dashboard_account_identity).text.toString() == account.name
                    }
                    rendered
                }
                scenario.onActivity { activity ->
                    val fingerprint = activity.findViewById<androidx.appcompat.widget.Toolbar>(R.id.toolbar)
                        .menu.findItem(R.id.account_show_fingerprint)
                    assertTrue(activity.onOptionsItemSelected(requireNotNull(fingerprint)))
                }
                waitUntil("fingerprint dialog") {
                    var shown = false
                    scenario.onActivity { activity ->
                        shown = (activity.supportFragmentManager.findFragmentByTag(FingerprintDialogFragment.TAG)
                            as? FingerprintDialogFragment)?.dialog?.isShowing == true
                    }
                    shown
                }
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    originalActivity.get().recreate()
                }
                val recreatedActivity = AtomicReference<AccountActivity>()
                waitUntil("retained fingerprint dialog") {
                    var retained = false
                    InstrumentationRegistry.getInstrumentation().runOnMainSync {
                        val activity = (ActivityLifecycleMonitorRegistry.getInstance()
                            .getActivitiesInStage(Stage.PAUSED) +
                            ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED))
                            .filterIsInstance<AccountActivity>()
                            .firstOrNull { it !== originalActivity.get() }
                        if (activity != null) {
                            retained = (activity.supportFragmentManager
                                .findFragmentByTag(FingerprintDialogFragment.TAG)
                                as? FingerprintDialogFragment)?.dialog?.isShowing == true
                            if (retained) recreatedActivity.set(activity)
                        }
                    }
                    retained
                }
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    val activity = recreatedActivity.get()
                    val fragment = activity.supportFragmentManager
                        .findFragmentByTag(FingerprintDialogFragment.TAG) as FingerprintDialogFragment
                    fragment.dialog!!.cancel()
                    assertFalse(activity.isFinishing)
                    assertEquals(account.name, activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
                }
                assertEquals(listOf(account to "fingerprint-dashboard-generation"), reads)
            }
        } finally {
            FingerprintDialogFragment.fingerprintProviderOverride = null
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = null
            App.postLoginBootstrapSucceeded = previousBootstrap
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun collectionCreateLaunchRecreateAndBackPreserveExactRoute() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "collection-create", "collection-create-generation")
        val state = fixture()
        runtimeFixtureOverride = exactFixture(account, "collection-create-generation", null,
            Constants.ETEBASE_TYPE_CALENDAR) { state }
        try {
            ActivityScenario.launch<CollectionActivity>(
                CollectionActivity.newCreateCollectionIntent(context, account, "collection-create-generation", Constants.ETEBASE_TYPE_CALENDAR)
            ).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity ->
                    val fragment = activity.supportFragmentManager.findFragmentById(R.id.fragment_container)!!
                    assertEquals("collection-create-generation", fragment.arguments!!.getString("collection.identity.creationId"))
                    activity.onBackPressedDispatcher.onBackPressed()
                }
                waitUntil("collection create cancel return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(Lifecycle.State.DESTROYED, scenario.state)
            }
        } finally {
            runtimeFixtureOverride = null
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun invitationsLaunchRecreateAndBackKeepsExactGenerationRoute() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "invitations", "invitations-generation")
        invitationsOverride = { emptyList() }
        try {
            ActivityScenario.launch<InvitationsActivity>(
                InvitationsActivity.newIntent(context, account, "invitations-generation")
            ).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals("invitations-generation", activity.intent.getStringExtra("creationId"))
                    activity.onBackPressedDispatcher.onBackPressed()
                }
                waitUntil("invitations cancel return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(Lifecycle.State.DESTROYED, scenario.state)
            }
        } finally {
            invitationsOverride = null
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun exactGenerationRoutesLaunchRealActivitiesAndRejectReplacement() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "routes", "route-generation")

        try {
            val info = CollectionInfo().apply {
                uid = "collection-uid"
                enumType = CollectionInfo.Type.CALENDAR
            }
            fun launchAndFinish(route: android.content.Intent) {
                ActivityScenario.launch<android.app.Activity>(route).use { scenario ->
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                    scenario.onActivity { it.finish() }
                    waitUntil("exact route finish") { scenario.state == Lifecycle.State.DESTROYED }
                    assertEquals(Lifecycle.State.DESTROYED, scenario.state)
                }
            }
            listOf(
                ChangeEncryptionPasswordActivity.newIntent(context, account, "route-generation"),
                ImportActivity.newIntent(context, account, "route-generation", info)
            ).forEach(::launchAndFinish)
        } finally {
            removeAccountAndWait(manager, account)
        }
    }

    @Test
    fun aboutHelpRemainsReadableAndSelectedAcrossRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<AboutActivity>(android.content.Intent(context, AboutActivity::class.java)).use { scenario ->
            scenario.onActivity { activity -> activity.findViewById<androidx.viewpager.widget.ViewPager>(R.id.viewpager).currentItem = 1 }
            scenario.recreate()
            scenario.onActivity { activity ->
                assertEquals(1, activity.findViewById<androidx.viewpager.widget.ViewPager>(R.id.viewpager).currentItem)
                val tabs = activity.findViewById<TabLayout>(R.id.tabs)
                assertTrue(tabs.tabCount > 1)
                assertEquals(1, tabs.selectedTabPosition)
            }
        }
    }

    @Test
    fun staleSameNameGenerationRoutesFailClosedBeforeRendering() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "stale-routes", "old-generation")
        val info = CollectionInfo().apply {
            uid = "collection-uid"
            enumType = CollectionInfo.Type.CALENDAR
        }
        val staleRoutes = listOf(
            ChangeEncryptionPasswordActivity.newIntent(context, account, "old-generation"),
            InvitationsActivity.newIntent(context, account, "old-generation"),
            CollectionActivity.newIntent(context, account, "old-generation", "collection-uid"),
            ImportActivity.newIntent(context, account, "old-generation", info)
        )
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "replacement-generation"))

        try {
            staleRoutes.forEach { intent ->
                ActivityScenario.launch<android.app.Activity>(intent).use { scenario ->
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                    waitUntil("stale route rejected") { scenario.state == Lifecycle.State.DESTROYED }
                    assertEquals(Lifecycle.State.DESTROYED, scenario.state)
                }
            }
        } finally {
            removeAccountAndWait(manager, account)
        }
    }

    private fun fixture(uid: String = "ac41-uid", name: String = "AC41 calendar", members: List<RuntimeMember> = emptyList()) =
        RuntimeCollectionFixture(uid, Constants.ETEBASE_TYPE_CALENDAR, name, "AC41 description", 0xff336699.toInt(),
            com.etebase.client.CollectionAccessLevel.Admin, listOf("one", "two"), members)

    private fun exactFixture(
        account: Account,
        creationId: String,
        routeUid: String?,
        routeType: String?,
        fixture: () -> RuntimeCollectionFixture,
    ): (Context, Account, String, String?, String?) -> RuntimeCollectionFixture? =
        { _, actualAccount, actualCreationId, actualUid, actualType ->
            val current = fixture()
            assertEquals(account, actualAccount)
            assertEquals(creationId, actualCreationId)
            assertTrue("Unexpected collection UID $actualUid", actualUid == routeUid ||
                (routeUid == null && actualUid == current.uid))
            assertTrue("Unexpected collection type $actualType", actualType == routeType ||
                (routeType == null && actualType == current.type))
            current
        }

    private fun memberListView(activity: CollectionActivity): android.widget.ListView? =
        (activity.supportFragmentManager.findFragmentById(R.id.fragment_container)
            as? CollectionMembersFragment)
            ?.view
            ?.findViewById(android.R.id.list)

    @Test
    fun collectionExportCompletionReturnsToExactRenderedCollection() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext; val manager = AccountManager.get(context)
        val account = addAccount(manager, "ac41-export", "ac41-export-generation"); val state = fixture(); val exported = AtomicInteger(); val completion = AtomicInteger()
        runtimeFixtureOverride = exactFixture(account, "ac41-export-generation", state.uid, null) { state }
        ViewCollectionFragment.collectionExportDocumentLauncherOverride = { _, intent, code -> assertEquals(6385, code); assertEquals(android.content.Intent.ACTION_CREATE_DOCUMENT, intent.action); assertTrue(intent.hasCategory(android.content.Intent.CATEGORY_OPENABLE)); assertEquals("text/calendar", intent.type); assertTrue(requireNotNull(intent.getStringExtra(android.content.Intent.EXTRA_TITLE)).matches(Regex("AC41-calendar-\\d{8}\\.ics"))) }
        ViewCollectionFragment.collectionExportOverride = { _, id, type, contents, uri -> assertEquals(account, id.account); assertEquals("ac41-export-generation", id.creationId); assertEquals(state.uid, id.collectionUid); assertEquals(state.type, id.collectionType); assertEquals(state.type, type); assertEquals(listOf("one", "two"), contents); assertEquals("content://ac41/collection", uri.toString()); exported.incrementAndGet(); true }
        ViewCollectionFragment.collectionExportCompletionOverride = { id -> assertEquals(account, id.account); assertEquals("ac41-export-generation", id.creationId); assertEquals(state.uid, id.collectionUid); completion.incrementAndGet() }
        try { ActivityScenario.launchActivityForResult<CollectionActivity>(CollectionActivity.newIntent(context, account, "ac41-export-generation", state.uid)).use { scenario ->
            waitUntil("fixture view") { var yes=false; scenario.onActivity { yes=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is ViewCollectionFragment }; yes }
            scenario.onActivity { a -> val f=a.supportFragmentManager.findFragmentById(R.id.fragment_container) as ViewCollectionFragment; f.onOptionsItemSelected(MenuBuilder(a).add(0, R.id.on_export, 0, "Export")); a.recreate() }
            scenario.onActivity { a -> (a.supportFragmentManager.findFragmentById(R.id.fragment_container) as ViewCollectionFragment).onActivityResult(6385, android.app.Activity.RESULT_OK, android.content.Intent().setData(android.net.Uri.parse("content://ac41/collection"))) }
            waitUntil("export") { exported.get() == 1 && completion.get() == 1 }; scenario.onActivity { assertEquals(Lifecycle.State.RESUMED, it.lifecycle.currentState); assertEquals(state.name, it.findViewById<TextView>(R.id.display_name).text.toString()); it.onBackPressedDispatcher.onBackPressed() }; waitUntil("collection export return") { scenario.state == Lifecycle.State.DESTROYED }; assertEquals(Lifecycle.State.DESTROYED, scenario.state); assertEquals(android.app.Activity.RESULT_CANCELED, scenario.result.resultCode)
        }} finally { ViewCollectionFragment.collectionExportCompletionOverride=null; ViewCollectionFragment.collectionExportOverride=null; ViewCollectionFragment.collectionExportDocumentLauncherOverride=null; runtimeFixtureOverride=null; removeAccountAndWait(manager, account) }
    }

    @Test
    fun collectionViewRendersRecreatesAndReturnsForExactCollection() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context); val account=addAccount(manager,"ac41-view","ac41-view-generation"); val state=fixture()
        runtimeFixtureOverride=exactFixture(account,"ac41-view-generation",state.uid,null) { state }
        try { ActivityScenario.launchActivityForResult<CollectionActivity>(CollectionActivity.newIntent(context,account,"ac41-view-generation",state.uid)).use { s -> waitUntil("view") { var ok=false;s.onActivity { ok=it.findViewById<TextView>(R.id.display_name).text.toString()==state.name && it.findViewById<TextView>(R.id.owner).visibility==View.GONE && it.findViewById<TextView>(R.id.stats).text.toString()==it.resources.getQuantityString(R.plurals.collection_recent_activity_items,2,2) };ok };s.recreate();s.onActivity { val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as ViewCollectionFragment;assertEquals(account,f.arguments!!.getParcelable("collection.identity.account"));assertEquals("ac41-view-generation",f.arguments!!.getString("collection.identity.creationId"));assertEquals(state.uid,f.arguments!!.getString("collection.identity.uid"));assertEquals(state.type,f.arguments!!.getString("collection.identity.type"));assertEquals(state.description,it.findViewById<TextView>(R.id.description).text.toString());it.onBackPressedDispatcher.onBackPressed() };waitUntil("collection view return") { s.state == Lifecycle.State.DESTROYED };assertEquals(Lifecycle.State.DESTROYED,s.state);assertEquals(android.app.Activity.RESULT_CANCELED,s.result.resultCode) }} finally { runtimeFixtureOverride=null;removeAccountAndWait(manager,account) }
    }

    /**
     * Contacts recovery over real Etebase objects in the account's real cache (made against the
     * in-process stand-in server) and a real local address book in the contacts provider.
     */
    @Test
    fun contactsRecoveryListsOnlyDeletedConfirmsRestoreAndKeepsSiblingHistory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val generation = "contacts-recovery-generation"
        val fake = io.silentsuite.sync.notes.FakeEtebaseServer()
        val client = com.etebase.client.Client.create(okhttp3.OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
        val session = com.etebase.client.Account.signup(client,
            com.etebase.client.User("contacts-recovery-${System.nanoTime()}", "contacts-recovery@example.invalid"),
            "stand-in-server-only").save(null)
        val colMgr = com.etebase.client.Account.restore(client, session, null).collectionManager
        val account = addAccount(manager, "contacts-recovery", generation)
        val contacts = android.provider.ContactsContract.AUTHORITY
        val children = mutableListOf<Account>()
        try {
            listOf(App.addressBooksAuthority, android.provider.CalendarContract.AUTHORITY).forEach {
                android.content.ContentResolver.setIsSyncable(account, it, 0)
            }
            AccountSettings.setUserData(manager, account, java.net.URI(fake.baseUrl), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
            AccountSettings(context, account).etebaseSession = session
            val cache = io.silentsuite.sync.EtebaseLocalCache.getInstance(context, account.name)
            fun vcard(uid: String, name: String) = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:$uid\r\nFN:$name\r\nEND:VCARD\r\n"
            /** One live and one deleted entry, uploaded, then cached the way a sync caches them. */
            fun collection(type: String, name: String, live: String, deleted: String, readOnly: Boolean = false): String {
                val created = colMgr.create(type, com.etebase.client.ItemMetadata().apply { this.name = name }, "")
                colMgr.upload(created)
                val itemMgr = colMgr.getItemManager(created)
                val kept = itemMgr.create(com.etebase.client.ItemMetadata().apply { this.name = "kept"; mtime = 2_000L }, live)
                val gone = itemMgr.create(com.etebase.client.ItemMetadata().apply { this.name = "gone"; mtime = 1_000L }, deleted)
                itemMgr.batch(arrayOf(kept, gone))
                gone.delete()
                itemMgr.batch(arrayOf(gone))
                if (readOnly) fake.setAccessLevel(created.uid, 0L)
                val current = colMgr.fetch(created.uid)
                synchronized(cache) {
                    cache.collectionSet(colMgr, current)
                    listOf(kept, gone).forEach { cache.itemSet(colMgr.getItemManager(current), current.uid, it) }
                }
                return current.uid
            }
            val book = collection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Recovery contacts",
                vcard("kept-contact", "Kept Person"), vcard("deleted-contact", "Deleted Person"))
            val sharedBook = collection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Shared contacts",
                vcard("shared-kept", "Shared Kept"), vcard("shared-deleted", "Shared Deleted"), readOnly = true)
            val siblings = mapOf(
                Constants.ETEBASE_TYPE_CALENDAR to collection(Constants.ETEBASE_TYPE_CALENDAR, "Recovery calendar",
                    "BEGIN:VCALENDAR\r\nSUMMARY:Kept event\r\nEND:VCALENDAR\r\n", "BEGIN:VCALENDAR\r\nSUMMARY:Gone event\r\nEND:VCALENDAR\r\n"),
                Constants.ETEBASE_TYPE_TASKS to collection(Constants.ETEBASE_TYPE_TASKS, "Recovery tasks",
                    "BEGIN:VCALENDAR\r\nSUMMARY:Kept task\r\nEND:VCALENDAR\r\n", "BEGIN:VCALENDAR\r\nSUMMARY:Gone task\r\nEND:VCALENDAR\r\n"),
                Constants.ETEBASE_TYPE_NOTES to collection(Constants.ETEBASE_TYPE_NOTES, "Recovery notes", "Kept note", "Gone note")
            )
            val provider = context.contentResolver.acquireContentProviderClient(contacts)!!
            val childOf = try {
                listOf(book, sharedBook).associateWith { uid ->
                    val cached = cache.collectionGet(colMgr, uid)
                    io.silentsuite.sync.resource.LocalAddressBook.create(context, provider, account, cached)
                    Account(io.silentsuite.sync.resource.LocalAddressBook.accountName(account, cached), App.addressBookAccountType).also {
                        children += it
                        android.content.ContentResolver.setSyncAutomatically(it, contacts, false)
                        android.content.ContentResolver.setIsSyncable(it, contacts, 0)
                    }
                }
            } finally { provider.release() }
            fun dirtyFlags(child: Account): List<Int> = context.contentResolver.query(
                android.provider.ContactsContract.RawContacts.CONTENT_URI,
                arrayOf(android.provider.ContactsContract.RawContacts.DIRTY),
                "${android.provider.ContactsContract.RawContacts.ACCOUNT_NAME}=? AND " +
                    "${android.provider.ContactsContract.RawContacts.ACCOUNT_TYPE}=? AND " +
                    "${android.provider.ContactsContract.RawContacts.DELETED}=0",
                arrayOf(child.name, child.type), null)!!.use { cursor ->
                generateSequence { if (cursor.moveToNext()) cursor.getInt(0) else null }.toList()
            }
            fun shownItems(activity: CollectionActivity) =
                androidx.lifecycle.ViewModelProvider(activity)[ItemsViewModel::class.java].value

            // The ordinary screen leaves the deleted contact out; calendars, tasks and notes keep theirs.
            (mapOf(Constants.ETEBASE_TYPE_ADDRESS_BOOK to book) + siblings).forEach { (type, uid) ->
                ActivityScenario.launch<CollectionActivity>(CollectionActivity.newIntent(context, account, generation, uid)).use { s ->
                    val expected = if (type == Constants.ETEBASE_TYPE_ADDRESS_BOOK) 1 else 2
                    waitUntil("ordinary list of $type") {
                        var ok = false
                        s.onActivity { a ->
                            ok = shownItems(a)?.size == expected && a.findViewById<TextView>(R.id.stats).text.toString() ==
                                a.resources.getQuantityString(R.plurals.collection_recent_activity_items, expected, expected)
                        }
                        ok
                    }
                    s.onActivity { a ->
                        val items = shownItems(a)!!
                        assertEquals(type, if (type == Constants.ETEBASE_TYPE_ADDRESS_BOOK) 0 else 1, items.count { it.item.isDeleted })
                        if (type == Constants.ETEBASE_TYPE_ADDRESS_BOOK) assertTrue(items.single().content.contains("Kept Person"))
                    }
                }
            }
            // The recovery route is for address books only.
            ActivityScenario.launch<CollectionActivity>(CollectionActivity.newRecoveryIntent(context, account, generation,
                siblings.getValue(Constants.ETEBASE_TYPE_CALENDAR))).use { s ->
                waitUntil("calendar recovery route to close") { s.state == Lifecycle.State.DESTROYED }
            }

            fun itemScreen(a: CollectionActivity) =
                a.supportFragmentManager.findFragmentById(R.id.fragment_container) as? CollectionItemFragment
            fun restoreMenuItem(a: CollectionActivity): android.view.MenuItem {
                val menu = MenuBuilder(a)
                itemScreen(a)!!.onCreateOptionsMenu(menu, a.menuInflater)
                return menu.findItem(R.id.on_restore_item)
            }
            /** The Main tab of the current item screen, once it shows [name] in its own attached view. */
            fun renderedContact(a: CollectionActivity, name: String): PrettyFragment? {
                val screen = itemScreen(a) ?: return null
                if (screen.view?.findViewById<androidx.viewpager.widget.ViewPager>(R.id.viewpager)?.adapter?.count != 3) return null
                val main = screen.childFragmentManager.fragments.filterIsInstance<PrettyFragment>().singleOrNull() ?: return null
                val shown = main.view?.takeIf { main.isAdded && it.isAttachedToWindow } ?: return null
                val rendered = shown.findViewById<TextView>(R.id.display_name).text.toString() == name &&
                    shown.findViewById<View>(R.id.content_container).visibility == View.VISIBLE &&
                    shown.findViewById<View>(R.id.loading_msg).visibility == View.GONE
                return main.takeIf { rendered }
            }
            fun awaitItemScreen(s: ActivityScenario<CollectionActivity>, name: String) = waitUntil("deleted contact $name shown") {
                var ok = false
                s.onActivity { a -> ok = renderedContact(a, name) != null }
                ok
            }
            fun openDeletedContact(uid: String, name: String): ActivityScenario<CollectionActivity> {
                val s = ActivityScenario.launch<CollectionActivity>(CollectionActivity.newRecoveryIntent(context, account, generation, uid))
                waitUntil("recovery list of $uid") {
                    var ok = false
                    s.onActivity { a ->
                        val list = a.supportFragmentManager.findFragmentById(R.id.fragment_container) as? ListEntriesFragment
                        ok = list?.listAdapter?.count == 1
                    }
                    ok
                }
                s.onActivity { a ->
                    val list = a.supportFragmentManager.findFragmentById(R.id.fragment_container) as ListEntriesFragment
                    assertTrue("the recovery list shows only the deleted contact",
                        (list.listAdapter!!.getItem(0) as io.silentsuite.sync.CachedItem).item.isDeleted)
                    list.onItemClick(list.listView, list.listView, 0, 0L)
                }
                awaitItemScreen(s, name)
                return s
            }
            fun dialogButton(id: Int) = onView(androidx.test.espresso.matcher.ViewMatchers.withId(id)).inRoot(isDialog())
            val child = childOf.getValue(book)

            openDeletedContact(book, "Deleted Person").use { s ->
                // A rotation keeps the opened contact shown and usable, with its exact identity and
                // Restore; the Main tab is rebuilt in a new view rather than reusing the old one.
                var beforeRotation: PrettyFragment? = null
                s.onActivity { a -> beforeRotation = renderedContact(a, "Deleted Person") }
                assertTrue("the deleted contact is shown before rotation", beforeRotation != null)
                s.recreate()
                awaitItemScreen(s, "Deleted Person")
                s.onActivity { a ->
                    assertTrue(renderedContact(a, "Deleted Person") !== beforeRotation)
                    assertFalse(beforeRotation!!.isAdded)
                }
                s.onActivity { a ->
                    val identity = CollectionLifecycleIdentity.from(itemScreen(a)!!.arguments)!!
                    assertEquals(CollectionLifecycleIdentity.existing(account, generation, book, Constants.ETEBASE_TYPE_ADDRESS_BOOK), identity)
                    assertTrue(restoreMenuItem(a).isVisible)
                }

                // Cancelling the confirmation writes nothing.
                s.onActivity { a -> itemScreen(a)!!.onOptionsItemSelected(restoreMenuItem(a)) }
                onView(withText(R.string.contact_restore_confirm_body)).inRoot(isDialog()).check(matches(isDisplayed()))
                dialogButton(android.R.id.button2).perform(click())
                assertEquals(emptyList<Int>(), dirtyFlags(child))

                // A generation replaced while the confirmation is open gets nothing written.
                s.onActivity { a -> itemScreen(a)!!.onOptionsItemSelected(restoreMenuItem(a)) }
                onView(withText(R.string.contact_restore_confirm_body)).inRoot(isDialog()).check(matches(isDisplayed()))
                check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "contacts-recovery-replaced"))
                dialogButton(android.R.id.button1).perform(click())
                assertEquals(emptyList<Int>(), dirtyFlags(child))
                check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))

                // With the parent generation current again, a child address book that records a
                // previous owner generation, or no owner, is never the destination.
                val ownerKey = io.silentsuite.sync.resource.LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY
                val statusStore = io.silentsuite.sync.syncadapter.SyncStatusStore(context)
                val currentOwner = manager.getUserData(child, ownerKey)
                assertEquals(statusStore.identity(account, generation).storageKey, currentOwner)
                try {
                    listOf(statusStore.identity(account, "contacts-recovery-previous").storageKey, null).forEach { staleOwner ->
                        manager.setUserData(child, ownerKey, staleOwner)
                        s.onActivity { a -> itemScreen(a)!!.onOptionsItemSelected(restoreMenuItem(a)) }
                        onView(withText(R.string.contact_restore_confirm_body)).inRoot(isDialog()).check(matches(isDisplayed()))
                        dialogButton(android.R.id.button1).perform(click())
                        onView(withText(R.string.journal_item_restore_dialog_body))
                            .check(androidx.test.espresso.assertion.ViewAssertions.doesNotExist())
                        assertEquals("owner $staleOwner", emptyList<Int>(), dirtyFlags(child))
                    }
                } finally {
                    manager.setUserData(child, ownerKey, currentOwner)
                }
                assertEquals(currentOwner, manager.getUserData(child, ownerKey))

                // Confirming writes the contact into its exact address book, marked for upload.
                s.onActivity { a -> itemScreen(a)!!.onOptionsItemSelected(restoreMenuItem(a)) }
                dialogButton(android.R.id.button1).perform(click())
                onView(withText(R.string.journal_item_restore_dialog_body)).inRoot(isDialog()).check(matches(isDisplayed()))
                dialogButton(android.R.id.button1).perform(click())
                assertEquals(listOf(1), dirtyFlags(child))
                assertEquals(emptyList<Int>(), dirtyFlags(childOf.getValue(sharedBook)))
                val restoredNames = context.contentResolver.query(
                    android.provider.ContactsContract.Data.CONTENT_URI,
                    arrayOf(android.provider.ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME),
                    "${android.provider.ContactsContract.Data.MIMETYPE}=? AND " +
                        "${android.provider.ContactsContract.RawContacts.ACCOUNT_NAME}=? AND " +
                        "${android.provider.ContactsContract.RawContacts.ACCOUNT_TYPE}=?",
                    arrayOf(android.provider.ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, child.name, child.type),
                    null)!!.use { cursor -> generateSequence { if (cursor.moveToNext()) cursor.getString(0) else null }.toList() }
                assertEquals("the restored contact is the deleted one", listOf("Deleted Person"), restoredNames)
            }

            // A read-only address book offers no Restore and its operation refuses the write.
            openDeletedContact(sharedBook, "Shared Deleted").use { s ->
                s.onActivity { a ->
                    assertFalse(restoreMenuItem(a).isVisible)
                    itemScreen(a)!!.restoreItem(androidx.lifecycle.ViewModelProvider(a)[AccountViewModel::class.java].value!!)
                }
                onView(withText(R.string.contact_restore_read_only)).inRoot(isDialog()).check(matches(isDisplayed()))
                dialogButton(android.R.id.button1).perform(click())
            }
            val sharedIdentity = CollectionLifecycleIdentity.existing(account, generation, sharedBook, Constants.ETEBASE_TYPE_ADDRESS_BOOK)
            assertFalse(CollectionItemFragment.restoreContact(context, sharedIdentity,
                cache.collectionGet(colMgr, sharedBook), vcard("shared-deleted", "Shared Deleted")))
            assertEquals(emptyList<Int>(), dirtyFlags(childOf.getValue(sharedBook)))
            // The local address book's own read-only mark is checked at the write as well.
            val bookIdentity = CollectionLifecycleIdentity.existing(account, generation, book, Constants.ETEBASE_TYPE_ADDRESS_BOOK)
            io.silentsuite.sync.resource.LocalAddressBook(context, child, null).readOnly = true
            assertFalse(CollectionItemFragment.restoreContact(context, bookIdentity,
                cache.collectionGet(colMgr, book), vcard("second-contact", "Second Person")))
            assertEquals(listOf(1), dirtyFlags(child))
        } finally {
            children.forEach { removeAccountAndWait(manager, it) }
            removeAccountAndWait(manager, account)
            io.silentsuite.sync.EtebaseLocalCache.clearUserCache(context, account.name)
        }
    }

    @Test
    fun collectionCreateCompletionRendersCreatedCollectionAndPreservesReturn() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext;val manager=AccountManager.get(context);val account=addAccount(manager,"ac41-create","ac41-create-generation");val state=AtomicReference(fixture("created-uid",""));val calls=AtomicInteger()
        runtimeFixtureOverride=exactFixture(account,"ac41-create-generation",null,Constants.ETEBASE_TYPE_CALENDAR) { state.get() };collectionMutationOverride={ _,id,m -> assertEquals(account,id.account);assertEquals("ac41-create-generation",id.creationId);assertEquals(null,id.collectionUid);assertEquals(Constants.ETEBASE_TYPE_CALENDAR,id.collectionType);assertTrue(m.creating);assertEquals("created",m.name);assertEquals("created description",m.description);state.set(state.get().copy(name=m.name,description=m.description));calls.incrementAndGet();"created-uid" }
        try { ActivityScenario.launchActivityForResult<CollectionActivity>(CollectionActivity.newCreateCollectionIntent(context,account,"ac41-create-generation",Constants.ETEBASE_TYPE_CALENDAR)).use { s -> waitUntil("editor") { var ok=false;s.onActivity { ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is EditCollectionFragment };ok };s.onActivity { it.findViewById<android.widget.EditText>(R.id.display_name).setText("created");it.findViewById<android.widget.EditText>(R.id.description).setText("created description");assertFalse(it.findViewById<android.widget.EditText>(R.id.display_name).isSaveEnabled);assertFalse(it.findViewById<android.widget.EditText>(R.id.description).isSaveEnabled);it.recreate() };s.onActivity { assertEquals("created description",it.findViewById<android.widget.EditText>(R.id.description).text.toString());val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as EditCollectionFragment;f.onOptionsItemSelected(MenuBuilder(it).add(0, R.id.on_save, 0, "Save")) };waitUntil("created view") { var ok=false;s.onActivity { ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is ViewCollectionFragment };ok };assertEquals(1,calls.get());s.onActivity { val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as ViewCollectionFragment;assertEquals("created-uid",f.arguments!!.getString("collection.identity.uid"));assertEquals(Constants.ETEBASE_TYPE_CALENDAR,f.arguments!!.getString("collection.identity.type"));it.onBackPressedDispatcher.onBackPressed() };assertEquals(android.app.Activity.RESULT_CANCELED,s.result.resultCode) }} finally { collectionMutationOverride=null;runtimeFixtureOverride=null;removeAccountAndWait(manager,account) }
    }

    @Test
    fun collectionEditCompletionReturnsToUpdatedCollection() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext;val manager=AccountManager.get(context);val account=addAccount(manager,"ac41-edit","ac41-edit-generation");val initialState=fixture();val state=AtomicReference(initialState);val calls=AtomicInteger()
        runtimeFixtureOverride=exactFixture(account,"ac41-edit-generation",initialState.uid,null) { state.get() };collectionMutationOverride={ _,id,m -> assertEquals(account,id.account);assertEquals("ac41-edit-generation",id.creationId);assertEquals(state.get().uid,id.collectionUid);assertEquals(state.get().type,id.collectionType);assertFalse(m.creating);assertEquals("updated description",m.description);state.set(state.get().copy(name=m.name,description=m.description));calls.incrementAndGet();state.get().uid }
        try { ActivityScenario.launchActivityForResult<CollectionActivity>(CollectionActivity.newIntent(context,account,"ac41-edit-generation",initialState.uid)).use { s -> waitUntil("view") { var ok=false;s.onActivity {ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is ViewCollectionFragment};ok };s.onActivity { val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as ViewCollectionFragment;f.onOptionsItemSelected(MenuBuilder(it).add(0, R.id.on_edit, 0, "Edit")) };waitUntil("edit") { var ok=false;s.onActivity {ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is EditCollectionFragment};ok };s.onActivity { it.findViewById<android.widget.EditText>(R.id.display_name).setText("updated");it.findViewById<android.widget.EditText>(R.id.description).setText("updated description");it.recreate() };s.onActivity { assertEquals("updated description",it.findViewById<android.widget.EditText>(R.id.description).text.toString());(it.supportFragmentManager.findFragmentById(R.id.fragment_container) as EditCollectionFragment).onOptionsItemSelected(MenuBuilder(it).add(0, R.id.on_save, 0, "Save")) };waitUntil("updated") { var ok=false;s.onActivity {ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is ViewCollectionFragment&&it.findViewById<TextView>(R.id.display_name).text.toString()=="updated"};ok };assertEquals(1,calls.get());s.onActivity {it.onBackPressedDispatcher.onBackPressed()};assertEquals(android.app.Activity.RESULT_CANCELED,s.result.resultCode) }} finally {collectionMutationOverride=null;runtimeFixtureOverride=null;removeAccountAndWait(manager,account)}
    }

    @Test
    fun collectionMembersRenderRemoveAndReturnToExactCollection() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext;val manager=AccountManager.get(context);val account=addAccount(manager,"ac41-members","ac41-members-generation");val initialState=fixture(members=listOf(RuntimeMember("admin",com.etebase.client.CollectionAccessLevel.Admin),RuntimeMember("writer",com.etebase.client.CollectionAccessLevel.ReadWrite)));val state=AtomicReference(initialState);val calls=AtomicInteger()
        runtimeFixtureOverride=exactFixture(account,"ac41-members-generation",initialState.uid,null) { state.get() };memberRemoveOverride={ _,id,user -> assertEquals(account,id.account);assertEquals("ac41-members-generation",id.creationId);assertEquals(initialState.uid,id.collectionUid);assertEquals(initialState.type,id.collectionType);assertEquals("writer",user);state.set(state.get().copy(members=state.get().members.filter {it.username!=user}));calls.incrementAndGet();true }
        try { ActivityScenario.launchActivityForResult<CollectionActivity>(CollectionActivity.newIntent(context,account,"ac41-members-generation",initialState.uid)).use { s -> waitUntil("view") {var ok=false;s.onActivity {ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is ViewCollectionFragment};ok};s.onActivity { (it.supportFragmentManager.findFragmentById(R.id.fragment_container) as ViewCollectionFragment).onOptionsItemSelected(MenuBuilder(it).add(0, R.id.on_manage_members, 0, "Members")) };waitUntil("members") {var ok=false;s.onActivity {ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is CollectionMembersFragment};ok};waitUntil("member rows laid out") { var ok=false;s.onActivity { val list=memberListView(it);ok=list!=null&&list.adapter?.count==2&&list.childCount>=2&&list.getChildAt(0)!=null&&list.getChildAt(1)!=null&&it.findViewById<TextView>(R.id.display_name).text.toString()==initialState.name };ok };s.recreate();waitUntil("recreated member rows laid out") { var ok=false;s.onActivity { val list=memberListView(it);ok=list!=null&&list.adapter?.count==2&&list.childCount>=2&&list.getChildAt(0)!=null&&list.getChildAt(1)!=null };ok };s.onActivity { val list=requireNotNull(memberListView(it));assertTrue(list.performItemClick(requireNotNull(list.getChildAt(0)),0,0)) };onView(withText(android.R.string.ok)).inRoot(isDialog()).perform(click());s.onActivity { val list=requireNotNull(memberListView(it));assertTrue(list.performItemClick(requireNotNull(list.getChildAt(1)),1,1)) };onView(withText(android.R.string.yes)).inRoot(isDialog()).perform(click());waitUntil("writer absent") {var ok=false;s.onActivity { val list=memberListView(it);ok=list?.adapter?.let { adapter -> adapter.count==1&&(adapter.getItem(0) as RuntimeMember).username=="admin" }==true };ok};assertEquals(1,calls.get());s.onActivity {it.onBackPressedDispatcher.onBackPressed()};waitUntil("parent collection") {var ok=false;s.onActivity {ok=it.supportFragmentManager.findFragmentById(R.id.fragment_container) is ViewCollectionFragment};ok};s.onActivity { val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as ViewCollectionFragment;assertEquals(account,f.arguments!!.getParcelable("collection.identity.account"));assertEquals("ac41-members-generation",f.arguments!!.getString("collection.identity.creationId"));assertEquals(initialState.uid,f.arguments!!.getString("collection.identity.uid"));assertEquals(initialState.type,f.arguments!!.getString("collection.identity.type"));it.onBackPressedDispatcher.onBackPressed()};assertEquals(android.app.Activity.RESULT_CANCELED,s.result.resultCode) }} finally {memberRemoveOverride=null;runtimeFixtureOverride=null;removeAccountAndWait(manager,account)}
    }

    @Test
    fun invitationAcceptCompletionReturnsToCallerForExactGeneration() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext;val manager=AccountManager.get(context);val account=addAccount(manager,"ac41-accept","ac41-accept-generation");val row=RuntimeInvitation("invite-a","alice",com.etebase.client.CollectionAccessLevel.ReadWrite,"AA:BB");val calls=AtomicInteger()
        invitationsOverride={ listOf(row) };invitationActionOverride={ _,id,key,action -> assertEquals(account,id.account);assertEquals("ac41-accept-generation",id.creationId);assertEquals("invite-a",key);assertEquals(RuntimeInvitationAction.ACCEPT,action);calls.incrementAndGet();Result.success(Unit) }
        try { ActivityScenario.launchActivityForResult<InvitationsActivity>(InvitationsActivity.newIntent(context,account,"ac41-accept-generation")).use { s -> s.recreate();waitUntil("invitation row laid out") {var ok=false;s.onActivity { val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as? InvitationsListFragment;ok=f?.listAdapter?.count==1&&f.listView.getChildAt(0)!=null };ok};s.onActivity { val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as InvitationsListFragment;assertEquals("ac41-accept-generation",f.arguments!!.getString("invitation.identity.creationId"));assertEquals("Invitation from alice",(f.listAdapter!!.getItem(0) as InvitationRow).let { row -> context.getString(R.string.invitations_from,row.runtime.fromUsername) });f.onItemClick(f.listView,requireNotNull(f.listView.getChildAt(0)),0,0) };onView(withText("AA:BB")).inRoot(isDialog()).check(matches(isDisplayed()));onView(withText(R.string.invitations_accept)).inRoot(isDialog()).perform(click());waitUntil("accept return") {s.state==Lifecycle.State.DESTROYED};assertEquals(1,calls.get());assertEquals(android.app.Activity.RESULT_CANCELED,s.result.resultCode) }} finally { invitationActionOverride=null;invitationsOverride=null;removeAccountAndWait(manager,account) }
    }

    @Test
    fun invitationRejectCompletionUpdatesListAndReturnsForExactGeneration() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext;val manager=AccountManager.get(context);val account=addAccount(manager,"ac41-reject","ac41-reject-generation");val rows=AtomicReference(listOf(RuntimeInvitation("invite-r","bob",com.etebase.client.CollectionAccessLevel.ReadOnly,"CC:DD")));val calls=AtomicInteger()
        invitationsOverride={rows.get()};invitationActionOverride={ _,id,key,action -> assertEquals(account,id.account);assertEquals("ac41-reject-generation",id.creationId);assertEquals("invite-r",key);assertEquals(RuntimeInvitationAction.REJECT,action);rows.set(emptyList());calls.incrementAndGet();Result.success(Unit) }
        try { ActivityScenario.launchActivityForResult<InvitationsActivity>(InvitationsActivity.newIntent(context,account,"ac41-reject-generation")).use { s -> s.recreate();waitUntil("invitation row laid out") {var ok=false;s.onActivity { val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as? InvitationsListFragment;ok=f?.listAdapter?.count==1&&f.listView.getChildAt(0)!=null };ok};s.onActivity {val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as InvitationsListFragment;assertEquals("ac41-reject-generation",f.arguments!!.getString("invitation.identity.creationId"));f.onItemClick(f.listView,requireNotNull(f.listView.getChildAt(0)),0,0)};onView(withText("CC:DD")).inRoot(isDialog()).check(matches(isDisplayed()));onView(withText(R.string.invitations_reject)).inRoot(isDialog()).perform(click());waitUntil("rendered rejection") {var ok=false;s.onActivity {val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as? InvitationsListFragment;ok=calls.get()==1&&f?.listAdapter?.count==0};ok};s.onActivity {val f=it.supportFragmentManager.findFragmentById(R.id.fragment_container) as InvitationsListFragment;assertEquals(0,f.listAdapter!!.count);assertEquals(Lifecycle.State.RESUMED,it.lifecycle.currentState);it.onBackPressedDispatcher.onBackPressed()};waitUntil("reject return") {s.state==Lifecycle.State.DESTROYED};assertEquals(Lifecycle.State.DESTROYED,s.state);assertEquals(android.app.Activity.RESULT_CANCELED,s.result.resultCode)}} finally {invitationActionOverride=null;invitationsOverride=null;removeAccountAndWait(manager,account)}
    }

    // ---- Contacts native-store repopulation ----
    // Real Etebase cache, the in-process stand-in server and the real ContactsProvider; every sync is a
    // direct ContactsSyncManager run, with platform sync kept off for the whole fixture.

    private val nativeItemList = Regex("collection/[^/]+/item/")
    private val nativeItemUpload = Regex("POST collection/[^/]+/item/(batch|transaction)/.*")

    private fun nativeVcard(uid: String, name: String) =
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:$uid\r\nFN:$name\r\nN:$name;;;;\r\nEND:VCARD\r\n"

    private fun nativeGroupVcard(uid: String, title: String, members: List<String>) =
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:$uid\r\nFN:$title\r\nN:$title;;;;\r\nX-ADDRESSBOOKSERVER-KIND:group\r\n" +
            members.joinToString("") { "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:$it\r\n" } + "END:VCARD\r\n"

    private fun people(vararg uids: String) = uids.map { it to nativeVcard(it, "Person $it") }

    private val success = SyncManager.ProviderOutcome.SUCCESS

    private inner class NativeStore {
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager: AccountManager = AccountManager.get(context)
        val fake = FakeEtebaseServer()
        private val previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        var main: Account? = null
        lateinit var generation: String
        lateinit var colMgr: com.etebase.client.CollectionManager
        lateinit var cache: EtebaseLocalCache
        lateinit var colUid: String
        private val itemUids = LinkedHashMap<String, String>()
        private val natives = mutableListOf<Account>()
        private val threads = mutableListOf<Thread>()

        fun setUp(prefix: String) {
            // Off before any account exists, so no platform sync competes with the direct runs below.
            ContentResolver.setMasterSyncAutomatically(false)
            HttpClient.testInterceptor = fake
            val client = com.etebase.client.Client.create(okhttp3.OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            val session = com.etebase.client.Account.signup(client,
                com.etebase.client.User("$prefix-${System.nanoTime()}", "$prefix@example.invalid"),
                "stand-in-server-only").save(null)
            colMgr = com.etebase.client.Account.restore(client, session, null).collectionManager
            generation = "$prefix-generation-${System.nanoTime()}"
            val account = addAccount(manager, prefix, generation)
            main = account
            listOf(App.addressBooksAuthority, android.provider.CalendarContract.AUTHORITY).forEach {
                ContentResolver.setIsSyncable(account, it, 0)
            }
            ContentResolver.cancelSync(account, null)
            AccountSettings.setUserData(manager, account, java.net.URI(fake.baseUrl), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
            AccountSettings(context, account).etebaseSession = session
            cache = EtebaseLocalCache.getInstance(context, account.name)
        }

        /** Returns the first cleanup failure instead of throwing, so it never hides the test's own failure. */
        fun tearDown(): Throwable? {
            val failures = mutableListOf<Throwable>()
            fun attempt(step: () -> Unit) {
                try { step() } catch (t: Throwable) { failures.add(t) }
            }
            attempt { ContactsSyncManager.installSyncStateFaultForTest(null) }
            attempt { fake.releaseAll() }
            threads.forEach { thread ->
                attempt {
                    thread.join(60_000)
                    if (thread.isAlive) { thread.interrupt(); thread.join(10_000) }
                }
            }
            natives.forEach { native -> attempt { removeAccountAndWait(manager, native) } }
            main?.let { account ->
                attempt { removeAccountAndWait(manager, account) }
                attempt { EtebaseLocalCache.clearUserCache(context, account.name) }
            }
            attempt { HttpClient.testInterceptor = null }
            attempt { ContentResolver.setMasterSyncAutomatically(previousMasterSync) }
            return failures.firstOrNull()
        }

        /** An address book with [entries] on the server, cached the way a collection refresh caches it. */
        fun book(name: String, entries: List<Pair<String, String>>) {
            val created = colMgr.create(Constants.ETEBASE_TYPE_ADDRESS_BOOK, com.etebase.client.ItemMetadata().apply { this.name = name }, "")
            colMgr.upload(created)
            colUid = created.uid
            upload(entries)
            recache()
        }

        private fun items() = colMgr.getItemManager(colMgr.fetch(colUid))

        /** Adds [entries] in one upload, as another device would. */
        fun upload(entries: List<Pair<String, String>>) {
            val itemMgr = items()
            val created = entries.map { (uid, content) ->
                itemMgr.create(com.etebase.client.ItemMetadata().apply { this.name = uid; mtime = System.currentTimeMillis() }, content)
                    .also { itemUids[uid] = it.uid }
            }
            itemMgr.batch(created.toTypedArray())
        }

        fun changeRemote(uid: String, content: String) {
            val itemMgr = items()
            val item = itemMgr.fetch(itemUids.getValue(uid))
            item.setContent(content)
            itemMgr.batch(arrayOf(item))
        }

        fun serverContent(uid: String): String = items().fetch(itemUids.getValue(uid)).contentString
        fun serverDeleted(uid: String): Boolean = items().fetch(itemUids.getValue(uid)).isDeleted

        /** Deletes an entry on the server, as another device would. */
        fun deleteRemote(uid: String) {
            val itemMgr = items()
            val item = itemMgr.fetch(itemUids.getValue(uid))
            item.delete()
            itemMgr.batch(arrayOf(item))
        }

        fun recache() = synchronized(cache) { cache.collectionSet(colMgr, colMgr.fetch(colUid)) }
        fun cursor(): String? = synchronized(cache) { cache.collectionLoadStoken(colUid) }

        /** A native address book for the collection, created as the parent adapter creates it, then kept from syncing. */
        fun createNative(): Account {
            val owner = requireNotNull(main)
            val provider = requireNotNull(context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY))
            try {
                val cached = synchronized(cache) { cache.collectionGet(colMgr, colUid) }
                LocalAddressBook.create(context, provider, owner, cached)
                val native = Account(LocalAddressBook.accountName(owner, cached), App.addressBookAccountType)
                natives += native
                // create() turns Contacts sync on for the new row; master sync is already off.
                ContentResolver.setSyncAutomatically(native, ContactsContract.AUTHORITY, false)
                ContentResolver.setIsSyncable(native, ContactsContract.AUTHORITY, 0)
                ContentResolver.cancelSync(native, ContactsContract.AUTHORITY)
                ContentResolver.cancelSync(owner, null)
                return native
            } finally {
                provider.release()
            }
        }

        fun removeNative(native: Account) {
            removeAccountAndWait(manager, native)
            waitUntil("provider rows of the removed address book") {
                rawRows(native, includeDeleted = true).isEmpty() && groupRows(native, "").isEmpty()
            }
        }

        fun sync(native: Account, result: SyncResult = SyncResult()): SyncManager.ProviderOutcome {
            val provider = requireNotNull(context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY))
            try {
                return ContactsSyncManager(context, native, AccountSettings(context, requireNotNull(main)), Bundle(),
                    ContactsContract.AUTHORITY, provider, result, LocalAddressBook(context, native, provider),
                    fake.baseUrl.toHttpUrl()).use { it.performSync() }
            } finally {
                provider.release()
            }
        }

        /** Runs [sync] on its own thread; [join] returns its outcome, or the throwable it ended with. */
        fun syncInBackground(native: Account): Pair<Thread, AtomicReference<Any?>> {
            val outcome = AtomicReference<Any?>()
            val thread = Thread { outcome.set(try { sync(native) } catch (t: Throwable) { t }) }
            threads += thread
            thread.start()
            return thread to outcome
        }

        fun join(run: Pair<Thread, AtomicReference<Any?>>): Any? {
            run.first.join(60_000)
            assertFalse("the background sync finished", run.first.isAlive)
            return run.second.get()
        }

        fun holdItemList(): FakeEtebaseServer.Hold = fake.hold("GET", nativeItemList)

        fun itemListRequests() = fake.requests.filter {
            it.startsWith("GET ") && nativeItemList.matches(it.removePrefix("GET ").substringBefore('?'))
        }
        fun itemUploadRequests() = fake.requests.filter { nativeItemUpload.matches(it) }

        private fun ofAccount(native: Account) = arrayOf(native.name, native.type)

        fun rawRows(native: Account, includeDeleted: Boolean = false): List<Pair<Long, String>> = context.contentResolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID, ContactsContract.RawContacts.SYNC1),
            "${ContactsContract.RawContacts.ACCOUNT_NAME}=? AND ${ContactsContract.RawContacts.ACCOUNT_TYPE}=?" +
                if (includeDeleted) "" else " AND ${ContactsContract.RawContacts.DELETED}=0",
            ofAccount(native), null)!!.use { c ->
            generateSequence { if (c.moveToNext()) c.getLong(0) to c.getString(1).orEmpty() else null }.toList()
        }

        fun liveUids(native: Account): List<String> = rawRows(native).map { it.second }.sorted()
        fun rawId(native: Account, uid: String): Long = rawRows(native).single { it.second == uid }.first

        /** Group rows of [native] with vCard UID [uid] (all rows when blank), deleted ones included only when blank. */
        fun groupRows(native: Account, uid: String): List<Long> = context.contentResolver.query(
            ContactsContract.Groups.CONTENT_URI, arrayOf(ContactsContract.Groups._ID),
            "${ContactsContract.Groups.ACCOUNT_NAME}=? AND ${ContactsContract.Groups.ACCOUNT_TYPE}=?" +
                if (uid.isEmpty()) "" else " AND ${ContactsContract.Groups.SYNC1}=? AND ${ContactsContract.Groups.DELETED}=0",
            if (uid.isEmpty()) ofAccount(native) else ofAccount(native) + uid, null)!!.use { c ->
            generateSequence { if (c.moveToNext()) c.getLong(0) else null }.toList()
        }

        fun groupId(native: Account, uid: String): Long {
            val rows = groupRows(native, uid)
            assertEquals("exactly one group $uid", 1, rows.size)
            return rows.single()
        }

        fun groupTitle(groupId: Long): String? = context.contentResolver.query(
            ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupId),
            arrayOf(ContactsContract.Groups.TITLE), null, null, null)!!.use { c -> if (c.moveToNext()) c.getString(0) else null }

        fun members(native: Account, groupId: Long): Set<String> {
            val live = rawRows(native).toMap()
            return context.contentResolver.query(ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.Data.RAW_CONTACT_ID),
                "${ContactsContract.Data.MIMETYPE}=? AND ${ContactsContract.CommonDataKinds.GroupMembership.GROUP_ROW_ID}=?",
                arrayOf(ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE, groupId.toString()), null)!!.use { c ->
                generateSequence { if (c.moveToNext()) c.getLong(0) else null }.toList()
            }.mapNotNull { live[it] }.toSet()
        }

        fun phones(rawId: Long): List<String> = context.contentResolver.query(ContactsContract.Data.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.Data.RAW_CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
            arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE), null)!!.use { c ->
            generateSequence { if (c.moveToNext()) c.getString(0).orEmpty() else null }.toList()
        }

        fun dirty(rawId: Long): Boolean = context.contentResolver.query(
            ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, rawId),
            arrayOf(ContactsContract.RawContacts.DIRTY), null, null, null)!!.use { c -> c.moveToNext() && c.getInt(0) != 0 }

        /** The provider's sync-state slot of [native]; null when nothing is stored. */
        fun slot(native: Account): ByteArray? {
            val provider = requireNotNull(context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY))
            try { return ContactsContract.SyncState.get(provider, native) } finally { provider.release() }
        }

        /** Models an address book an earlier app version populated: no sync-state slot. */
        fun clearSlot(native: Account) {
            val provider = requireNotNull(context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY))
            try {
                provider.delete(ContactsContract.SyncState.CONTENT_URI,
                    "${SyncStateContract.Columns.ACCOUNT_NAME}=? AND ${SyncStateContract.Columns.ACCOUNT_TYPE}=?", ofAccount(native))
            } finally {
                provider.release()
            }
        }

        // Native user changes (not as a sync adapter, so the provider marks them dirty or deleted).
        fun addPhone(rawId: Long, number: String) {
            context.contentResolver.insert(ContactsContract.Data.CONTENT_URI, ContentValues().apply {
                put(ContactsContract.Data.RAW_CONTACT_ID, rawId)
                put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                put(ContactsContract.CommonDataKinds.Phone.NUMBER, number)
                put(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
            })
        }

        fun userDelete(rawId: Long) {
            context.contentResolver.delete(ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, rawId), null, null)
        }

        fun addToGroup(rawId: Long, groupId: Long) {
            context.contentResolver.insert(ContactsContract.Data.CONTENT_URI, ContentValues().apply {
                put(ContactsContract.Data.RAW_CONTACT_ID, rawId)
                put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE)
                put(ContactsContract.CommonDataKinds.GroupMembership.GROUP_ROW_ID, groupId)
            })
        }

        fun retitleGroup(groupId: Long, title: String) {
            context.contentResolver.update(ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupId),
                ContentValues().apply { put(ContactsContract.Groups.TITLE, title) }, null, null)
        }

        /** A native removal of one membership row, so the provider marks the contact dirty. */
        fun removeFromGroup(rawId: Long, groupId: Long) {
            context.contentResolver.delete(ContactsContract.Data.CONTENT_URI,
                "${ContactsContract.Data.RAW_CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=? AND " +
                    "${ContactsContract.CommonDataKinds.GroupMembership.GROUP_ROW_ID}=?",
                arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE, groupId.toString()))
        }

        fun groupDirty(groupId: Long): Boolean = context.contentResolver.query(
            ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupId),
            arrayOf(ContactsContract.Groups.DIRTY), null, null, null)!!.use { c -> c.moveToNext() && c.getInt(0) != 0 }

        /** Members of [groupId] by its cached membership rows: the state last agreed with the server. */
        fun cachedMembers(native: Account, groupId: Long): Set<String> {
            val live = rawRows(native).toMap()
            return context.contentResolver.query(ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.Data.RAW_CONTACT_ID),
                "${ContactsContract.Data.MIMETYPE}=? AND ${at.bitfire.vcard4android.CachedGroupMembership.GROUP_ID}=?",
                arrayOf(at.bitfire.vcard4android.CachedGroupMembership.CONTENT_ITEM_TYPE, groupId.toString()), null)!!.use { c ->
                generateSequence { if (c.moveToNext()) c.getLong(0) else null }.toList()
            }.mapNotNull { live[it] }.toSet()
        }

        /** The group's pending server member list, as LocalGroup stores it; null when none is pending. */
        fun pendingMembers(groupId: Long): ByteArray? = context.contentResolver.query(
            ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupId),
            arrayOf(io.silentsuite.sync.resource.LocalGroup.COLUMN_PENDING_MEMBERS), null, null, null)!!.use { c ->
            if (c.moveToNext() && !c.isNull(0)) c.getBlob(0) else null
        }

        private fun asSyncAdapter(uri: android.net.Uri, native: Account): android.net.Uri = uri.buildUpon()
            .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(ContactsContract.RawContacts.ACCOUNT_NAME, native.name)
            .appendQueryParameter(ContactsContract.RawContacts.ACCOUNT_TYPE, native.type)
            .build()

        /** One membership row only, without its cached row, written as the sync adapter writes rows. */
        fun insertMembershipAsSyncAdapter(native: Account, rawId: Long, groupId: Long) {
            context.contentResolver.insert(asSyncAdapter(ContactsContract.Data.CONTENT_URI, native), ContentValues().apply {
                put(ContactsContract.Data.RAW_CONTACT_ID, rawId)
                put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE)
                put(ContactsContract.CommonDataKinds.GroupMembership.GROUP_ROW_ID, groupId)
            })
        }

        /** A pending server member list in the column and format LocalGroup.contentValues writes. */
        fun stagePendingAsSyncAdapter(native: Account, groupId: Long, memberUids: List<String>) {
            val parcel = android.os.Parcel.obtain()
            val marshalled = try {
                parcel.writeStringList(memberUids)
                parcel.marshall()
            } finally {
                parcel.recycle()
            }
            context.contentResolver.update(
                asSyncAdapter(ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupId), native),
                ContentValues().apply { put(io.silentsuite.sync.resource.LocalGroup.COLUMN_PENDING_MEMBERS, marshalled) },
                null, null)
        }

        /** The group row's filename and eTag columns. */
        fun groupFileNameAndETag(groupId: Long): Pair<String?, String?> = context.contentResolver.query(
            ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupId),
            arrayOf(ContactsContract.Groups.SOURCE_ID, ContactsContract.Groups.SYNC2), null, null, null)!!.use { c ->
            if (c.moveToNext()) c.getString(0) to c.getString(1) else null to null
        }

        /**
         * The row an upload leaves when the server and the item cache took the group but clearing the
         * provider's dirty flag failed: the filename stays, no eTag was written, the row is still dirty.
         */
        fun keepDirtyWithoutETagAsSyncAdapter(native: Account, groupId: Long) {
            context.contentResolver.update(
                asSyncAdapter(ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupId), native),
                ContentValues().apply {
                    putNull(ContactsContract.Groups.SYNC2)
                    put(ContactsContract.Groups.DIRTY, 1)
                },
                null, null)
        }

        /**
         * One sync whose main generation is replaced after the run captured its destination and before
         * it starts; the original generation is restored when the run ends, however it ends.
         */
        fun syncWithMainGenerationReplacedAfterCapture(native: Account): SyncManager.ProviderOutcome {
            val owner = requireNotNull(main)
            val provider = requireNotNull(context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY))
            try {
                return ContactsSyncManager(context, native, AccountSettings(context, owner), Bundle(),
                    ContactsContract.AUTHORITY, provider, SyncResult(), LocalAddressBook(context, native, provider),
                    fake.baseUrl.toHttpUrl()).use { run ->
                    check(AccountSettings.writeVerified(manager, owner, AccountSettings.KEY_CREATION_ID, "$generation-replaced"))
                    try {
                        run.performSync()
                    } finally {
                        check(AccountSettings.writeVerified(manager, owner, AccountSettings.KEY_CREATION_ID, generation))
                    }
                }
            } finally {
                provider.release()
            }
        }

        /** Removes a row as a sync adapter would, without leaving a local deletion to upload. */
        fun hardDelete(native: Account, uid: String) {
            context.contentResolver.delete(ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, rawId(native, uid))
                .buildUpon()
                .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
                .appendQueryParameter(ContactsContract.RawContacts.ACCOUNT_NAME, native.name)
                .appendQueryParameter(ContactsContract.RawContacts.ACCOUNT_TYPE, native.type)
                .build(), null, null)
        }

        fun hardDeleteIfPresent(native: Account, uid: String) {
            if (liveUids(native).contains(uid)) hardDelete(native, uid)
        }
    }

    private fun withNativeStore(prefix: String, block: (NativeStore) -> Unit) {
        val store = NativeStore()
        var failed = false
        try {
            store.setUp(prefix)
            block(store)
        } catch (t: Throwable) {
            failed = true
            throw t
        } finally {
            val cleanup = store.tearDown()
            if (!failed && cleanup != null) throw cleanup
        }
    }

    /** Populates [entries] into a new native address book through a real sync and returns it. */
    private fun NativeStore.populated(name: String, entries: List<Pair<String, String>>): Account {
        book(name, entries)
        val native = createNative()
        assertEquals(success, sync(native))
        return native
    }

    @Test
    fun contactsNativeStoreRepopulatesRecreatedAddressBookFromCachedCursor() = withNativeStore("native-recreated") { f ->
        val first = f.populated("Recreated contacts",
            people("a", "b", "c", "d") + ("g" to nativeGroupVcard("g", "Group G", listOf("a", "b"))))
        assertEquals(listOf("a", "b", "c", "d"), f.liveUids(first))
        assertEquals(setOf("a", "b"), f.members(first, f.groupId(first, "g")))
        f.removeNative(first)
        val recreated = f.createNative()
        f.upload(people("e"))
        f.recache()
        assertEquals(success, f.sync(recreated))
        assertEquals("every live remote contact is in the recreated native address book",
            listOf("a", "b", "c", "d", "e"), f.liveUids(recreated))
        assertEquals(setOf("a", "b"), f.members(recreated, f.groupId(recreated, "g")))
    }

    @Test
    fun contactsNativeStoreRestoresMissingRowsAndMembershipsOfUnmarkedAddressBook() = withNativeStore("native-unmarked") { f ->
        val native = f.populated("Unmarked contacts",
            people("a", "b", "c", "d") + ("g" to nativeGroupVcard("g", "Group G", listOf("a", "b"))))
        f.addPhone(f.rawId(native, "c"), "5550102")
        f.userDelete(f.rawId(native, "d"))
        f.hardDelete(native, "a")
        f.hardDelete(native, "b")
        f.clearSlot(native)
        assertEquals(success, f.sync(native))
        assertEquals("missing rows of an address book without a completion marker are restored",
            listOf("a", "b", "c"), f.liveUids(native))
        assertEquals(setOf("a", "b"), f.members(native, f.groupId(native, "g")))
        assertTrue(f.phones(f.rawId(native, "c")).contains("5550102"))
        assertTrue(f.serverContent("c").contains("5550102"))
        assertTrue(f.serverDeleted("d"))
    }

    @Test
    fun contactsNativeStoreReplayContinuesPastTheCachedCollectionTokenAndCertifiesOnlyADonePage() = withNativeStore("native-pages") { f ->
        f.fake.itemPageSize = 2
        // Four items, then the cache: the cached collection token is the cursor that ends the second page.
        val first = f.populated("Paged contacts", people("a", "b", "c", "d"))
        f.upload(people("e", "f", "g"))  // not cached again, so the cached collection token stays at d
        f.removeNative(first)
        val recreated = f.createNative()
        assertEquals(success, f.sync(recreated))
        assertEquals("the listing continues past the page whose cursor equals the cached collection token",
            listOf("a", "b", "c", "d", "e", "f", "g"), f.liveUids(recreated))
        val cursor = requireNotNull(f.cursor())
        f.fake.requests.clear()
        assertEquals(success, f.sync(recreated))
        val lists = f.itemListRequests()
        assertTrue("an incremental request follows a completed listing", lists.isNotEmpty())
        lists.forEach { line -> assertTrue(line, line.substringAfter('?', "").split('&').contains("stoken=$cursor")) }
        f.recache()
        f.fake.requests.clear()
        assertEquals(success, f.sync(recreated))
        assertEquals(emptyList<String>(), f.itemListRequests())
    }

    @Test
    fun contactsNativeStoreStalledReplayLeavesNoMarkerAndRetriesExactly() = withNativeStore("native-stalled") { f ->
        f.fake.itemPageSize = 2
        val native = f.populated("Stalled contacts", people("a", "b", "c", "d"))
        f.hardDelete(native, "a")
        f.hardDelete(native, "b")
        f.clearSlot(native)
        f.upload(people("e"))
        f.recache()
        f.fake.stallItemList(f.colUid, FakeEtebaseServer.Stall.SAME_CURSOR)
        assertEquals(SyncManager.ProviderOutcome.FAILURE, f.sync(native))
        assertTrue(f.slot(native)?.isNotEmpty() != true)
        f.fake.stallItemList(f.colUid, null)
        assertEquals(success, f.sync(native))
        assertEquals("the retry after a stalled listing restores every live contact exactly once",
            listOf("a", "b", "c", "d", "e"), f.liveUids(native))
    }

    @Test
    fun contactsNativeStoreCancelledReplayLeavesNoMarkerAndKeepsTheEdit() = withNativeStore("native-cancelled") { f ->
        val native = f.populated("Cancelled contacts", people("a", "b", "c", "d"))
        f.hardDelete(native, "a")
        f.clearSlot(native)
        f.upload(people("e"))
        f.recache()
        val hold = f.holdItemList()
        val run = f.syncInBackground(native)
        hold.awaitArrival()
        assertTrue(f.liveUids(native).contains("c"))
        f.addPhone(f.rawId(native, "c"), "5550103")
        run.first.interrupt()
        hold.release()
        val outcome = f.join(run)
        assertTrue("the interrupted run ended with a provider outcome, not a crash: $outcome",
            outcome is SyncManager.ProviderOutcome)
        assertTrue("the interrupted run did not complete: $outcome", outcome != success)
        assertTrue(f.slot(native)?.isNotEmpty() != true)
        assertEquals(success, f.sync(native))
        assertEquals("the retry after a cancelled listing restores every live contact exactly once",
            listOf("a", "b", "c", "d", "e"), f.liveUids(native))
        assertTrue(f.phones(f.rawId(native, "c")).contains("5550103"))
        assertTrue(f.serverContent("c").contains("5550103"))
    }

    @Test
    fun contactsNativeStoreReplayKeepsALateEditOfARowDeletedOnTheServer() = withNativeStore("native-late-tombstone") { f ->
        val native = f.populated("Tombstone contacts", people("a", "b", "c", "d", "e"))
        f.clearSlot(native)
        f.deleteRemote("e")
        f.recache()
        val hold = f.holdItemList()
        val run = f.syncInBackground(native)
        hold.awaitArrival()
        f.addPhone(f.rawId(native, "e"), "5550107")
        hold.release()
        assertEquals(success, f.join(run))
        assertTrue("a native edit made during the listing outlives the server's deletion",
            f.liveUids(native).contains("e"))
        assertTrue(f.phones(f.rawId(native, "e")).contains("5550107"))
        assertTrue(f.dirty(f.rawId(native, "e")))
        // Local wins: the next run uploads the edited row again.
        assertEquals(success, f.sync(native))
        assertTrue(f.liveUids(native).contains("e"))
        assertFalse(f.serverDeleted("e"))
        assertTrue(f.serverContent("e").contains("5550107"))
    }

    @Test
    fun contactsNativeStoreReplayKeepsALateMembershipEditOfAContactSharedWithAnotherGroup() = withNativeStore("native-shared-member") { f ->
        val native = f.populated("Shared member contacts", people("a", "b", "c", "d") +
            ("g" to nativeGroupVcard("g", "Group G", listOf("a", "c"))) +
            ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
        f.clearSlot(native)
        // Another device renames G, so G's members are applied again while C's new H membership is pending.
        f.changeRemote("g", nativeGroupVcard("g", "Group G renamed", listOf("a", "c")))
        f.recache()
        val hold = f.holdItemList()
        val run = f.syncInBackground(native)
        hold.awaitArrival()
        val h = f.groupId(native, "h")
        assertTrue(f.members(native, f.groupId(native, "g")).contains("c"))
        assertFalse(f.members(native, h).contains("c"))
        f.addToGroup(f.rawId(native, "c"), h)
        hold.release()
        assertEquals(success, f.join(run))
        assertTrue("applying another group keeps a membership edit made during the listing",
            f.members(native, f.groupId(native, "h")).contains("c"))
        assertEquals(setOf("a", "c"), f.members(native, f.groupId(native, "g")))
        // Next run: the cursor equals the cached collection token, so the fetch is skipped.
        assertEquals(success, f.sync(native))
        assertEquals(setOf("a", "c"), f.members(native, f.groupId(native, "h")))
        assertEquals(setOf("a", "c"), f.members(native, f.groupId(native, "g")))
        assertTrue(f.serverContent("h").contains("urn:uuid:c"))
        assertTrue(f.serverContent("h").contains("urn:uuid:a"))
        assertTrue(f.serverContent("g").contains("urn:uuid:c"))
        // A refreshed collection makes the fetch return the uploaded revisions.
        f.recache()
        assertEquals(success, f.sync(native))
        assertEquals(setOf("a", "c"), f.members(native, f.groupId(native, "h")))
        assertEquals(setOf("a", "c"), f.members(native, f.groupId(native, "g")))
    }

    @Test
    fun contactsNativeStoreReplayAppliesBothServerAddedSharedMembers() {
        withNativeStore("native-both-shared") { f ->
            val native = f.populated("Both shared contacts", people("a", "b", "c", "d") +
                ("g" to nativeGroupVcard("g", "Group G", listOf("a"))) +
                ("h" to nativeGroupVcard("h", "Group H", listOf("c"))))
            // Each group gains the other group's member on the server, so either application order exposes a wipe.
            f.changeRemote("g", nativeGroupVcard("g", "Group G", listOf("a", "c")))
            f.changeRemote("h", nativeGroupVcard("h", "Group H", listOf("c", "a")))
            f.recache()
            f.clearSlot(native)
            fun memberships() = mapOf(
                "g" to f.members(native, f.groupId(native, "g")),
                "h" to f.members(native, f.groupId(native, "h")))
            val complete = mapOf("g" to setOf("a", "c"), "h" to setOf("a", "c"))
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals("both groups keep every server member", complete, memberships())
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(complete, memberships())
            listOf("g", "h").forEach { group ->
                assertTrue(f.serverContent(group).contains("urn:uuid:a"))
                assertTrue(f.serverContent(group).contains("urn:uuid:c"))
            }
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(complete, memberships())
        }
    }

    @Test
    fun contactsNativeStoreReplayKeepsALateGroupEditWithIncomingServerMembers() {
        withNativeStore("native-late-group-edit") { f ->
            val native = f.populated("Late group edit contacts",
                people("a", "b", "c") + ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
            f.changeRemote("h", nativeGroupVcard("h", "Group H", listOf("a", "b")))
            f.recache()
            f.clearSlot(native)
            val hold = f.holdItemList()
            f.fake.requests.clear()
            val run = f.syncInBackground(native)
            hold.awaitArrival()
            f.retitleGroup(f.groupId(native, "h"), "Local title")
            hold.release()
            assertEquals(success, f.join(run))
            assertEquals("a group edited during the listing keeps the server's members",
                setOf("a", "b"), f.members(native, f.groupId(native, "h")))
            assertEquals("Local title", f.groupTitle(f.groupId(native, "h")))
            assertTrue(f.groupDirty(f.groupId(native, "h")))
            // Next run: the cursor equals the cached collection token, so the fetch is skipped.
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertTrue(f.serverContent("h").contains("urn:uuid:b"))
            assertTrue(f.serverContent("h").contains("Local title"))
            assertEquals(setOf("a", "b"), f.members(native, f.groupId(native, "h")))
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a", "b"), f.members(native, f.groupId(native, "h")))
            assertEquals("Local title", f.groupTitle(f.groupId(native, "h")))
        }
    }

    @Test
    fun contactsNativeStoreReplayKeepsALateMembershipRemovalAgainstTheServerList() {
        withNativeStore("native-late-removal") { f ->
            val native = f.populated("Late removal contacts", people("a", "b", "c", "d") +
                ("g" to nativeGroupVcard("g", "Group G", listOf("a", "c"))) +
                ("h" to nativeGroupVcard("h", "Group H", listOf("a", "c"))))
            f.changeRemote("h", nativeGroupVcard("h", "Group H renamed", listOf("a", "c")))
            f.recache()
            f.clearSlot(native)
            val hold = f.holdItemList()
            f.fake.requests.clear()
            val run = f.syncInBackground(native)
            hold.awaitArrival()
            val h = f.groupId(native, "h")
            assertTrue(f.members(native, h).contains("c"))
            f.removeFromGroup(f.rawId(native, "c"), h)
            hold.release()
            assertEquals(success, f.join(run))
            assertEquals("a membership removed during the listing stays removed",
                setOf("a"), f.members(native, f.groupId(native, "h")))
            assertEquals(setOf("a", "c"), f.members(native, f.groupId(native, "g")))
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertFalse(f.serverContent("h").contains("urn:uuid:c"))
            assertTrue(f.serverContent("h").contains("urn:uuid:a"))
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a"), f.members(native, f.groupId(native, "h")))
            assertEquals(setOf("a", "c"), f.members(native, f.groupId(native, "g")))
        }
    }

    @Test
    fun contactsNativeStoreRetryNeverUploadsAnUnreconciledGroupEdit() {
        withNativeStore("native-unreconciled-retry") { f ->
            f.fake.itemPageSize = 2
            val native = f.populated("Unreconciled retry contacts",
                people("a", "b", "c", "d") + ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
            // Listing order is the order of the last upload: a, b, c, d, then the changed H, then e and f.
            // With two entries a page, H is applied on page three before page four is held.
            f.changeRemote("h", nativeGroupVcard("h", "Group H", listOf("a", "b")))
            f.upload(people("e", "f"))
            f.recache()
            f.clearSlot(native)
            val hold = f.fake.hold("GET", nativeItemList, skip = 3)
            f.fake.requests.clear()
            val run = f.syncInBackground(native)
            hold.awaitArrival()
            assertTrue(f.liveUids(native).containsAll(listOf("a", "b", "c", "d")))
            val h = f.groupId(native, "h")
            assertEquals(setOf("a"), f.members(native, h))
            f.retitleGroup(h, "Local title")
            run.first.interrupt()
            hold.release()
            val outcome = f.join(run)
            assertTrue("the interrupted run ended with a provider outcome, not a crash: $outcome",
                outcome is SyncManager.ProviderOutcome)
            assertTrue("the interrupted run did not complete: $outcome", outcome != success)
            assertTrue(f.slot(native)?.isNotEmpty() != true)
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertTrue("the retry does not upload the group before its server members are merged",
                f.serverContent("h").contains("urn:uuid:b"))
            assertEquals(setOf("a", "b"), f.members(native, f.groupId(native, "h")))
            assertEquals("Local title", f.groupTitle(f.groupId(native, "h")))
            assertTrue(f.groupDirty(f.groupId(native, "h")))
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertTrue(f.serverContent("h").contains("urn:uuid:b"))
            assertTrue(f.serverContent("h").contains("Local title"))
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a", "b"), f.members(native, f.groupId(native, "h")))
            assertEquals("Local title", f.groupTitle(f.groupId(native, "h")))
        }
    }

    @Test
    fun contactsNativeStoreReplayKeepsALocalRemovalWhoseServerListStillHasTheMember() {
        withNativeStore("native-durable-removal") { f ->
            val native = f.populated("Durable removal contacts",
                people("a", "b", "c") + ("g" to nativeGroupVcard("g", "Group G", listOf("a", "c"))))
            val g = f.groupId(native, "g")
            f.removeFromGroup(f.rawId(native, "c"), g)
            assertEquals(setOf("a"), f.members(native, g))
            assertEquals(setOf("a", "c"), f.cachedMembers(native, g))
            f.clearSlot(native)
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a"), f.members(native, f.groupId(native, "g")))
            assertTrue(f.liveUids(native).contains("c"))
            assertTrue(f.groupDirty(f.groupId(native, "g")))
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertFalse(f.serverContent("g").contains("urn:uuid:c"))
            assertTrue(f.serverContent("g").contains("urn:uuid:a"))
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a"), f.members(native, f.groupId(native, "g")))
        }
    }

    @Test
    fun contactsNativeStoreReplayNeverTurnsAPartlyAppliedServerMemberIntoALocalAddition() {
        withNativeStore("native-partly-applied") { f ->
            val native = f.populated("Partly applied contacts",
                people("a", "b", "c") + ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
            val h = f.groupId(native, "h")
            assertEquals(setOf("a"), f.members(native, h))
            assertEquals(setOf("a"), f.cachedMembers(native, h))
            // The prefix of an interrupted reconciliation against S0 = {a, b}: b's membership row was
            // inserted, its cached row was not, and S0 is still pending.
            f.insertMembershipAsSyncAdapter(native, f.rawId(native, "b"), h)
            f.stagePendingAsSyncAdapter(native, h, listOf("a", "b"))
            assertEquals(setOf("a", "b"), f.members(native, h))
            assertEquals(setOf("a"), f.cachedMembers(native, h))
            assertTrue(f.pendingMembers(h) != null)
            assertFalse(f.dirty(f.rawId(native, "b")))
            assertFalse(f.groupDirty(h))
            // Meanwhile the server list is S1 = {a}.
            f.changeRemote("h", nativeGroupVcard("h", "Group H", listOf("a")))
            f.recache()
            f.clearSlot(native)
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals("a partly applied server member is not kept as a local addition",
                setOf("a"), f.members(native, f.groupId(native, "h")))
            assertTrue(f.liveUids(native).contains("b"))
            assertFalse(f.groupDirty(f.groupId(native, "h")))
            assertEquals(emptyList<String>(), f.itemUploadRequests())
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(emptyList<String>(), f.itemUploadRequests())
            assertFalse(f.serverContent("h").contains("urn:uuid:b"))
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a"), f.members(native, f.groupId(native, "h")))
            assertFalse(f.serverContent("h").contains("urn:uuid:b"))
        }
    }

    @Test
    fun contactsNativeStoreReplayWithholdsAnUploadedGroupWhoseDirtyFlagWasNotCleared() {
        withNativeStore("native-uncleared-upload") { f ->
            val native = f.populated("Uncleared upload contacts",
                people("a", "b", "c") + ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
            val h = f.groupId(native, "h")
            f.keepDirtyWithoutETagAsSyncAdapter(native, h)
            // Setup guards: a server-known filename, no eTag, still dirty, members {a}.
            assertTrue(f.groupFileNameAndETag(h).first != null)
            assertEquals(null, f.groupFileNameAndETag(h).second)
            assertTrue(f.groupDirty(h))
            assertEquals(setOf("a"), f.members(native, h))
            // Meanwhile another device adds b on the server.
            f.changeRemote("h", nativeGroupVcard("h", "Group H", listOf("a", "b")))
            f.recache()
            f.clearSlot(native)
            f.fake.requests.clear()  // boundary: only the replay's requests count
            assertEquals(success, f.sync(native))
            assertTrue("a replay never uploads a server-known group before its server members are merged",
                f.serverContent("h").contains("urn:uuid:b"))
            assertEquals(setOf("a", "b"), f.members(native, f.groupId(native, "h")))
            assertTrue(f.groupDirty(f.groupId(native, "h")))
            assertTrue(f.slot(native)?.isNotEmpty() == true)
            // The next run uploads the merged list.
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertTrue(f.serverContent("h").contains("urn:uuid:a"))
            assertTrue(f.serverContent("h").contains("urn:uuid:b"))
            assertFalse(f.groupDirty(f.groupId(native, "h")))
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a", "b"), f.members(native, f.groupId(native, "h")))
        }
    }

    @Test
    fun contactsNativeStoreGenerationChangeBeforePreReconciliationStopsBeforeListing() {
        withNativeStore("native-generation-prefix") { f ->
            val native = f.populated("Generation prefix contacts",
                people("a", "b", "c") + ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
            val h = f.groupId(native, "h")
            // The prefix of an interrupted reconciliation against S0 = {a, b}: b's membership row was
            // inserted, its cached row was not, and S0 is still pending.
            f.insertMembershipAsSyncAdapter(native, f.rawId(native, "b"), h)
            f.stagePendingAsSyncAdapter(native, h, listOf("a", "b"))
            val s0 = requireNotNull(f.pendingMembers(h))
            // Setup guards.
            assertEquals(setOf("a", "b"), f.members(native, h))
            assertEquals(setOf("a"), f.cachedMembers(native, h))
            assertFalse(f.groupDirty(h))
            // Meanwhile the server list is S1 = {a}.
            f.changeRemote("h", nativeGroupVcard("h", "Group H", listOf("a")))
            f.recache()
            f.clearSlot(native)
            f.fake.requests.clear()  // boundary: only the measured run's requests count
            val outcome = f.syncWithMainGenerationReplacedAfterCapture(native)
            assertEquals("a run that cannot first finish the pending server list never lists the server",
                emptyList<String>(), f.itemListRequests())
            assertTrue("the pending server list S0 is kept for its own reconciliation",
                f.pendingMembers(h)?.contentEquals(s0) == true)
            assertEquals(emptyList<String>(), f.itemUploadRequests())
            assertTrue("the stopped run did not report success: $outcome", outcome != success)
            assertTrue(f.slot(native)?.isNotEmpty() != true)
            assertEquals(setOf("a", "b"), f.members(native, h))
            assertEquals(setOf("a"), f.cachedMembers(native, h))
            // The retry with the restored generation finishes S0 first, then takes S1.
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals("a partly applied server member is not kept as a local addition",
                setOf("a"), f.members(native, f.groupId(native, "h")))
            assertFalse(f.groupDirty(f.groupId(native, "h")))
            assertEquals(emptyList<String>(), f.itemUploadRequests())
            assertTrue(f.slot(native)?.isNotEmpty() == true)
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(emptyList<String>(), f.itemUploadRequests())
            assertFalse(f.serverContent("h").contains("urn:uuid:b"))
            f.recache()
            f.fake.requests.clear()
            assertEquals(success, f.sync(native))
            assertEquals(setOf("a"), f.members(native, f.groupId(native, "h")))
        }
    }

    @Test
    fun contactsNativeStoreReplayKeepsADirtyRowEditMadeDuringTheListing() = withNativeStore("native-dirty-row") { f ->
        val native = f.populated("Dirty row contacts", people("a", "b", "c", "d", "e", "f"))
        f.clearSlot(native)
        f.changeRemote("f", nativeVcard("f", "Person f renamed elsewhere"))
        f.recache()
        val hold = f.holdItemList()
        val run = f.syncInBackground(native)
        hold.awaitArrival()
        f.addPhone(f.rawId(native, "f"), "5550104")
        hold.release()
        assertEquals(success, f.join(run))
        assertTrue("a native edit made during the listing is kept",
            f.phones(f.rawId(native, "f")).contains("5550104"))
        assertTrue(f.dirty(f.rawId(native, "f")))
        assertEquals(success, f.sync(native))
        assertTrue(f.serverContent("f").contains("5550104"))
    }

    @Test
    fun contactsNativeStoreReplayKeepsAMembershipEditMadeDuringTheListing() = withNativeStore("native-membership") { f ->
        val native = f.populated("Membership contacts",
            people("a", "b", "c", "d") + ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
        f.clearSlot(native)
        f.changeRemote("h", nativeGroupVcard("h", "Group H renamed", listOf("a")))
        f.recache()
        val hold = f.holdItemList()
        val run = f.syncInBackground(native)
        hold.awaitArrival()
        val group = f.groupId(native, "h")
        assertFalse(f.members(native, group).contains("c"))
        f.addToGroup(f.rawId(native, "c"), group)
        hold.release()
        assertEquals(success, f.join(run))
        assertTrue("a membership edit made during the listing is kept",
            f.members(native, f.groupId(native, "h")).contains("c"))
        // Next run: the cursor equals the cached collection token, so the fetch is skipped.
        assertEquals(success, f.sync(native))
        assertTrue(f.members(native, f.groupId(native, "h")).contains("c"))
        assertTrue(f.serverContent("h").contains("urn:uuid:c"))
        // A refreshed collection makes the fetch return the uploaded revisions.
        f.recache()
        assertEquals(success, f.sync(native))
        assertTrue(f.members(native, f.groupId(native, "h")).contains("c"))
    }

    @Test
    fun contactsNativeStoreReadOnlyReplayKeepsServerGroupContentAndMembership() = withNativeStore("native-read-only") { f ->
        val native = f.populated("Shared contacts",
            people("a", "b", "c", "d") + ("h" to nativeGroupVcard("h", "Group H", listOf("a"))))
        f.changeRemote("h", nativeGroupVcard("h", "Group H renamed", listOf("a")))
        f.fake.setAccessLevel(f.colUid, 0L)
        f.recache()
        LocalAddressBook(f.context, native, null).readOnly = true
        f.clearSlot(native)
        val hold = f.holdItemList()
        f.fake.requests.clear()  // boundary: only the measured run's requests count
        val run = f.syncInBackground(native)
        hold.awaitArrival()
        val group = f.groupId(native, "h")
        f.retitleGroup(group, "Local title")
        f.addToGroup(f.rawId(native, "c"), group)
        hold.release()
        assertEquals(success, f.join(run))
        assertEquals("Group H renamed", f.groupTitle(f.groupId(native, "h")))
        assertEquals(setOf("a"), f.members(native, f.groupId(native, "h")))
        assertEquals(emptyList<String>(), f.itemUploadRequests())
        f.fake.requests.clear()  // a fresh boundary for the second measured run
        assertEquals(success, f.sync(native))
        assertEquals("Group H renamed", f.groupTitle(f.groupId(native, "h")))
        assertEquals(setOf("a"), f.members(native, f.groupId(native, "h")))
        assertEquals(emptyList<String>(), f.itemUploadRequests())
    }

    @Test
    fun contactsNativeStoreReplayNeverCertifiesAReplacedNativeGeneration() = withNativeStore("native-replaced") { f ->
        val first = f.populated("Replaced contacts", people("a", "b", "c", "d"))
        f.clearSlot(first)
        f.upload(people("x"))
        f.recache()
        val hold = f.holdItemList()
        val run = f.syncInBackground(first)
        hold.awaitArrival()
        f.removeNative(first)
        val replacement = f.createNative()
        assertEquals(first, replacement)
        hold.release()
        f.join(run)  // the old run's own outcome is the inherited race, not asserted here
        f.hardDeleteIfPresent(replacement, "a")
        f.hardDeleteIfPresent(replacement, "x")
        assertEquals(success, f.sync(replacement))
        assertEquals("a same-name replacement is refilled, never certified by the old run",
            listOf("a", "b", "c", "d", "x"), f.liveUids(replacement))
    }

    @Test
    fun contactsNativeStoreReplayNeverCertifiesAReplacedMainGeneration() = withNativeStore("native-main-replaced") { f ->
        val native = f.populated("Main replaced contacts", people("a", "b", "c", "d"))
        f.clearSlot(native)
        f.upload(people("x"))
        f.recache()
        val hold = f.holdItemList()
        val run = f.syncInBackground(native)
        hold.awaitArrival()
        val owner = requireNotNull(f.main)
        check(AccountSettings.writeVerified(f.manager, owner, AccountSettings.KEY_CREATION_ID, "${f.generation}-replaced"))
        hold.release()
        f.join(run)
        check(AccountSettings.writeVerified(f.manager, owner, AccountSettings.KEY_CREATION_ID, f.generation))
        f.hardDeleteIfPresent(native, "a")
        f.hardDeleteIfPresent(native, "x")
        assertEquals(success, f.sync(native))
        assertEquals("a run that saw another main generation certifies nothing",
            listOf("a", "b", "c", "d", "x"), f.liveUids(native))
    }

    @Test
    fun contactsNativeStoreMarkerWriteFailureIsADatabaseErrorNotSuccess() = withNativeStore("native-marker-write") { f ->
        val first = f.populated("Marker write contacts", people("a", "b", "c", "d"))
        f.removeNative(first)
        val recreated = f.createNative()
        f.upload(people("e"))
        f.recache()
        ContactsSyncManager.installSyncStateFaultForTest { write -> if (write) android.os.RemoteException("marker write") else null }
        val result = SyncResult()
        assertEquals("a completion marker that could not be stored is a failure, not a success",
            SyncManager.ProviderOutcome.FAILURE, f.sync(recreated, result))
        assertTrue(result.databaseError)
        ContactsSyncManager.installSyncStateFaultForTest(null)
        assertEquals(success, f.sync(recreated))
        assertEquals(listOf("a", "b", "c", "d", "e"), f.liveUids(recreated))
        f.recache()
        f.fake.requests.clear()
        assertEquals(success, f.sync(recreated))
        assertEquals(emptyList<String>(), f.itemListRequests())
    }

    @Test
    fun contactsNativeStoreMarkerReadFailureIsADatabaseErrorBeforeAnyUploadOrListing() = withNativeStore("native-marker-read") { f ->
        val native = f.populated("Marker read contacts", people("a", "b", "c", "d", "e"))
        f.clearSlot(native)
        f.addPhone(f.rawId(native, "c"), "5550106")
        f.changeRemote("e", nativeVcard("e", "Person e renamed elsewhere"))
        f.recache()
        ContactsSyncManager.installSyncStateFaultForTest { write -> if (!write) android.os.RemoteException("marker read") else null }
        f.fake.requests.clear()  // boundary after every setup call and the hook
        val result = SyncResult()
        assertEquals("a completion marker that could not be read fails the run",
            SyncManager.ProviderOutcome.FAILURE, f.sync(native, result))
        assertTrue(result.databaseError)
        assertEquals(emptyList<String>(), f.itemUploadRequests())
        assertEquals(emptyList<String>(), f.itemListRequests())
        assertTrue(f.dirty(f.rawId(native, "c")))
        assertTrue(f.phones(f.rawId(native, "c")).contains("5550106"))
    }
}
