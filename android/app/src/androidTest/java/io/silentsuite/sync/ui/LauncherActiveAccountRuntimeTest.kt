package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.setup.LoginActivity
import io.silentsuite.sync.ui.setup.PostLoginSetupActivity
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.ui.setup.PostLoginStartupChecks
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Issue #898: the launcher route, which names no account, after the saved active account was removed
 * outside the app. Rows are synthetic (no session, no server); removal goes through AccountManager.
 */
@RunWith(AndroidJUnit4::class)
class LauncherActiveAccountRuntimeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context = instrumentation.targetContext
    private val manager = AccountManager.get(context)

    @Test fun launcherAfterExternalRemovalOpensSoleSiblingAndPersistsItsExactGeneration() = withHarness { rows ->
        val saved = rows.add("sole-saved")
        val sibling = rows.add("sole-sibling")
        saveExact(saved)
        removeAccountAndWait(saved.account)
        assertOnlyRows(sibling.account)

        launchFromLauncher { scenario, login, setup ->
            assertEquals("Launcher routed to sign-in instead of the sole remaining account", 0, login.hits)
            assertEquals("A COMPLETE sibling must not be sent to setup", 0, setup.hits)
            assertEquals(Lifecycle.State.RESUMED, scenario.state)
            scenario.onActivity { activity ->
                assertEquals(sibling.account.name, activity.title.toString())
                assertEquals(sibling.account.name,
                    activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
            }
        }
        assertSaved("The sole sibling's original generation must be persisted", sibling.account.name, sibling.generation)
        assertEquals(sibling.generation, manager.getUserData(sibling.account, AccountSettings.KEY_CREATION_ID))
    }

    @Test fun launcherAfterExternalRemovalToRecoverySiblingRoutesToSetupNotDashboard() = withHarness { rows ->
        val saved = rows.add("recovery-saved")
        val sibling = rows.add("recovery-sibling", state = PostLoginSetupState.RECOVERY_REQUIRED)
        saveExact(saved)
        removeAccountAndWait(saved.account)
        assertOnlyRows(sibling.account)

        launchFromLauncher { scenario, login, setup ->
            assertEquals("Launcher routed to sign-in instead of the sole remaining account", 0, login.hits)
            assertEquals("A recovery sibling must be routed to setup", 1, setup.hits)
            assertEquals("A recovery sibling must never open the dashboard", Lifecycle.State.DESTROYED, scenario.state)
        }
        assertSaved("The recovery sibling's original generation must be persisted", sibling.account.name, sibling.generation)
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, AccountSettings.setupState(manager, sibling.account, true))
    }

    @Test fun launcherFallbackRejectsSiblingReplacedAfterCommit() = withHarness { rows ->
        val saved = rows.add("race-saved")
        val sibling = rows.add("race-sibling")
        saveExact(saved)
        removeAccountAndWait(saved.account)
        assertOnlyRows(sibling.account)
        val replacementGeneration = "race-sibling-replacement"
        var hookCalls = 0
        ActiveAccountManager.afterExactSetCommitForTest = {
            hookCalls += 1
            if (hookCalls == 1) check(AccountSettings.writeVerified(
                manager, sibling.account, AccountSettings.KEY_CREATION_ID, replacementGeneration))
        }

        launchFromLauncher { scenario, login, _ ->
            assertEquals("The fallback commit was not witnessed by afterExactSetCommitForTest", 1, hookCalls)
            assertEquals("A sibling replaced after the commit must not open a dashboard", 1, login.hits)
            assertEquals(Lifecycle.State.DESTROYED, scenario.state)
        }
        assertNotEquals("The replacement generation must never be persisted",
            replacementGeneration, savedCreationId())
        assertSaved("The written sibling identity must be cleared after the replacement", null, null)
        assertEquals(replacementGeneration, manager.getUserData(sibling.account, AccountSettings.KEY_CREATION_ID))
    }

    @Test fun launcherAfterExternalRemovalWithTwoSiblingsSelectsNothing() = withHarness { rows ->
        val saved = rows.add("ambiguous-saved")
        val first = rows.add("ambiguous-first")
        val second = rows.add("ambiguous-second")
        saveExact(saved)
        removeAccountAndWait(saved.account)
        assertOnlyRows(first.account, second.account)

        launchFromLauncher { scenario, login, setup ->
            assertEquals("Two eligible siblings must not be chosen between", 1, login.hits)
            assertEquals(0, setup.hits)
            assertEquals(Lifecycle.State.DESTROYED, scenario.state)
        }
        assertSaved("An ambiguous launch must leave the saved identity unchanged", saved.account.name, saved.generation)
    }

    @Test fun launcherRefusesSameNameReplacementAndGenerationlessSameNameRow() = withHarness { rows ->
        // A same-name row with another generation is the only candidate: it must never be adopted.
        val replaced = rows.add("same-name")
        saveExact(replaced)
        removeAccountAndWait(replaced.account)
        val replacement = rows.add("same-name", generation = "same-name-replacement", name = replaced.account.name)
        assertOnlyRows(replacement.account)
        launchFromLauncher { scenario, login, setup ->
            assertEquals("A same-name replacement generation must not be adopted", 1, login.hits)
            assertEquals(0, setup.hits)
            assertEquals(Lifecycle.State.DESTROYED, scenario.state)
        }
        assertSaved("A same-name replacement must leave the saved identity unchanged",
            replaced.account.name, replaced.generation)
        removeAccountAndWait(replacement.account)

        // A same-name row without a generation still counts as present, beside one eligible sibling.
        val generationless = rows.add("same-name", generation = null, state = null, name = replaced.account.name)
        val sibling = rows.add("same-name-sibling")
        assertOnlyRows(generationless.account, sibling.account)
        assertNull(manager.getUserData(generationless.account, AccountSettings.KEY_CREATION_ID))
        launchFromLauncher { scenario, login, setup ->
            assertEquals("A generationless same-name row must block the sibling fallback", 1, login.hits)
            assertEquals(0, setup.hits)
            assertEquals(Lifecycle.State.DESTROYED, scenario.state)
        }
        assertSaved("A generationless same-name row must leave the saved identity unchanged",
            replaced.account.name, replaced.generation)
    }

    @Test fun explicitRouteToRemovedAccountNeverFallsBackToSibling() = withHarness { rows ->
        val saved = rows.add("explicit-saved")
        val sibling = rows.add("explicit-sibling")
        saveExact(saved)
        removeAccountAndWait(saved.account)
        assertOnlyRows(sibling.account)

        withMonitors { login, setup ->
            ActivityScenario.launch<AccountActivity>(
                AccountActivity.newIntent(context, saved.account, saved.generation)
            ).use { scenario ->
                instrumentation.waitForIdleSync()
                assertEquals("A stale explicit route must not open any dashboard", Lifecycle.State.DESTROYED, scenario.state)
                assertEquals(0, setup.hits)
                assertTrue(login.hits <= 1)
            }
        }
        assertSaved("A stale explicit route must leave the saved identity unchanged", saved.account.name, saved.generation)
    }

    @Test fun existingInstallBootstrapThenLauncherAfterExternalRemovalOpensSoleSibling() = withHarness { rows ->
        val migrationPreferences = context.getSharedPreferences("post_login_setup_migration", Context.MODE_PRIVATE)
        val previousMarker = migrationPreferences.takeIf { it.contains("version") }?.getInt("version", 0)
        val registryPreferences = context.getSharedPreferences("account_creation_registry", Context.MODE_PRIVATE)
        val previousRegistry = registryPreferences.getString("rows", null)
        try {
            // State an earlier build leaves behind: two finished generations, the first one saved.
            val saved = rows.add("existing-saved")
            val sibling = rows.add("existing-sibling")
            saveExact(saved)
            removeAccountAndWait(saved.account)
            assertOnlyRows(sibling.account)

            PostLoginStartupChecks.resetForTest()
            assertTrue(PostLoginStartupChecks.runAtLaunch(context))
            assertEquals(PostLoginStartupOutcome.SUCCEEDED, PostLoginStartupChecks.snapshot().outcome)
            assertTrue(App.postLoginBootstrapSucceeded)
            assertSaved("Startup bootstrap leaves the stale saved identity untouched", saved.account.name, saved.generation)
            assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, sibling.account, true))
            assertEquals(sibling.generation, manager.getUserData(sibling.account, AccountSettings.KEY_CREATION_ID))

            launchFromLauncher { scenario, login, setup ->
                assertEquals("Launcher routed to sign-in instead of the sole remaining account", 0, login.hits)
                assertEquals(0, setup.hits)
                assertEquals(Lifecycle.State.RESUMED, scenario.state)
                scenario.onActivity { activity -> assertEquals(sibling.account.name, activity.title.toString()) }
            }
            assertSaved("The sole sibling's original generation must be persisted", sibling.account.name, sibling.generation)
        } finally {
            val markerEditor = migrationPreferences.edit()
            if (previousMarker == null) markerEditor.remove("version") else markerEditor.putInt("version", previousMarker)
            check(markerEditor.commit())
            val registryEditor = registryPreferences.edit()
            if (previousRegistry == null) registryEditor.remove("rows") else registryEditor.putString("rows", previousRegistry)
            check(registryEditor.commit())
            PostLoginStartupChecks.resetForTest()
        }
    }

    private class Row(val account: Account, val generation: String?)

    private inner class Rows : AutoCloseable {
        private val created = mutableListOf<Account>()

        fun add(
            label: String,
            generation: String? = "$label-generation",
            state: PostLoginSetupState? = PostLoginSetupState.COMPLETE,
            name: String = "$label-${System.nanoTime()}@example.invalid",
        ): Row {
            val account = Account(name, App.accountType)
            check(manager.addAccountExplicitly(account, null, null))
            created += account
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_LIMITED_INTEGRATIONS, "true"))
            if (generation != null)
                check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
            if (state != null) check(AccountSettings.writeSetupState(manager, account, state))
            return Row(account, generation)
        }

        override fun close() {
            var failure: Throwable? = null
            for (account in created.distinct().asReversed()) {
                try { removeAccountAndWait(account) } catch (t: Throwable) { if (failure == null) failure = t }
            }
            ActiveAccountManager.clearActiveAccount(context)
            failure?.let { throw it }
        }
    }

    /** Every global this class sets is restored in finally, whether or not the assertions held. */
    private fun withHarness(block: (Rows) -> Unit) {
        val previousBootstrap = App.postLoginBootstrapSucceeded
        App.postLoginBootstrapSucceeded = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            instrumentation.uiAutomation
                .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.POST_NOTIFICATIONS}").close()
        AccountActivity.AccountInfoViewModel.accountLoaderOverride = { _, _, _ -> AccountActivity.AccountInfo() }
        AccountActivity.billingStatusOverride = { _, _, _ ->
            io.silentsuite.sync.billing.BillingManager.SubscriptionStatus("active", null, null, null, null)
        }
        AccountActivity.syncRequestOverride = { _, _ -> }
        AccountActivity.syncActiveOverride = { false }
        AccountActivity.fingerprintLoaderOverride = { _, _, _ -> null }
        AccountActivity.permissionRequestOverride = { }
        val rows = Rows()
        try {
            block(rows)
        } finally {
            ActiveAccountManager.afterExactSetCommitForTest = null
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = null
            AccountActivity.billingStatusOverride = null
            AccountActivity.syncRequestOverride = null
            AccountActivity.syncActiveOverride = null
            AccountActivity.fingerprintLoaderOverride = null
            AccountActivity.permissionRequestOverride = null
            App.postLoginBootstrapSucceeded = previousBootstrap
            rows.close()
        }
    }

    /** Blocking monitors: a rerouted sign-in or setup start is counted and never shown. */
    private fun withMonitors(block: (Instrumentation.ActivityMonitor, Instrumentation.ActivityMonitor) -> Unit) {
        val login = instrumentation.addMonitor(LoginActivity::class.java.name, null, true)
        val setup = instrumentation.addMonitor(PostLoginSetupActivity::class.java.name, null, true)
        try {
            block(login, setup)
        } finally {
            instrumentation.removeMonitor(setup)
            instrumentation.removeMonitor(login)
        }
    }

    private fun launchFromLauncher(
        block: (ActivityScenario<AccountActivity>, Instrumentation.ActivityMonitor, Instrumentation.ActivityMonitor) -> Unit,
    ) {
        val intent = requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
        assertEquals(AccountActivity::class.java.name, intent.component?.className)
        assertEquals(Intent.ACTION_MAIN, intent.action)
        assertNull("The launcher intent names no account", intent.getParcelableExtra<Account>(AccountActivity.EXTRA_ACCOUNT))
        assertNull("The launcher intent names no generation", intent.getStringExtra(AccountActivity.EXTRA_CREATION_ID))
        withMonitors { login, setup ->
            ActivityScenario.launch<AccountActivity>(intent).use { scenario ->
                instrumentation.waitForIdleSync()
                block(scenario, login, setup)
            }
        }
    }

    private fun saveExact(row: Row) {
        assertTrue(ActiveAccountManager.setActiveAccount(
            context, ExactAccountIdentity(row.account.type, row.account.name, requireNotNull(row.generation))))
        assertSaved("Precondition: the exact identity is saved", row.account.name, row.generation)
    }

    private fun activePreferences() = context.getSharedPreferences("active_account", Context.MODE_PRIVATE)

    private fun savedCreationId(): String? = activePreferences().getString("creation_id", null)

    private fun assertSaved(message: String, name: String?, generation: String?) {
        assertEquals(message, name to generation,
            activePreferences().getString("account_name", null) to savedCreationId())
    }

    private fun assertOnlyRows(vararg expected: Account) {
        assertEquals("Precondition: no other SilentSuite rows may exist on the device",
            expected.toSet(), manager.getAccountsByType(App.accountType).toSet())
    }

    private fun removeAccountAndWait(account: Account) {
        if (account !in manager.getAccountsByType(account.type)) return
        val removed = CountDownLatch(1)
        AndroidCompat.removeAccount(manager, account) { removed.countDown() }
        assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
        assertFalse("account row remained after confirmed removal", account in manager.getAccountsByType(account.type))
    }
}
