package io.silentsuite.sync.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SiblingMaterialAccessibilityContractTest {
    private val main = File("src/main")
    private fun source(relative: String) = File(main, relative).readText()

    @Test
    fun permissionRemediationUsesMaterialScrollableNamedControlsAndQuietAnnouncements() {
        val layout = source("res/layout/activity_permissions.xml")
        val activity = source("java/io/silentsuite/sync/ui/PermissionsActivity.kt")

        assertTrue(layout.contains("android:fillViewport=\"true\""))
        assertTrue(layout.contains("MaterialCardView"))
        assertTrue(layout.contains("Widget.AppTheme.Material3.Button"))
        assertTrue(layout.contains("@dimen/touch_target_min"))
        assertTrue(layout.contains("permissions_action_needed"))
        assertTrue(activity.contains("lastAnnouncedRequirements"))
        assertTrue(activity.contains("announceForAccessibility"))
        assertTrue(activity.contains("requirements != lastAnnouncedRequirements"))
    }

    @Test
    fun siblingLayoutsAreRtlSafeScrollableAndExposeNonColorStatus() {
        val layouts = listOf(
            "activity_permissions.xml",
            "activity_create_collection.xml",
            "change_encryption_password.xml",
            "collection_header.xml",
            "collection_members_list_item.xml",
            "etebase_view_collection_members.xml",
            "etebase_view_collection_members_no_access.xml",
            "view_collection_fragment.xml",
            "journal_viewer_list_item.xml",
            "import_actions_list.xml",
            "import_actions_list_item.xml",
            "import_content_list_account.xml",
            "import_content_list_header.xml",
            "import_calendars_list_item.xml"
        ).map { source("res/layout/$it") }

        layouts.forEach { xml ->
            assertFalse(xml.contains("layout_marginLeft"))
            assertFalse(xml.contains("layout_marginRight"))
            assertFalse(xml.contains("paddingLeft"))
            assertFalse(xml.contains("paddingRight"))
            assertFalse(xml.contains("layout_gravity=\"right\""))
            assertFalse(xml.contains("layout_gravity=\"left\""))
        }
        assertTrue(source("res/layout/activity_create_collection.xml").contains("android:fillViewport=\"true\""))
        assertTrue(source("res/layout/change_encryption_password.xml").contains("android:fillViewport=\"true\""))
        assertTrue(source("res/layout/collection_members_list_item.xml").contains("android:contentDescription=\"@null\""))
        assertTrue(source("res/layout/collection_header.xml").contains("importantForAccessibility=\"no\""))
        assertTrue(source("res/layout/view_collection_fragment.xml").contains("android:name=\"io.silentsuite.sync.ui.etebase.ListEntriesFragment\""))
        assertTrue(source("java/io/silentsuite/sync/ui/etebase/ListEntriesFragment.kt").contains("collection_activity_accessibility"))
    }

    @Test
    fun collectionAndImportActionsHaveSingleNamedSemanticsAndFortyEightDpTargets() {
        val members = source("res/layout/etebase_view_collection_members.xml")
        val importAction = source("res/layout/import_actions_list_item.xml")
        val memberRow = source("res/layout/collection_members_list_item.xml")
        val fragment = source("java/io/silentsuite/sync/ui/etebase/CollectionMembersListFragment.kt")

        assertTrue(members.contains("@+id/add_member"))
        assertTrue(members.contains("Widget.AppTheme.Material3.Button"))
        assertTrue(importAction.contains("android:minHeight=\"@dimen/touch_target_min\""))
        assertTrue(importAction.contains("android:focusable=\"true\""))
        assertTrue(importAction.contains("android:contentDescription=\"@null\""))
        assertTrue(memberRow.contains("android:minHeight=\"@dimen/touch_target_min\""))
        assertTrue(fragment.contains("collection_member_accessibility"))
        assertTrue(fragment.contains("identity.validate(applicationContext)"))
        assertTrue(fragment.contains("identity.account != accountCollectionHolder.account"))
        assertTrue(source("res/layout/invitations_list_item.xml").contains("android:contentDescription=\"@null\""))
    }

    @Test
    fun encryptionPasswordRouteIsExactGenerationAndSecretsNeverEnterViewState() {
        val activity = source("java/io/silentsuite/sync/ui/ChangeEncryptionPasswordActivity.kt")
        val layout = source("res/layout/change_encryption_password.xml")

        assertTrue(activity.contains("EXTRA_CREATION_ID"))
        assertTrue(activity.contains("ExactAccountRouting.validate"))
        assertTrue(activity.contains("accountCreationId = requireNotNull(creationId)"))
        assertTrue(activity.contains("findViewById<TextView>(R.id.account_name).text = account.name"))
        assertTrue(layout.split("android:saveEnabled=\"false\"").size - 1 >= 2)
        assertTrue(layout.contains("Widget.AppTheme.Material3.TextInputLayout"))
        assertTrue(activity.split("ExactAccountRouting.validate").size - 1 >= 4)
    }

    @Test
    fun invitationsRecreatesWithExactGenerationAndViewLifecycleObservers() {
        val activity = source("java/io/silentsuite/sync/ui/etebase/InvitationsActivity.kt")
        val fragment = source("java/io/silentsuite/sync/ui/etebase/InvitationsListFragment.kt")

        assertTrue(activity.contains("EXTRA_CREATION_ID"))
        assertTrue(activity.contains("ExactAccountRouting.validate"))
        assertTrue(activity.contains("model.loadAccount(this, account, requireNotNull(creationId))"))
        assertTrue(activity.contains("findFragmentById(R.id.fragment_container)"))
        assertTrue(fragment.contains("observe(viewLifecycleOwner)"))
        assertFalse(fragment.contains("observe(this)"))
        assertTrue(fragment.contains("InvitationLifecycleIdentity.from(arguments)"))
        assertTrue(fragment.split("identity.validate(applicationContext)").size - 1 >= 4)
    }

    @Test
    fun dashboardExportAndFingerprintSurviveRecreationWithExactGeneration() {
        val account = source("java/io/silentsuite/sync/ui/AccountActivity.kt")
        val fingerprint = source("java/io/silentsuite/sync/ui/FingerprintDialogFragment.kt")

        assertTrue(account.contains("KEY_PENDING_EXPORT_KIND"))
        assertTrue(account.substringAfter("override fun onActivityResult").contains("accountCreationId"))
        assertTrue(account.substringAfter("override fun onActivityResult").split("ExactAccountRouting.validate").size - 1 >= 2)
        assertTrue(account.contains("FingerprintDialogFragment.newInstance(account, accountCreationId)"))
        assertTrue(fingerprint.contains("class FingerprintDialogFragment : DialogFragment()"))
        assertTrue(fingerprint.contains("ExactAccountRouting.validate"))
        assertTrue(fingerprint.contains("ARG_CREATION_ID"))
        val copyCallback = fingerprint.substringAfter("setNeutralButton(R.string.copy_fingerprint)")
        assertTrue(copyCallback.indexOf("ExactAccountRouting.validate") < copyCallback.indexOf("clipboard.setPrimaryClip"))
        assertTrue(copyCallback.contains("dismissAllowingStateLoss()"))
    }

    @Test
    fun collectionMutationBoundariesRevalidateBeforeRemoteAndCacheWrites() {
        val edit = source("java/io/silentsuite/sync/ui/etebase/EditCollectionFragment.kt")

        assertTrue(edit.contains("uploadCollection(identity, applicationContext, col)"))
        assertTrue(edit.contains("private fun uploadCollection("))
        assertTrue(edit.substringAfter("private fun uploadCollection(").split("identity.validate(applicationContext)").size - 1 >= 2)
        assertTrue(edit.contains("identity.account != accountHolder.account"))
    }

    @Test
    fun meaningfulCollectionStatusIsPoliteAndIsNotResetWhenUnchanged() {
        val layout = source("res/layout/view_collection_fragment.xml")
        val fragment = source("java/io/silentsuite/sync/ui/etebase/ViewCollectionFragment.kt")

        assertTrue(layout.contains("android:accessibilityLiveRegion=\"polite\""))
        assertTrue(fragment.contains("if (stats.text != status)"))
        assertTrue(fragment.contains("stats.text = status"))
    }
}
