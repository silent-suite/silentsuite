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
            source.contains("fun accept(") &&
                    source.contains("identity: InvitationLifecycleIdentity") &&
                    source.contains("onComplete: (Result<Unit>) -> Unit = {}")
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
                    source.contains("invitationsModel.accept(applicationContext, identity, accountHolder, invitation.realInvitation()!!)") &&
                    source.indexOf("val applicationContext = requireContext().applicationContext") <
                    source.indexOf("invitationsModel.accept(applicationContext, identity, accountHolder, invitation.realInvitation()!!)")
        )
        assertFalse(
            "sync must not be requested immediately after starting the accept coroutine",
            source.contains("invitationsModel.accept(accountHolder, invitation)\n                    requestSync")
        )
        assertTrue(
            "accept and reject must revalidate the exact account generation at the IO boundary",
            source.split("identity.validate(applicationContext)").size - 1 >= 4
        )
    }

    @Test
    fun forcedPostAcceptSyncBypassesCollectionRefreshSuppressionAndStoken() {
        val requestSyncSource = File(sourceRoot, "io/silentsuite/sync/syncadapter/RequestSync.kt").readText()
        val syncAdapterSource = File(sourceRoot, "io/silentsuite/sync/syncadapter/SyncAdapterService.kt").readText()
        val listRefreshSource = File(sourceRoot, "io/silentsuite/sync/syncadapter/CollectionListRefresh.kt").readText()

        assertTrue(
            "requestSync must expose an explicit forced collection refresh extra",
            requestSyncSource.contains("EXTRA_FORCE_COLLECTION_REFRESH") &&
                    requestSyncSource.contains("extras.putBoolean(EXTRA_FORCE_COLLECTION_REFRESH, true)")
        )
        assertTrue(
            "the adapter must hand the forced flag to the shared collection-list refresh",
            syncAdapterSource.contains("CollectionListRefresh.run(context, account, settings, httpClient.okHttpClient, forceRefresh, creationId)")
        )
        assertTrue(
            "forced refresh must bypass the 5 second collection refresh suppression",
            listRefreshSource.contains("if (!forceRefresh && !discoveryChanged && abs(now - lastCollectionsFetch) <= CACHE_AGE_MILLIS)")
        )
        assertTrue(
            "forced refresh must perform a full collection-list fetch instead of reusing the old stoken",
            listRefreshSource.contains("listFrom(if (forceRefresh || discoveryChanged) null else savedStoken)")
        )
    }

    @Test
    fun unfinishedFullDiscoverySurvivesOneShotExtrasUnderTheGenerationFence() {
        val source = File(sourceRoot, "io/silentsuite/sync/syncadapter/CollectionListRefresh.kt").readText()
        val guard = File(sourceRoot, "io/silentsuite/sync/syncadapter/SyncRunGuard.kt").readText()
        val settings = File(sourceRoot, "io/silentsuite/sync/AccountSettings.kt").readText()
        val forceStart = source.indexOf("if (forceRefresh) {")
        val discoveryRead = source.indexOf("val discoveryChanged =")
        assertTrue(forceStart >= 0 && discoveryRead > forceStart)
        val obligation = source.substring(forceStart, discoveryRead)
        assertTrue("persist the obligation before any listing, rather than keeping it only in extras",
            obligation.contains("check(AccountSettings.writeCollectionListTypes(manager, account, \"\"))"))
        assertTrue("invalidation takes the cache monitor then the exact generation's write fence",
            obligation.indexOf("synchronized(etebaseLocalCache)") >= 0 &&
                obligation.indexOf("guard.write(etebaseLocalCache)") > obligation.indexOf("synchronized(etebaseLocalCache)"))
        assertTrue(guard.contains("manager.getAccountsByType(account.type).any { it == account }"))
        assertTrue(guard.contains("manager.getUserData(account, AccountSettings.KEY_CREATION_ID)?.takeIf { it.isNotBlank() } == creationId"))
        assertTrue(guard.contains("cache.writeIfCurrent(::mayWrite, write)"))
        assertTrue("blank coverage is read as pending discovery",
            settings.contains("getUserData(account, KEY_COLLECTION_LIST_TYPES)?.takeIf { it.isNotBlank() }"))
        assertTrue("even a recent successful listing cannot suppress an owed full refresh",
            source.contains("if (!forceRefresh && !discoveryChanged && abs(now - lastCollectionsFetch) <= CACHE_AGE_MILLIS)"))
        assertTrue("both old-cursor replay and full listing propagate bounded exhaustion",
            source.contains("if (savedStoken != null && !listFrom(savedStoken)) throw CollectionRefreshIncompleteException()") &&
                source.contains("if (!listFrom(if (forceRefresh || discoveryChanged) null else savedStoken)) throw CollectionRefreshIncompleteException()"))
        assertTrue(source.contains("private const val PAGE_ATTEMPTS = 3"))
        assertTrue(source.contains("if (++attempts >= PAGE_ATTEMPTS)"))
        val completed = source.indexOf("if (discoveryChanged) check(AccountSettings.writeCollectionListTypes(manager, account, discoveryTypesKey))")
        assertTrue("only accepted complete discovery restores coverage and publishes the burst window",
            completed > source.lastIndexOf("throw CollectionRefreshIncompleteException()") &&
                source.indexOf("collectionLastFetchMap[fetchKey] = now") > completed)
        val publication = source.substring(source.lastIndexOf("throw CollectionRefreshIncompleteException()"), completed)
        assertTrue(publication.contains("synchronized(etebaseLocalCache)") && publication.contains("guard.write(etebaseLocalCache)"))
    }

    @Test
    fun actualCallersStopBeforeProviderDiscoveryOrNotesSuccessOnIncompletion() {
        val adapter = File(sourceRoot, "io/silentsuite/sync/syncadapter/SyncAdapterService.kt").readText()
        val catchStart = adapter.indexOf("catch (e: CollectionRefreshIncompleteException)")
        val catchEnd = adapter.indexOf("catch (e: StaleSyncRunException)", catchStart)
        assertTrue(catchStart >= 0 && catchEnd > catchStart)
        val incomplete = adapter.substring(catchStart, catchEnd)
        assertTrue(incomplete.contains("finishWithoutOutcome(account, extras)"))
        assertTrue("platform completion is a soft retry, not a successful sync",
            incomplete.contains("syncResult.stats.numIoExceptions++") && incomplete.contains("Constants.DEFAULT_RETRY_DELAY"))
        assertFalse(incomplete.contains("recordSuccess("))
        val wrapper = adapter.substringAfter("inner class RefreshCollections").substringBefore("companion object")
        assertTrue(wrapper.contains("CollectionListRefresh.run("))
        assertFalse("the refresh wrapper must propagate incompletion", wrapper.contains("catch ("))
        for ((file, reconcile) in listOf(
            "CalendarsSyncAdapterService.kt" to "updateLocalCalendars(provider, account, settings)",
            "AddressBooksSyncAdapterService.kt" to "updateLocalAddressBooks(contactsProvider, account, settings)",
            "TasksSyncAdapterService.kt" to "updateLocalTaskLists(taskProvider, account, accountSettings)",
        )) {
            val caller = File(sourceRoot, "io/silentsuite/sync/syncadapter/$file").readText()
            val refresh = caller.indexOf("RefreshCollections(")
            val update = caller.indexOf(reconcile)
            assertTrue("$file must finish listing before provider reconciliation", refresh >= 0 && update > refresh)
            assertFalse("$file must not swallow incompletion", caller.substring(refresh, update).contains("catch ("))
        }
        val contacts = File(sourceRoot, "io/silentsuite/sync/syncadapter/AddressBooksSyncAdapterService.kt").readText()
        assertTrue(contacts.indexOf("contactsProvider.release()") < contacts.indexOf("val childAccounts ="))
        assertTrue(contacts.substringBefore("contactsProvider.release()").contains("} finally {"))

        val notes = File(sourceRoot, "io/silentsuite/sync/notes/NotesSyncRunner.kt").readText()
        assertTrue(notes.indexOf("CollectionListRefresh.run(") < notes.indexOf("listedCollections = true"))
        assertTrue(notes.indexOf("listedCollections = true") < notes.indexOf("fetchEachNotebook(notebooks"))
        val notesCatchStart = notes.indexOf("catch (e: CollectionRefreshIncompleteException)")
        val notesCatchEnd = notes.indexOf("catch (e: InterruptedException)", notesCatchStart)
        assertTrue(notesCatchStart >= 0 && notesCatchEnd > notesCatchStart)
        val notesIncomplete = notes.substring(notesCatchStart, notesCatchEnd)
        assertTrue(notesIncomplete.contains("finishWithoutOutcome()"))
        assertFalse(notesIncomplete.contains("recordSuccess()"))
        assertFalse(notesIncomplete.contains("listedCollections = true"))
        assertTrue(notes.contains("return listedCollections"))
        val coordinator = File(sourceRoot, "io/silentsuite/sync/notes/NotesSyncCoordinator.kt").readText()
        assertTrue(coordinator.contains("forcedRefreshOwed = request.forceRefresh && !listedCollections"))
    }
}
