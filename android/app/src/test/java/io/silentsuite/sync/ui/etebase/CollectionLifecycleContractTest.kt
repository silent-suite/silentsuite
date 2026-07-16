package io.silentsuite.sync.ui.etebase

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CollectionLifecycleContractTest {
    private val etebase = File("src/main/java/io/silentsuite/sync/ui/etebase")
    private val imports = File("src/main/java/io/silentsuite/sync/ui/importlocal")

    @Test
    fun activityReinitializesModelsWhileRestoredFragmentsReattachViewObservers() {
        val activity = File(etebase, "CollectionActivity.kt").readText()
        val view = File(etebase, "ViewCollectionFragment.kt").readText()
        val members = File(etebase, "CollectionMembersFragment.kt").readText()
        val edit = File(etebase, "EditCollectionFragment.kt").readText()

        val initialization = activity.substringAfter("setContentView(R.layout.etebase_fragment_activity)")
            .substringBefore("supportActionBar?.setDisplayHomeAsUpEnabled")
        assertTrue(initialization.contains("model.loadAccount(this, account, route.creationId)"))
        assertTrue(initialization.contains("findFragmentById(R.id.fragment_container)"))
        assertTrue(initialization.contains("!hasRestoredFragment"))
        listOf(view, members, edit).forEach { source ->
            assertTrue(source.contains("override fun onViewCreated"))
            assertTrue(source.contains("observe(viewLifecycleOwner)"))
        }
        assertTrue(view.contains("itemsModel.observe(viewLifecycleOwner)"))
        assertFalse(view.contains("itemsModel.observe(this)"))
    }

    @Test
    fun everyActiveFragmentRestoresExactNonSecretIdentityFromArguments() {
        val activity = File(etebase, "CollectionActivity.kt").readText()
        val importActivity = File(imports, "ImportActivity.kt").readText()
        val identity = File(etebase, "CollectionLifecycleIdentity.kt").readText()
        val sources = listOf(
            File(etebase, "ViewCollectionFragment.kt"),
            File(etebase, "CollectionMembersFragment.kt"),
            File(etebase, "EditCollectionFragment.kt"),
            File(imports, "ImportFragment.kt"),
            File(imports, "LocalCalendarImportFragment.kt"),
            File(imports, "LocalContactImportFragment.kt")
        ).map { it.readText() }

        assertTrue(identity.contains("ARG_ACCOUNT"))
        assertTrue(identity.contains("ARG_CREATION_ID"))
        assertTrue(identity.contains("ARG_COLLECTION_UID"))
        assertTrue(identity.contains("ARG_COLLECTION_TYPE"))
        assertTrue(identity.contains("creationId.isNotBlank()"))
        assertTrue(identity.contains("ExactAccountRouting.validate"))
        assertTrue(activity.contains("EXTRA_CREATION_ID"))
        assertTrue(activity.contains("account: Account, creationId: String"))
        assertTrue(activity.contains("require(creationId.isNotBlank())"))
        assertTrue(activity.contains("putExtra(EXTRA_CREATION_ID, creationId)"))
        assertFalse(activity.contains("getUserData(account, AccountSettings.KEY_CREATION_ID)"))
        assertTrue(activity.contains("ExactAccountRouting.validate(route.account, route.creationId"))
        assertTrue(activity.contains("private data class CollectionRoute"))
        assertFalse(activity.contains("provisional"))
        assertTrue(importActivity.contains("EXTRA_CREATION_ID"))
        assertTrue(importActivity.contains("CollectionLifecycleIdentity.existing"))
        assertTrue(importActivity.contains("ImportFragment.newInstance(identity)"))
        assertTrue(importActivity.contains("LocalCalendarImportFragment.newInstance(identity)"))
        assertTrue(importActivity.contains("LocalContactImportFragment.newInstance(identity)"))
        sources.forEach { source ->
            assertTrue(source.contains("CollectionLifecycleIdentity.from(arguments)"))
            assertTrue(source.contains("identity.validate(requireContext())"))
        }
        listOf("password", "session", "content", "inputStream").forEach { forbidden ->
            assertFalse(identity.contains("putString($forbidden", ignoreCase = true))
        }
    }

    @Test
    fun plaintextDraftsAndMemberActionsNeverEnterSavedState() {
        val members = File(etebase, "CollectionMembersFragment.kt").readText()
        val edit = File(etebase, "EditCollectionFragment.kt").readText()
        val fileImport = File(imports, "ImportFragment.kt").readText()
        val calendarImport = File(imports, "LocalCalendarImportFragment.kt").readText()
        val contactImport = File(imports, "LocalContactImportFragment.kt").readText()

        assertFalse(edit.contains("STATE_NAME"))
        assertFalse(edit.contains("STATE_DESCRIPTION"))
        assertFalse(members.contains("ARG_USERNAME"))
        assertFalse(edit.contains("outState.putString"))
        assertFalse(members.contains("putString(ARG_USERNAME"))
        assertTrue(edit.contains("CollectionDraftViewModel by viewModels()"))
        assertTrue(edit.contains("isSaveEnabled = false"))
        assertTrue(members.contains("MemberActionViewModel by activityViewModels()"))
        assertTrue(members.contains("ARG_ACTION_TOKEN"))
        assertTrue(members.contains("identity.validate(applicationContext)"))
        assertTrue(members.split("identity.validate(applicationContext)").size - 1 >= 3)
        assertTrue(edit.contains("LoadingViewModel by activityViewModels()"))
        assertTrue(edit.contains("if (loadingModel.isLoading) return"))
        assertTrue(edit.split("identity.validate(applicationContext)").size - 1 >= 2)
        assertTrue(fileImport.contains("if (savedInstanceState == null)"))
        assertTrue(fileImport.contains("if (!activeProcessWork ||"))
        assertTrue(fileImport.split("identity.validate(context)").size - 1 >= 8)
        assertTrue(fileImport.contains("closeSelectedInput()"))
        assertTrue(fileImport.contains("inputStream?.close()"))
        assertTrue(calendarImport.contains("if (importInProgress) return"))
        assertTrue(calendarImport.split("identity.validate(applicationContext)").size - 1 >= 2)
        assertTrue(contactImport.contains("if (importInProgress) return"))
        assertTrue(contactImport.split("identity.validate(applicationContext)").size - 1 >= 3)
        val view = File(etebase, "ViewCollectionFragment.kt").readText()
        val export = view.substringAfter("private fun createExportDocument")
        assertTrue(export.contains("identity.validate(applicationContext)"))
    }
}
