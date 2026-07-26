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
import android.view.KeyEvent
import android.view.View
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.lifecycle.Lifecycle
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.view.menu.MenuBuilder
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class SiblingRoutesRuntimeTest {
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

    private fun grantDashboardPermissions(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        listOf(
            Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR,
            Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
        ).forEach { permission ->
            InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("pm grant ${context.packageName} $permission").close()
        }
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
    fun importRecreationAndBackCancelReturnToItsCaller() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = addAccount(manager, "import-cancel", "import-cancel-generation")
        val info = CollectionInfo().apply {
            uid = "collection-uid"
            enumType = CollectionInfo.Type.CALENDAR
        }

        try {
            ActivityScenario.launch<ImportActivity>(ImportActivity.newIntent(context, account, "import-cancel-generation", info)).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertTrue(activity.onKeyDown(KeyEvent.KEYCODE_BACK, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK)))
                }
                waitUntil("import cancel return") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals(Lifecycle.State.DESTROYED, scenario.state)
            }
        } finally {
            removeAccountAndWait(manager, account)
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
        lateinit var clipboard: ClipboardManager
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("sentinel", "sentinel"))
        }
        val reads = mutableListOf<Pair<Account, String>>()
        val previousBootstrap = App.postLoginBootstrapSucceeded
        App.postLoginBootstrapSucceeded = true
        grantDashboardPermissions(context)
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
                waitUntil("rendered dashboard") {
                    var rendered = false
                    scenario.onActivity { rendered = it.findViewById<TextView>(R.id.dashboard_account_identity).text.toString() == account.name }
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
                scenario.recreate()
                waitUntil("retained fingerprint dialog") {
                    var shown = false
                    scenario.onActivity { activity ->
                        shown = (activity.supportFragmentManager.findFragmentByTag(FingerprintDialogFragment.TAG)
                            as? FingerprintDialogFragment)?.dialog?.isShowing == true
                    }
                    shown
                }
                scenario.onActivity { activity ->
                    val fragment = activity.supportFragmentManager
                        .findFragmentByTag(FingerprintDialogFragment.TAG) as FingerprintDialogFragment
                    fragment.dialog!!.cancel()
                    assertEquals(account.name, activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
                }
                assertEquals(listOf(account to "fingerprint-dashboard-generation"), reads)
                scenario.onActivity { activity ->
                    assertEquals("sentinel", clipboard.primaryClip!!.getItemAt(0).text)
                    assertEquals(account.name, activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
                }
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
}
