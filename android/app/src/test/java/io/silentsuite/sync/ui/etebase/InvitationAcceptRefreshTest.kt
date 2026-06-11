package io.silentsuite.sync.ui.etebase

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class InvitationAcceptRefreshTest {
    private val sourceRoot = File("src/main/java")

    @Test
    fun acceptingInvitationRequestsForcedSyncOnlyAfterAcceptCompletes() {
        val source = File(sourceRoot, "io/silentsuite/sync/ui/etebase/InvitationsListFragment.kt").readText()

        assertTrue(
            "accept must report completion before the UI requests sync",
            source.contains("fun accept(accountCollectionHolder: AccountHolder, invitation: SignedInvitation, onComplete: (Result<Unit>) -> Unit = {})")
        )
        assertTrue(
            "accept must wait for invitationManager.accept(invitation)",
            source.contains("invitationManager.accept(invitation)")
        )
        assertTrue(
            "sync must be requested from the success callback with forced collection refresh",
            source.contains("requestSync(applicationContext, account, forceCollectionRefresh = true)")
        )
        assertTrue(
            "application context and account must be captured before the async accept to survive fragment detach",
            source.contains("val applicationContext = requireContext().applicationContext") &&
                    source.contains("invitationsModel.accept(accountHolder, invitation)") &&
                    source.indexOf("val applicationContext = requireContext().applicationContext") <
                    source.indexOf("invitationsModel.accept(accountHolder, invitation)")
        )
        assertFalse(
            "sync must not be requested immediately after starting the accept coroutine",
            source.contains("invitationsModel.accept(accountHolder, invitation)\n                    requestSync")
        )
    }

    @Test
    fun forcedPostAcceptSyncBypassesCollectionRefreshSuppressionAndStoken() {
        val requestSyncSource = File(sourceRoot, "io/silentsuite/sync/syncadapter/RequestSync.kt").readText()
        val syncAdapterSource = File(sourceRoot, "io/silentsuite/sync/syncadapter/SyncAdapterService.kt").readText()

        assertTrue(
            "requestSync must expose an explicit forced collection refresh extra",
            requestSyncSource.contains("EXTRA_FORCE_COLLECTION_REFRESH") &&
                    requestSyncSource.contains("extras.putBoolean(EXTRA_FORCE_COLLECTION_REFRESH, true)")
        )
        assertTrue(
            "forced refresh must bypass the 5 second collection refresh suppression",
            syncAdapterSource.contains("if (!forceRefresh && abs(now - lastCollectionsFetch) <= cacheAge)")
        )
        assertTrue(
            "forced refresh must perform a full collection-list fetch instead of reusing the old stoken",
            syncAdapterSource.contains("var stoken = if (forceRefresh) null else etebaseLocalCache.loadStoken()")
        )
    }
}
