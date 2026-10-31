package io.silentsuite.sync.utils

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Text checks that every add, removal and rename of an account row in main code is a known one, and that each one of
 * the main account type moves the row counter first ([AccountRowChanges]): the maintainer's rule of 2026-10-20 on #709
 * (second reply) that the counter moves before every add or removal, the app's own included, with no exemption.
 */
class AccountRowChangesContractTest {
    private val sync = File("src/main/java/io/silentsuite/sync")

    /** [file]'s text without comments, so a KDoc that names a call does not count. */
    private fun code(file: File) = file.readText().replace("\r\n", "\n")
        .replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")

    /** How many code lines of each main source file match [pattern], by its path below the app's package. */
    private fun callsOf(pattern: Regex): Map<String, Int> =
        sync.walk().filter { it.isFile && it.extension in setOf("kt", "java") }.associate { file ->
            file.relativeTo(sync).invariantSeparatorsPath to code(file).lines().count(pattern::containsMatchIn)
        }.filterValues { it > 0 }.toSortedMap()

    @Test fun `every add, removal and rename of an account row in main code is one of the known calls`() {
        val rowChanges = Regex("""\b(addAccountExplicitly|removeAccountExplicitly|renameAccount)\(""" +
            """|(?<!AndroidCompat)\.removeAccount\(""")
        assertEquals(mapOf(
            // Address books: their add, rename, and removal.
            "resource/LocalAddressBook.kt" to 3,
            // The removal the one-time confirmation starts itself, through the authenticator.
            "ui/NotesRemovalOffer.kt" to 1,
            // The creation's add seam, the one production add of a main-type row.
            "ui/setup/CreateAccountFragment.kt" to 1,
            // The two removal helpers, one removal each.
            "utils/AndroidCompat.kt" to 2,
        ), callsOf(rowChanges))
        assertEquals("the helpers' callers: sign-out of the main row and its children, and setup recovery", mapOf(
            "ui/AndroidCurrentAccountSignOut.kt" to 2,
            "ui/setup/PostLoginSetupViewModel.kt" to 1,
        ), callsOf(Regex("""\bAndroidCompat\.removeAccount\(""")))
    }

    @Test fun `each main-type add and removal moves the row counter first, and address books move none`() {
        val creator = File(sync, "ui/setup/CreateAccountFragment.kt").readText().replace("\r\n", "\n")
        assertTrue("the add seam moves it before the add", creator.contains(
            "override fun add(): Boolean {\n" +
                "                    AccountRowChanges.mainType.before()\n" +
                "                    return accountManager.addAccountExplicitly(account, null, null)\n" +
                "                }\n"))

        // Both helpers move it as their first statement, before the removal, for a row of the main type.
        val compat = code(File(sync, "utils/AndroidCompat.kt"))
        val helpers = Regex("""fun removeAccount\([^\n]*\) \{\n([^\n]*)\n""").findAll(compat).map { it.groupValues[1] }
        assertEquals(List(2) { "        if (account.type == App.accountType) AccountRowChanges.mainType.before()" },
            helpers.toList())

        // An address book is an account of its own type, which a removal allowance never names.
        val books = code(File(sync, "resource/LocalAddressBook.kt"))
        assertTrue(books.contains("Account(accountName(mainAccount, cachedCollection), App.addressBookAccountType)"))
        // Each of its three calls is on that Account, the address book's own, never on mainAccount.
        val ownCalls = Regex("""\b(addAccountExplicitly|removeAccountExplicitly|renameAccount|removeAccount)""" +
            """\(account\b""")
        assertEquals(3, books.lines().count(ownCalls::containsMatchIn))
        assertFalse(Regex("""\bApp\.accountType\b""").containsMatchIn(books))
        assertFalse(books.contains("AccountRowChanges"))

        // Only those three places move it before a call; the one-time allowance moves it in its own atomic steps, the
        // confirmation's by a compare-and-set before its removal starts (NotesRemovalOffer.confirm).
        assertEquals(mapOf("ui/setup/CreateAccountFragment.kt" to 1, "utils/AndroidCompat.kt" to 2),
            callsOf(Regex("""\bAccountRowChanges\.mainType\.before\(\)""")))
        assertEquals(mapOf("ui/NotesRemovalAllowance.kt" to 2), callsOf(Regex("""\bmoveIfUnchanged\(""")).filterKeys {
            it != "utils/AccountRowChanges.kt"
        })
    }
}
