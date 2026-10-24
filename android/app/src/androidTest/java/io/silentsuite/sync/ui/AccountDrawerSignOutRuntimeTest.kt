package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.DialogInterface
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import androidx.fragment.app.DialogFragment
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import androidx.lifecycle.Lifecycle
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.syncadapter.AccountAuthenticatorService
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AccountDrawerSignOutRuntimeTest {
    private fun waitUntil(description: String, timeoutMillis: Long = 10_000, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            SystemClock.sleep(25)
        }
        assertTrue("Timed out waiting for $description", predicate())
    }

    @Test fun oneAccountSwitcherExposesAddRowAndCurrentSemanticsAfterRecreation() {
        val fixture = Fixture("switcher")
        fixture.use { account ->
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(fixture.context, account)).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity ->
                    activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                        .openDrawer(GravityCompat.START, false)
                    val header = activity.findViewById<View>(R.id.nav_account_header)
                    header.performClick()
                    val add = activity.findViewById<View>(R.id.nav_add_account_row)
                    val row = activity.findViewById<View>(AccountActivity.accountRowViewId(
                        ExactAccountIdentity(account.type, account.name, fixture.creationId)))
                    assertTrue(add.isShown)
                    assertTrue(add.isClickable)
                    assertTrue(row.isShown)
                    assertTrue(row.isSelected)
                    assertEquals(activity.getString(R.string.account_switcher_current),
                        ViewCompat.getStateDescription(row)?.toString())
                    assertEquals(activity.getString(R.string.account_switcher_expanded),
                        ViewCompat.getStateDescription(header)?.toString())
                }
            }
        }
    }

    @Test fun replacementBeforeAccountRowClickDoesNotAdoptReplacementGeneration() {
        val current = Fixture("switch-current")
        val candidate = Fixture("switch-candidate")
        try {
            val currentIdentity = ExactAccountIdentity(
                current.account.type,
                current.account.name,
                current.creationId,
            )
            assertTrue(ActiveAccountManager.setActiveAccount(current.context, currentIdentity))
            val capturedIdentity = ExactAccountIdentity(
                candidate.account.type,
                candidate.account.name,
                candidate.creationId,
            )
            ActivityScenario.launch<AccountActivity>(
                AccountActivity.newIntent(current.context, current.account, current.creationId)
            ).use { scenario ->
                scenario.onActivity { activity ->
                    activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                        .openDrawer(GravityCompat.START, false)
                    activity.findViewById<View>(R.id.nav_account_header).performClick()
                    assertTrue(activity.findViewById<View>(
                        AccountActivity.accountRowViewId(capturedIdentity)
                    ).isShown)
                }

                removeAccountAndWait(candidate.manager, candidate.account)
                val replacementGeneration = "switch-candidate-replacement"
                val replacementData = Bundle().apply {
                    putString(AccountSettings.KEY_CREATION_ID, replacementGeneration)
                }
                assertTrue(candidate.manager.addAccountExplicitly(
                    candidate.account,
                    null,
                    replacementData,
                ))

                scenario.onActivity { activity ->
                    activity.findViewById<View>(
                        AccountActivity.accountRowViewId(capturedIdentity)
                    ).performClick()
                    assertFalse(activity.isFinishing)
                    assertEquals(current.account, ActiveAccountManager.getActiveAccount(current.context))
                    assertEquals(
                        current.creationId,
                        activity.intent.getStringExtra(AccountActivity.EXTRA_CREATION_ID),
                    )
                    assertEquals(
                        replacementGeneration,
                        candidate.manager.getUserData(
                            candidate.account,
                            AccountSettings.KEY_CREATION_ID,
                        ),
                    )
                }
            }
            postCommitGenerationRaceFailsClosedAndClearsOnlyTheWrittenIdentity(
                candidate,
                "switch-candidate-replacement",
            )
        } finally {
            ActiveAccountManager.afterExactSetCommitForTest = null
            candidate.close()
            current.close()
        }
    }

    private fun postCommitGenerationRaceFailsClosedAndClearsOnlyTheWrittenIdentity(
        candidate: Fixture,
        expectedGeneration: String,
    ) {
        val racedGeneration = "switch-candidate-raced-after-commit"
        ActiveAccountManager.afterExactSetCommitForTest = {
            check(AccountSettings.writeVerified(
                candidate.manager,
                candidate.account,
                AccountSettings.KEY_CREATION_ID,
                racedGeneration,
            ))
        }
        val selected = ActiveAccountManager.setActiveAccount(
            candidate.context,
            ExactAccountIdentity(
                candidate.account.type,
                candidate.account.name,
                expectedGeneration,
            ),
        )
        ActiveAccountManager.afterExactSetCommitForTest = null

        assertFalse(selected)
        assertNull(ActiveAccountManager.getActiveAccount(candidate.context))
        assertEquals(
            racedGeneration,
            candidate.manager.getUserData(
                candidate.account,
                AccountSettings.KEY_CREATION_ID,
            ),
        )
    }

    @Test fun systemBackClosesDrawerWithoutFinishing() {
        val fixture = Fixture("system-back-drawer")
        fixture.use { account ->
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(fixture.context, account)).use { scenario ->
                scenario.onActivity { activity ->
                    activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                        .openDrawer(GravityCompat.START, false)
                    assertTrue(activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                        .isDrawerOpen(GravityCompat.START))
                }
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
                waitUntil("drawer to close after system Back") {
                    var closed = false
                    scenario.onActivity { activity ->
                        closed = !activity.isFinishing && !activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                            .isDrawerOpen(GravityCompat.START)
                    }
                    closed
                }
                assertEquals(Lifecycle.State.RESUMED, scenario.state)
            }
        }
    }

    @Test fun delayedRemovalFailureSurvivesRecreationAndDuplicateTapStartsOnce() {
        val fixture = Fixture("failure")
        val fake = DelayedFailureSeams(fixture.account)
        CurrentAccountSignOutViewModel.seamsFactory = { _, exact, generation ->
            assertEquals(fixture.account, exact)
            assertEquals(fixture.creationId, generation)
            fake
        }
        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(fixture.context, fixture.account)).use { scenario ->
                scenario.onActivity { activity ->
                    val model = androidx.lifecycle.ViewModelProvider(activity)[CurrentAccountSignOutViewModel::class.java]
                    model.begin()
                    model.begin()
                }
                // The count, and the clear with the removal request, run off the main thread.
                settle(scenario)
                assertEquals(1, fake.removeCalls)
                scenario.recreate()
                fake.callback!!(false)
                // The answer is taken on the main thread, and the store is reopened off it before the failure shows.
                settle(scenario)
                scenario.onActivity { activity ->
                    assertTrue(activity.findViewById<com.google.android.material.navigation.NavigationView>(R.id.nav_view)
                        .menu.findItem(R.id.nav_logout).isEnabled)
                    assertEquals(0, fake.destructiveCleanupCalls)
                }
            }
        } finally {
            CurrentAccountSignOutViewModel.seamsFactory = null
            fixture.close()
        }
    }

    @Test fun actualTwoAccountSignOutRemovesExactMainAndChildAndActivatesSibling() {
        val target = Fixture("actual-target")
        val sibling = Fixture("actual-sibling")
        val child = Account("child-${System.nanoTime()}@example.invalid", App.addressBookAccountType)
        check(target.manager.addAccountExplicitly(
            child,
            null,
            LocalAddressBook.initialUserData(target.account, SyncStatusStore(target.context).identity(target.account), "https://example.invalid/address-book"),
        ))
        try {
            assertTrue(ActiveAccountManager.setActiveAccount(target.context, target.account))
            val statusStore = SyncStatusStore(target.context)
            assertTrue(statusStore.recordSuccess(target.account, SyncStatusStore.Service.CALENDAR, 123L))
            assertEquals(123L,
                statusStore.status(target.account, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
            val expectedReplacement = target.manager.getAccountsByType(App.accountType).mapNotNull { candidate ->
                target.manager.getUserData(candidate, AccountSettings.KEY_CREATION_ID)?.takeIf(String::isNotBlank)?.let {
                    ExactAccountIdentity(candidate.type, candidate.name, it)
                }
            }.let(AccountSwitcherPolicy::ordered).first { it != ExactAccountIdentity(
                target.account.type, target.account.name, target.creationId) }
            val completed = CountDownLatch(1)
            var finalState: CurrentAccountSignOutState? = null
            val coordinator = CurrentAccountSignOutCoordinator(
                AndroidCurrentAccountSignOut(target.context, target.account, target.creationId)
            ) { state ->
                if (state is CurrentAccountSignOutState.Complete) {
                    finalState = state
                    completed.countDown()
                }
            }
            coordinator.begin()
            assertTrue("sign-out did not complete", completed.await(15, TimeUnit.SECONDS))
            assertEquals(expectedReplacement, (finalState as CurrentAccountSignOutState.Complete).replacement)
            assertFalse(target.account in target.manager.getAccountsByType(target.account.type))
            assertFalse(child in target.manager.getAccountsByType(child.type))
            // Recreate the same exact generation temporarily. Any uncleared status would now be
            // visible again because SyncStatusStore keys include this creation ID.
            assertTrue(target.manager.addAccountExplicitly(target.account, null, null))
            assertTrue(AccountSettings.writeVerified(target.manager, target.account,
                AccountSettings.KEY_CREATION_ID, target.creationId))
            assertEquals(SyncStatusStore.Status(),
                statusStore.status(target.account, SyncStatusStore.Service.CALENDAR))
            assertEquals(
                Account(expectedReplacement.name, expectedReplacement.type),
                ActiveAccountManager.getActiveAccount(target.context),
            )
        } finally {
            removeAccountAndWait(target.manager, child)
            sibling.close()
            target.close()
        }
    }

    @Test fun cleanupSweepKeepsUnreadableOwnerChildAndDeletesOnlyOrphans() {
        val sibling = Fixture("sweep-sibling")
        val departed = Fixture("sweep-departed")
        val statusStore = SyncStatusStore(sibling.context)
        val owned = Account("sweep-owned-${System.nanoTime()}@example.invalid", App.addressBookAccountType)
        val unreadable = Account("sweep-unreadable-${System.nanoTime()}@example.invalid", App.addressBookAccountType)
        val orphan = Account("sweep-orphan-${System.nanoTime()}@example.invalid", App.addressBookAccountType)
        try {
            check(sibling.manager.addAccountExplicitly(owned, null,
                LocalAddressBook.initialUserData(sibling.account, statusStore.identity(sibling.account), "https://example.invalid/owned")))
            // The platform still enumerates this row but its owner metadata is unreadable: exactly
            // what the sweep observes when a sign-out removes a child between enumeration and read.
            check(sibling.manager.addAccountExplicitly(unreadable, null, null))
            check(sibling.manager.addAccountExplicitly(orphan, null,
                LocalAddressBook.initialUserData(departed.account, statusStore.identity(departed.account), "https://example.invalid/orphan")))
            removeAccountAndWait(departed.manager, departed.account)
            assertNull(LocalAddressBook(sibling.context, unreadable, null).mainAccountOrNull)

            AccountAuthenticatorService.cleanupAccounts(sibling.context)

            waitUntil("orphaned child removal") { orphan !in sibling.manager.getAccountsByType(orphan.type) }
            assertTrue("sibling-owned child was removed", owned in sibling.manager.getAccountsByType(owned.type))
            assertTrue("unreadable-owner child was removed", unreadable in sibling.manager.getAccountsByType(unreadable.type))
            assertTrue("sibling main was removed", sibling.account in sibling.manager.getAccountsByType(sibling.account.type))
        } finally {
            removeAccountAndWait(sibling.manager, owned)
            removeAccountAndWait(sibling.manager, unreadable)
            removeAccountAndWait(sibling.manager, orphan)
            departed.close()
            sibling.close()
        }
    }

    @Test fun deleteAfterChildRowVanishedDoesNotThrowAndLeavesSiblingRowsIntact() {
        val sibling = Fixture("vanish-sibling")
        val departed = Fixture("vanish-departed")
        val statusStore = SyncStatusStore(sibling.context)
        val siblingChild = Account("vanish-sibling-child-${System.nanoTime()}@example.invalid", App.addressBookAccountType)
        val vanished = Account("vanish-child-${System.nanoTime()}@example.invalid", App.addressBookAccountType)
        try {
            check(sibling.manager.addAccountExplicitly(siblingChild, null,
                LocalAddressBook.initialUserData(sibling.account, statusStore.identity(sibling.account), "https://example.invalid/sibling-child")))
            check(sibling.manager.addAccountExplicitly(vanished, null,
                LocalAddressBook.initialUserData(departed.account, statusStore.identity(departed.account), "https://example.invalid/vanished")))
            val addressBook = LocalAddressBook(sibling.context, vanished, null)
            assertEquals(departed.account, addressBook.mainAccount)
            val siblingStatusBefore = statusStore.status(sibling.account, SyncStatusStore.Service.CONTACTS)
            // The sweep decided to delete this orphan, but a concurrent sign-out removed the row first.
            removeAccountAndWait(sibling.manager, vanished)
            removeAccountAndWait(departed.manager, departed.account)
            assertNull(addressBook.mainAccountOrNull)

            addressBook.delete()

            assertFalse(vanished in sibling.manager.getAccountsByType(vanished.type))
            assertTrue("sibling child was removed", siblingChild in sibling.manager.getAccountsByType(siblingChild.type))
            assertTrue("sibling main was removed", sibling.account in sibling.manager.getAccountsByType(sibling.account.type))
            assertEquals(siblingStatusBefore, statusStore.status(sibling.account, SyncStatusStore.Service.CONTACTS))
        } finally {
            removeAccountAndWait(sibling.manager, siblingChild)
            removeAccountAndWait(sibling.manager, vanished)
            departed.close()
            sibling.close()
        }
    }

    @Test fun adapterRefusesToRemoveSameNameReplacementGeneration() {
        val fixture = Fixture("replacement")
        var adapter: AndroidCurrentAccountSignOut? = null
        try {
            val oldIdentity = ExactAccountIdentity(fixture.account.type, fixture.account.name, fixture.creationId)
            val retainedAdapter = AndroidCurrentAccountSignOut(fixture.context, fixture.account, fixture.creationId)
            adapter = retainedAdapter
            removeAccountAndWait(fixture.manager, fixture.account)
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            val replacementGeneration = "replacement-successor-generation"
            assertNotEquals(fixture.creationId, replacementGeneration)
            val replacementData = Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, replacementGeneration)
            }
            assertTrue(fixture.manager.addAccountExplicitly(fixture.account, null, replacementData))
            val replacementRow = fixture.manager.getAccountsByType(fixture.account.type)
                .single { it.name == fixture.account.name }
            assertEquals(replacementGeneration,
                fixture.manager.getUserData(replacementRow, AccountSettings.KEY_CREATION_ID))

            waitUntil("replacement generation visibility") {
                retainedAdapter.mainGenerationAbsent(oldIdentity)
            }
            val callbackReceived = CountDownLatch(1)
            var callback: Boolean? = null
            retainedAdapter.removeMain(oldIdentity) {
                callback = it
                callbackReceived.countDown()
            }
            assertTrue("replacement refusal callback timed out", callbackReceived.await(10, TimeUnit.SECONDS))
            assertEquals(false, callback)
            waitUntil("replacement generation visibility") {
                retainedAdapter.mainGenerationAbsent(oldIdentity)
            }
            assertTrue(fixture.account in fixture.manager.getAccountsByType(fixture.account.type))
        } finally {
            adapter?.close()
            fixture.close()
        }
    }

    @Test fun delayedSuccessfulRemovalAfterRecreationRoutesRetainedSibling() {
        val target = Fixture("retained-target")
        val sibling = Fixture("retained-sibling")
        val siblingIdentity = ExactAccountIdentity(sibling.account.type, sibling.account.name, sibling.creationId)
        val fake = DelayedSuccessSeams(target.context, target.account, target.creationId, sibling.account, siblingIdentity)
        CurrentAccountSignOutViewModel.seamsFactory = { _, _, _ -> fake }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(target.context, target.account)).use { scenario ->
                scenario.onActivity { activity ->
                    androidx.lifecycle.ViewModelProvider(activity)[CurrentAccountSignOutViewModel::class.java].begin()
                }
                // The removal is asked for off the main thread, once the store steps before it have ended.
                settle(scenario)
                assertEquals(1, fake.removeCalls)
                // The platform row disappears while the retained coordinator still awaits its
                // callback. The recreated Activity must attach to that coordinator before trying
                // to validate its now-stale explicit route.
                removeAccountAndWait(target.manager, target.account)
                scenario.recreate()
                val monitor = instrumentation.addMonitor(AccountActivity::class.java.name, null, false)
                var launched: android.app.Activity? = null
                try {
                    // The retained ViewModel already owns its coordinator. Do not let this
                    // target-specific factory initialize the replacement sibling Activity.
                    CurrentAccountSignOutViewModel.seamsFactory = null
                    fake.absent = true
                    fake.callback!!(true)
                    launched = instrumentation.waitForMonitorWithTimeout(monitor, 10_000)
                    val replacementActivity = requireNotNull(launched) { "replacement AccountActivity was not launched" }
                    instrumentation.waitForIdleSync()
                    assertEquals(sibling.account,
                        replacementActivity.intent.getParcelableExtra<Account>(AccountActivity.EXTRA_ACCOUNT))
                    assertEquals(sibling.creationId,
                        replacementActivity.intent.getStringExtra(AccountActivity.EXTRA_CREATION_ID))
                    assertFalse("replacement AccountActivity rejected its exact route", replacementActivity.isFinishing)
                    assertEquals(1, fake.removeCalls)
                    assertEquals(sibling.account, ActiveAccountManager.getActiveAccount(target.context))
                } finally {
                    launched?.finish()
                    instrumentation.removeMonitor(monitor)
                }
            }
        } finally {
            CurrentAccountSignOutViewModel.seamsFactory = null
            sibling.close()
            target.close()
        }
    }

    @Test fun signOutWithUnsyncedNotesAsksTwiceBeforeItRemovesAnything() {
        val fixture = Fixture("unsynced")
        val fake = UnsyncedNotesSeams(fixture.account, fixture.creationId)
        CurrentAccountSignOutViewModel.seamsFactory = { _, _, _ -> fake }
        // With Notes on, Sync now asks the Notes job for a run. The job's work is replaced here, so no
        // Notes run reaches a server or a network: what is checked is whether a run was asked for, and
        // which kind. Each run is noted as: did the user start it, and its request id.
        val runs = CopyOnWriteArrayList<Pair<Boolean, String?>>()
        NotesSyncCoordinator.runnerOverride = { _, _, _, request -> runs += request.manual to request.requestId }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val count = UnsyncedNotesSignOutPolicy.Step.COUNT
        val discard = UnsyncedNotesSignOutPolicy.Step.DISCARD
        val positive = DialogInterface.BUTTON_POSITIVE
        val neutral = DialogInterface.BUTTON_NEUTRAL
        val negative = DialogInterface.BUTTON_NEGATIVE
        val cancel = "cancel:${fixture.account.name}"
        fun dialogOf(activity: AccountActivity, step: UnsyncedNotesSignOutPolicy.Step): AlertDialog? {
            activity.supportFragmentManager.executePendingTransactions()
            val fragment = activity.supportFragmentManager.findFragmentByTag(UnsyncedNotesDialogFragment.tag(step))
            return (fragment as? DialogFragment)?.dialog as? AlertDialog
        }
        fun message(dialog: AlertDialog) = dialog.findViewById<TextView>(android.R.id.message)!!.text.toString()
        fun snackbarText(activity: AccountActivity) =
            activity.findViewById<TextView>(com.google.android.material.R.id.snackbar_text)?.text?.toString()
        fun model(activity: AccountActivity) = ViewModelProvider(activity)[CurrentAccountSignOutViewModel::class.java]
        // The screen reads the store on IO before it asks anything, so the drawer's Sign out settles too.
        fun signOutFromDrawer(scenario: ActivityScenario<AccountActivity>) {
            scenario.onActivity { activity ->
                activity.onNavigationItemSelected(requireNotNull(
                    activity.findViewById<com.google.android.material.navigation.NavigationView>(R.id.nav_view)
                        .menu.findItem(R.id.nav_logout)))
            }
            settle(scenario)
        }
        // AlertDialog posts the button's listener and its own dismissal to the main looper, so a click
        // waits until the main thread is idle. A tap then waits until the store reads and steps it
        // started have settled; a click does not, for a step that is held.
        fun click(scenario: ActivityScenario<AccountActivity>, step: UnsyncedNotesSignOutPolicy.Step, button: Int) {
            scenario.onActivity { activity -> dialogOf(activity, step)!!.getButton(button).performClick() }
            instrumentation.waitForIdleSync()
        }
        fun tap(scenario: ActivityScenario<AccountActivity>, step: UnsyncedNotesSignOutPolicy.Step, button: Int) {
            click(scenario, step, button)
            settle(scenario)
        }
        fun assertNoDialog(scenario: ActivityScenario<AccountActivity>) {
            scenario.onActivity { activity ->
                assertNull(dialogOf(activity, count))
                assertNull(dialogOf(activity, discard))
            }
        }
        /** What the screen and the coordinator asked of the seams since [since] calls, in order. */
        fun callsSince(since: Int) = fake.calls.drop(since)
        /**
         * What a new app process changes for an open dialog of [step]: its token is not this process's ([token]), or
         * it has none (null, a dialog from before the token). The arguments are edited before the screen is created
         * again, so the dialog comes back from them.
         */
        fun restoredFromAnotherProcess(scenario: ActivityScenario<AccountActivity>,
            step: UnsyncedNotesSignOutPolicy.Step, token: String?) {
            scenario.onActivity { activity ->
                activity.supportFragmentManager.executePendingTransactions()
                val args = requireNotNull(activity.supportFragmentManager
                    .findFragmentByTag(UnsyncedNotesDialogFragment.tag(step))) { "the $step dialog" }.requireArguments()
                assertEquals("made in this process", ProcessIncarnation.current(),
                    args.getString(UnsyncedNotesDialogFragment.ARG_PROCESS))
                if (token == null) args.remove(UnsyncedNotesDialogFragment.ARG_PROCESS)
                else args.putString(UnsyncedNotesDialogFragment.ARG_PROCESS, token)
            }
            scenario.recreate()
            settle(scenario)
        }
        /** The dialogs of [step] the screen holds, ended ones included. */
        fun dialogsOf(activity: AccountActivity, step: UnsyncedNotesSignOutPolicy.Step): List<UnsyncedNotesDialogFragment> {
            activity.supportFragmentManager.executePendingTransactions()
            return activity.supportFragmentManager.fragments.filterIsInstance<UnsyncedNotesDialogFragment>()
                .filter { it.tag == UnsyncedNotesDialogFragment.tag(step) }
        }
        /** One dialog of [step], made in this process, after [what]. */
        fun assertOneFromThisProcess(scenario: ActivityScenario<AccountActivity>, step: UnsyncedNotesSignOutPolicy.Step,
            what: String) {
            scenario.onActivity { activity ->
                val open = dialogsOf(activity, step)
                assertEquals("$what: one $step dialog", 1, open.size)
                assertEquals("$what: made in this process", ProcessIncarnation.current(),
                    open.single().requireArguments().getString(UnsyncedNotesDialogFragment.ARG_PROCESS))
            }
        }
        try {
            val intent = AccountActivity.newIntent(fixture.context, fixture.account)
            ActivityScenario.launch<AccountActivity>(intent).use { scenario ->
                // 1. The count, with Sync now, Cancel, and going on without syncing.
                signOutFromDrawer(scenario)
                scenario.onActivity { activity ->
                    val shown = requireNotNull(dialogOf(activity, count)) { "the count dialog" }
                    assertEquals(activity.resources.getQuantityString(R.plurals.notes_sign_out_unsynced, 2, 2),
                        message(shown))
                    assertEquals(activity.getString(R.string.account_synchronize_now),
                        shown.getButton(positive).text.toString())
                    assertEquals(activity.getString(R.string.notes_sign_out_without_syncing),
                        shown.getButton(neutral).text.toString())
                    assertEquals(activity.getString(android.R.string.cancel), shown.getButton(negative).text.toString())
                }
                assertEquals("the screen only counted", listOf("count"), fake.calls)

                // 2. Cancel cancels, clears and removes nothing.
                var since = fake.calls.size
                tap(scenario, count, negative)
                assertNoDialog(scenario)
                assertEquals(emptyList<String>(), callsSince(since))

                // 3. Sync now with Notes off (the fixture's state): the dialog closes, no run is asked for, and
                // the answer is only counted again.
                signOutFromDrawer(scenario)
                since = fake.calls.size
                tap(scenario, count, positive)
                assertTrue(NotesSyncCoordinator.drainForTesting(10_000))
                assertTrue("Notes is off, so no run was asked for: $runs", runs.isEmpty())
                assertNoDialog(scenario)
                assertEquals(listOf("count"), callsSince(since))

                // 4. Sync now with Notes on: one run the user started, with the request id that Sync now
                // recorded for this account generation.
                check(AccountSettings.writeNotesEnabled(fixture.manager, fixture.account, true))
                signOutFromDrawer(scenario)
                since = fake.calls.size
                tap(scenario, count, positive)
                waitUntil("the Notes run that Sync now asked for") { runs.any { it.first } }
                assertTrue(NotesSyncCoordinator.drainForTesting(10_000))
                val started = runs.filter { it.first }
                assertEquals("one run the user started: $runs", 1, started.size)
                val recorded = SyncStatusStore(fixture.context).let {
                    it.status(it.identity(fixture.account, fixture.creationId), SyncStatusStore.Service.NOTES)
                        .activeRequestId
                }
                assertNotNull("Sync now recorded a request", recorded)
                assertEquals("the run has the request id that Sync now recorded", recorded, started.single().second)
                assertNoDialog(scenario)
                assertEquals(listOf("count"), callsSince(since))

                // 5. Going on without syncing leads to the separate confirmation, and asks for no sign-out.
                signOutFromDrawer(scenario)
                since = fake.calls.size
                tap(scenario, count, neutral)
                scenario.onActivity { activity ->
                    val shown = requireNotNull(dialogOf(activity, discard)) { "the discard confirmation" }
                    assertEquals(activity.resources.getQuantityString(R.plurals.notes_discard_text, 2, 2),
                        message(shown))
                    assertEquals(activity.getString(R.string.notes_discard_and_sign_out),
                        shown.getButton(positive).text.toString())
                    assertNull("the count dialog closed", dialogOf(activity, count))
                }
                assertEquals(listOf("count"), callsSince(since))

                // 6. What the store holds moves on while the confirmation is open: the answer to it is turned
                // away before any sign-out is asked for, and the count is shown again.
                fake.unsynced = UnsyncedNotes(2, 8, false)
                since = fake.calls.size
                tap(scenario, discard, positive)
                scenario.onActivity { activity -> assertNotNull("the count is shown again", dialogOf(activity, count)) }
                assertEquals("the stale answer was turned away", listOf("count"), callsSince(since))

                // 7. The store changes after the answer was accepted: its clear finds more than was confirmed,
                // so the sign-out is refused with nothing cleared or removed, it is not shown as a failed
                // sign-out, and the count comes back with no tap. While master sync is off, the dashboard
                // shows a snackbar of its own from the start, so the snackbar text is read before the tap
                // and compared after.
                tap(scenario, count, neutral)
                scenario.onActivity { activity -> assertNotNull(dialogOf(activity, discard)) }
                var before: String? = null
                scenario.onActivity { activity -> before = snackbarText(activity) }
                fake.clear = PendingNotesStore.DiscardOutcome.Changed(UnsyncedNotes(2, 9, false))
                since = fake.calls.size
                tap(scenario, discard, positive)
                waitUntil("the count dialog after the refused sign-out") {
                    var shown = false
                    scenario.onActivity { activity -> shown = dialogOf(activity, count) != null }
                    shown
                }
                assertEquals("counted at the answer and before anything was canceled, canceled, asked to clear what " +
                    "the dialog showed, and counted again for the count dialog; nothing removed",
                    listOf("count", "count", cancel, "clear:${UnsyncedNotes(2, 8, false)}", "count"), callsSince(since))
                assertEquals(0, fake.removeCalls)
                scenario.onActivity { activity ->
                    val after = snackbarText(activity)
                    assertFalse("a refusal is not shown as a failed sign-out",
                        after == activity.getString(R.string.account_sign_out_failed))
                    assertEquals("the snackbar is the one from before the refused tap", before, after)
                }
                fake.clear = PendingNotesStore.DiscardOutcome.Done
                // Nothing is confirmed now, so this begin() is refused at its count, which runs off the main
                // thread, before anything is canceled. A sign-out whose count is in flight has not started.
                since = fake.calls.size
                scenario.onActivity { activity ->
                    model(activity).begin()
                    assertFalse("a sign-out whose count is in flight has not started", model(activity).hasStarted())
                }
                settle(scenario)
                scenario.onActivity { activity ->
                    assertEquals("the screen acknowledged the refusal", CurrentAccountSignOutState.Idle,
                        model(activity).currentState())
                    assertNotNull("the count is shown again", dialogOf(activity, count))
                }
                assertEquals("the coordinator's count, then the screen's after the refusal; nothing canceled",
                    listOf("count", "count"), callsSince(since))

                // 8. A count that throws: both dialogs say the changes could not be counted, never nothing and
                // never a number. Cancel on the confirmation asks for no sign-out.
                tap(scenario, count, negative)
                fake.countThrows = true
                signOutFromDrawer(scenario)
                scenario.onActivity { activity ->
                    val shown = requireNotNull(dialogOf(activity, count)) { "the count dialog" }
                    assertEquals(activity.getString(R.string.notes_sign_out_unsynced_unreadable), message(shown))
                }
                tap(scenario, count, neutral)
                scenario.onActivity { activity ->
                    val shown = requireNotNull(dialogOf(activity, discard)) { "the discard confirmation" }
                    assertEquals(activity.getString(R.string.notes_discard_unreadable), message(shown))
                }
                since = fake.calls.size
                tap(scenario, discard, negative)
                assertNoDialog(scenario)
                assertEquals(emptyList<String>(), callsSince(since))
                fake.countThrows = false

                // 9. A store that could not be listed: a confirmation of it deletes nothing, so both dialogs have
                // words of their own, never those of a discard, and no button says sign out. Cancel on the
                // confirmation asks for no sign-out.
                fake.unsynced = UnsyncedNotes(0, 7, true, listed = false)
                signOutFromDrawer(scenario)
                scenario.onActivity { activity ->
                    val shown = requireNotNull(dialogOf(activity, count)) { "the count dialog" }
                    assertEquals(activity.getString(R.string.notes_sign_out_unsynced_unlisted), message(shown))
                    assertEquals(activity.getString(R.string.notes_continue_without_syncing),
                        shown.getButton(neutral).text.toString())
                }
                tap(scenario, count, neutral)
                scenario.onActivity { activity ->
                    val shown = requireNotNull(dialogOf(activity, discard)) { "the confirmation" }
                    assertEquals(activity.getString(R.string.notes_acknowledge_text), message(shown))
                    assertEquals(activity.getString(R.string.notes_acknowledge_continue),
                        shown.getButton(positive).text.toString())
                }
                since = fake.calls.size
                tap(scenario, discard, negative)
                assertNoDialog(scenario)
                assertEquals(emptyList<String>(), callsSince(since))
                fake.unsynced = UnsyncedNotes(2, 8, false)

                // 10. A dialog that Android restores in a new app process has another process's token, or none.
                // Whatever its answer, the store is counted again and the count is shown again, made in this
                // process: no step 2, no sync, no confirmation and no sign-out. First, a dialog that has ended does
                // not hold back its own step, though the platform has not removed it; one that has not ended does.
                // The dialog reports its end here without closing its window.
                signOutFromDrawer(scenario)
                signOutFromDrawer(scenario)
                var endedDialog: UnsyncedNotesDialogFragment? = null
                scenario.onActivity { activity ->
                    assertEquals("an open dialog holds its step", 1, dialogsOf(activity, count).size)
                    val open = dialogsOf(activity, count).single()
                    open.onCancel(open.requireDialog())
                    assertTrue(open.ended)
                    endedDialog = open
                }
                signOutFromDrawer(scenario)
                scenario.onActivity { activity ->
                    val others = dialogsOf(activity, count).filter { it !== endedDialog }
                    assertEquals("the step is shown again", 1, others.size)
                    assertFalse(others.single().ended)
                    requireNotNull(endedDialog).dismiss()
                }
                tap(scenario, count, negative)
                assertNoDialog(scenario)
                // Going on without syncing from the count; the count after the count is also the case of a dialog
                // that has ended, which the platform may not have removed yet.
                signOutFromDrawer(scenario)
                restoredFromAnotherProcess(scenario, count, "another-process")
                since = fake.calls.size
                tap(scenario, count, neutral)
                assertOneFromThisProcess(scenario, count, "going on from another process's count")
                scenario.onActivity { activity -> assertNull("no step 2", dialogOf(activity, discard)) }
                assertEquals(listOf("count"), callsSince(since))
                // Sync now, with Notes on: no run is asked for.
                restoredFromAnotherProcess(scenario, count, java.util.UUID.randomUUID().toString())
                val startedBefore = runs.count { it.first }
                since = fake.calls.size
                tap(scenario, count, positive)
                assertTrue(NotesSyncCoordinator.drainForTesting(10_000))
                assertEquals("no run was asked for: $runs", startedBefore, runs.count { it.first })
                assertOneFromThisProcess(scenario, count, "Sync now from another process's count")
                assertEquals(listOf("count"), callsSince(since))
                // The discard confirmation, with another process's token and with none: nothing is confirmed,
                // canceled, cleared or removed, and no sign-out starts. Going on from a dialog made in this
                // process still leads to it.
                for (token in listOf("another-process", null)) {
                    tap(scenario, count, neutral)
                    restoredFromAnotherProcess(scenario, discard, token)
                    since = fake.calls.size
                    tap(scenario, discard, positive)
                    assertOneFromThisProcess(scenario, count, "the discard with token $token")
                    scenario.onActivity { activity ->
                        assertNull("no confirmation is shown", dialogOf(activity, discard))
                        assertEquals(CurrentAccountSignOutState.Idle, model(activity).currentState())
                        assertFalse("no sign-out started", model(activity).hasStarted())
                    }
                    assertEquals("token $token: only counted again", listOf("count"), callsSince(since))
                    assertEquals(0, fake.removeCalls)
                }
                tap(scenario, count, negative)
                assertNoDialog(scenario)

                // 11. The confirmation survives a recreation, and its own button confirms and starts the
                // sign-out, in this order: counted at the answer and before anything is canceled, the sync
                // canceled, the store asked to clear what the dialog showed, and only then the removal. The
                // clear is held, and the screen is created again while it is: the sign-out goes on in the
                // view model, and the screen that comes back is the one that shows a sign-out under way.
                signOutFromDrawer(scenario)
                tap(scenario, count, neutral)
                scenario.recreate()
                settle(scenario)
                scenario.onActivity { activity ->
                    assertNull("no count dialog after the recreation", dialogOf(activity, count))
                }
                since = fake.calls.size
                fake.holdClear()
                click(scenario, discard, positive)
                fake.awaitClear()
                assertEquals("the clear is under way, and the removal waits for it",
                    listOf("count", "count", cancel, "clear:${UnsyncedNotes(2, 8, false)}"), callsSince(since))
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals(CurrentAccountSignOutState.Removing, model(activity).currentState())
                    assertTrue("the clear is still in flight", model(activity).stepsInFlight() > 0)
                    assertTrue("the recreated screen keeps the sign-out", model(activity).hasStarted())
                }
                assertEquals(0, fake.removeCalls)

                // 12. The screen closes for good while the clear is still held. A sign-out past its count
                // goes on without it: the clear ends, the removal is still asked for, and the seams are
                // closed only after that. The removal then fails, from a thread of its own: its answer is
                // still taken on the main thread and the store reopened off it, so the steps' scope
                // outlived the screen, and the seams are closed again once that step ended.
                scenario.moveToState(Lifecycle.State.DESTROYED)
                assertFalse("nothing is closed while the clear is in flight", "close" in callsSince(since))
                fake.releaseClear()
                waitUntil("the removal to be asked for once the screen is gone") { fake.removeCalls == 1 }
                waitUntil("the seams to be closed after the last step") { "close" in fake.calls }
                assertEquals(listOf("count", "count", cancel, "clear:${UnsyncedNotes(2, 8, false)}", "remove", "close"),
                    callsSince(since))
                val answer = requireNotNull(fake.removal) { "the removal's callback" }
                answer(false)
                waitUntil("the store to be reopened after the failed removal") { "reopen" in fake.calls }
                waitUntil("the seams to be closed after the reopening") { fake.calls.count { it == "close" } == 2 }
                assertEquals(listOf("count", "count", cancel, "clear:${UnsyncedNotes(2, 8, false)}", "remove", "close",
                    "reopen", "close"), callsSince(since))
                assertEquals(1, fake.removeCalls)
                assertEquals("no count, clear, removal request or reopening ran on the main thread",
                    emptyList<String>(), fake.onMainThread.toList())
            }
        } finally {
            // A held clear is let go, so no thread is left waiting on it.
            fake.releaseClear()
            // Notes goes off first, so a platform sync of this account that ends now asks for no Notes
            // run. Then what is queued is canceled and waited for, and only then is the stand-in taken
            // away.
            AccountSettings.writeNotesEnabled(fixture.manager, fixture.account, false)
            NotesSyncCoordinator.cancelAccount(fixture.account.type, fixture.account.name)
            NotesSyncCoordinator.drainForTesting(10_000)
            NotesSyncCoordinator.runnerOverride = null
            CurrentAccountSignOutViewModel.seamsFactory = null
            // The stand-in run never closes the request that Sync now recorded.
            SyncStatusStore(fixture.context).let { it.clear(it.identity(fixture.account, fixture.creationId)) }
            fixture.close()
        }
    }

    /** The removal is asked for off the main thread, so what it leaves is read across threads. */
    private class DelayedFailureSeams(account: Account) : CurrentAccountSignOutCoordinator.Seams {
        private val identity = ExactAccountIdentity(account.type, account.name, "failure-generation")
        @Volatile var removeCalls = 0
        var destructiveCleanupCalls = 0
        @Volatile var callback: ((Boolean) -> Unit)? = null
        override fun snapshot() = CurrentAccountSignOutSnapshot(identity, emptyList(), listOf(identity))
        override fun cancelSync(identity: Pair<String, String>) = Unit
        override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
            removeCalls++
            this.callback = callback
        }
        override fun mainGenerationAbsent(main: ExactAccountIdentity) = false
        override fun clearCache(main: ExactAccountIdentity) = true.also { destructiveCleanupCalls++ }
        override fun clearStatus(main: ExactAccountIdentity) = true.also { destructiveCleanupCalls++ }
        override fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?) =
            ActiveAccountReconciliation(true, replacement).also { destructiveCleanupCalls++ }
        override fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit) {
            destructiveCleanupCalls++
            callback(true)
        }
        override fun unsyncedNotes(main: ExactAccountIdentity) = UnsyncedNotes.NOTHING
        override fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?) =
            PendingNotesStore.DiscardOutcome.Done
        override fun reopenPendingNotes(main: ExactAccountIdentity) = Unit
    }

    private class DelayedSuccessSeams(
        private val context: Context,
        target: Account,
        generation: String,
        private val siblingAccount: Account,
        private val sibling: ExactAccountIdentity,
    ) : CurrentAccountSignOutCoordinator.Seams {
        private val targetIdentity = ExactAccountIdentity(target.type, target.name, generation)
        @Volatile var absent = false
        @Volatile var removeCalls = 0
        @Volatile var callback: ((Boolean) -> Unit)? = null
        override fun snapshot() = CurrentAccountSignOutSnapshot(targetIdentity, emptyList(), listOf(targetIdentity, sibling))
        override fun cancelSync(identity: Pair<String, String>) = Unit
        override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
            removeCalls++
            this.callback = callback
        }
        override fun mainGenerationAbsent(main: ExactAccountIdentity) = absent
        override fun clearCache(main: ExactAccountIdentity) = true
        override fun clearStatus(main: ExactAccountIdentity) = true
        override fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?) =
            ActiveAccountReconciliation(ActiveAccountManager.setActiveAccount(context, siblingAccount), sibling)
        override fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit) = callback(true)
        override fun unsyncedNotes(main: ExactAccountIdentity) = UnsyncedNotes.NOTHING
        override fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?) =
            PendingNotesStore.DiscardOutcome.Done
        override fun reopenPendingNotes(main: ExactAccountIdentity) = Unit
    }

    /**
     * Seams that report unsynced Notes changes and never answer the removal themselves, so the sign-out
     * stays in progress and the screen stays; a test can answer it ([removal]). Every count, cancel,
     * clear of the store, removal, reopening and close is logged in order ([calls]); what the clear
     * answers can be set, the count can be made to throw, and the next clear can be held
     * ([holdClear]). A count, clear, removal request or reopening made on the main thread is logged in
     * [onMainThread] as well. They touch no store, sync or account, and every cleanup step answers yes.
     */
    private class UnsyncedNotesSeams(account: Account, generation: String) : CurrentAccountSignOutCoordinator.Seams {
        private val identity = ExactAccountIdentity(account.type, account.name, generation)
        @Volatile var unsynced = UnsyncedNotes(2, 7, false)
        @Volatile var countThrows = false
        @Volatile var clear: PendingNotesStore.DiscardOutcome = PendingNotesStore.DiscardOutcome.Done
        /** "count", "cancel:<name>", "clear:<the confirmed answer>", "remove", "reopen" and "close", in the order asked. */
        val calls = CopyOnWriteArrayList<String>()
        /** The counts, clears, removal requests and reopenings made on the main thread. */
        val onMainThread = CopyOnWriteArrayList<String>()
        @Volatile var removeCalls = 0
        /** The callback of the last removal request, kept so a test can answer it. */
        @Volatile var removal: ((Boolean) -> Unit)? = null
        @Volatile private var held: CountDownLatch? = null
        @Volatile private var arrived: CountDownLatch? = null

        /** Holds the next clear, once it is asked for, until [releaseClear]. */
        fun holdClear() {
            arrived = CountDownLatch(1)
            held = CountDownLatch(1)
        }

        /** Waits until the held clear has been asked for. */
        fun awaitClear() = assertTrue("the held clear was asked for", arrived!!.await(10, TimeUnit.SECONDS))

        fun releaseClear() { held?.countDown() }

        private fun asked(call: String) {
            calls += call
            if (Thread.currentThread() === Looper.getMainLooper().thread) onMainThread += call
        }

        override fun snapshot() = CurrentAccountSignOutSnapshot(identity, emptyList(), listOf(identity))
        override fun cancelSync(identity: Pair<String, String>) { calls += "cancel:${identity.second}" }
        override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
            asked("remove")
            removal = callback
            removeCalls++
        }
        override fun mainGenerationAbsent(main: ExactAccountIdentity) = false
        override fun clearCache(main: ExactAccountIdentity) = true
        override fun clearStatus(main: ExactAccountIdentity) = true
        override fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?) =
            ActiveAccountReconciliation(true, replacement)
        override fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit) =
            callback(true)
        override fun unsyncedNotes(main: ExactAccountIdentity): UnsyncedNotes {
            asked("count")
            if (countThrows) throw IllegalStateException("cannot look")
            return unsynced
        }
        override fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?): PendingNotesStore.DiscardOutcome {
            asked("clear:$confirmed")
            arrived?.countDown()
            held?.let { check(it.await(30, TimeUnit.SECONDS)) { "the held clear was never let go" } }
            held = null
            return clear
        }
        override fun reopenPendingNotes(main: ExactAccountIdentity) { asked("reopen") }
        override fun close() { calls += "close" }
    }

    /**
     * Waits until the screen reads no pending Notes store and the sign-out has no store step in
     * flight, with the main thread idle before each look. It looks twice in a row: a step that ends
     * posts its state, and showing that state can start another read.
     */
    private fun settle(scenario: ActivityScenario<AccountActivity>) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        fun quiet(): Boolean {
            instrumentation.waitForIdleSync()
            var quiet = false
            scenario.onActivity { activity ->
                quiet = !activity.unsyncedNotesReadInFlightForTesting() &&
                    ViewModelProvider(activity)[CurrentAccountSignOutViewModel::class.java].stepsInFlight() == 0
            }
            return quiet
        }
        waitUntil("the sign-out's store reads and steps to end") { quiet() && quiet() }
    }

    private fun removeAccountAndWait(manager: AccountManager, account: Account) {
        if (account !in manager.getAccountsByType(account.type)) return
        val removed = CountDownLatch(1)
        AndroidCompat.removeAccount(manager, account) { removed.countDown() }
        assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
        assertFalse("account row remained after confirmed removal", account in manager.getAccountsByType(account.type))
    }

    private inner class Fixture(private val label: String) : AutoCloseable {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("$label-${System.nanoTime()}@example.invalid", App.accountType)
        val creationId = "$label-generation"
        private val previousBootstrap = App.postLoginBootstrapSucceeded
        init {
            check(manager.addAccountExplicitly(account, null, null))
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, creationId))
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_LIMITED_INTEGRATIONS, "true"))
            check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.COMPLETE))
            App.postLoginBootstrapSucceeded = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                InstrumentationRegistry.getInstrumentation().uiAutomation
                    .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.POST_NOTIFICATIONS}").close()
            }
        }
        fun use(block: (Account) -> Unit) = try { block(account) } finally { close() }
        override fun close() {
            App.postLoginBootstrapSucceeded = previousBootstrap
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }
}
