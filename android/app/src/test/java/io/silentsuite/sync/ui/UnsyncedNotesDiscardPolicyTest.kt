package io.silentsuite.sync.ui

import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.PendingNotesStore.DiscardOutcome
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Failure
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.HubRemoval
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Result
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Step
import io.silentsuite.sync.ui.UnsyncedNotesSignOutPolicy.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class UnsyncedNotesDiscardPolicyTest {
    private val two = UnsyncedNotes(2, 7, false, names = setOf("a.note", "b.note"))
    private val uncounted = UnsyncedNotes(0, 7, unreadable = true)
    private val unlisted = UnsyncedNotes(0, 7, unreadable = true, listed = false)
    private val directory = "0123456789abcdef".repeat(4)

    private fun row(answer: UnsyncedNotes?, owner: ExactAccountIdentity? = null, stopped: Boolean = false) =
        UnsyncedNotesRow(directory, owner, answer, stopped)

    private fun listing(vararg answers: UnsyncedNotes?, othersUnlisted: Boolean = false,
                        unknownOthers: Boolean = false) =
        UnsyncedNotesListing(answers.map { row(it) }, othersUnlisted, unknownOthers)

    private fun result(shown: UnsyncedNotes, ended: DiscardOutcome, retry: Boolean = false, label: String? = "alice") =
        UnsyncedNotesDiscardPolicy.result(shown, retry, directory, label, ended)

    private fun failed(shown: UnsyncedNotes, failure: Failure, retry: Boolean = false, label: String? = "alice") =
        UnsyncedNotesDiscardPolicy.result(shown, retry, directory, label, failure)

    private fun source(name: String) =
        File("src/main/java/io/silentsuite/sync/ui/$name").readText().replace("\r\n", "\n")

    /** The text of the string resource [name] in the default resources. */
    private fun stringText(name: String): String =
        Regex("<string name=\"$name\">(.*?)</string>").find(File("src/main/res/values/strings.xml").readText())
            ?.groupValues?.get(1) ?: throw AssertionError("no string $name")

    /** The texts of the plurals resource [name], one and other. */
    private fun pluralTexts(name: String): List<String> {
        val block = File("src/main/res/values/plurals.xml").readText().replace("\r\n", "\n")
            .substringAfter("<plurals name=\"$name\">", "").substringBefore("</plurals>")
        val texts = Regex("<item quantity=\"(one|other)\">(.*?)</item>").findAll(block).map { it.groupValues[2] }
        return texts.toList().also { assertEquals(name, 2, it.size) }
    }

    /** What follows [start] in [text], up to the first closing brace at [indent]: one function or block. */
    private fun body(text: String, start: String, indent: String = "    ") =
        text.substringAfter(start, "").substringBefore("\n$indent}\n")

    /** The confirmation dialog's source, and the branch of each step in it, up to its dialog's create(). */
    private val dialog by lazy {
        body(source("UnsyncedNotesFragment.kt"), "class UnsyncedNotesDiscardDialogFragment", "")
    }
    private fun branch(step: Step) = dialog.substringAfter("Step.${step.name} -> ", "").substringBefore(".create()")

    /** Every outcome the store can give, and every failure. */
    private val endings = listOf(DiscardOutcome.Done, DiscardOutcome.Changed(two), DiscardOutcome.Changed(unlisted),
        DiscardOutcome.Changed(UnsyncedNotes.NOTHING), DiscardOutcome.PermitNotRecorded, DiscardOutcome.NotFinished,
        DiscardOutcome.Acknowledged, DiscardOutcome.AcknowledgementNotRecorded)

    @Test fun `the confirmation is a discard only for a store that listed`() {
        for (shown in listOf(two, uncounted, UnsyncedNotes.NOTHING, UnsyncedNotes(3, 9, unreadable = true))) {
            assertEquals("$shown", Step.DISCARD, UnsyncedNotesDiscardPolicy.step(shown))
        }
        val never = UnsyncedNotes(0, 0, unreadable = true, listed = false)
        for (shown in listOf(unlisted, two.copy(listed = false), never)) {
            assertEquals("$shown", Step.ACKNOWLEDGE, UnsyncedNotesDiscardPolicy.step(shown))
        }
    }

    @Test fun `a count is shown or said to be uncountable, never 0`() {
        // A row: the count, or that it could not be counted, or that the store could not be read at all.
        assertEquals(Text.Counted(2), UnsyncedNotesDiscardPolicy.rowText(two))
        assertEquals(Text.Counted(1), UnsyncedNotesDiscardPolicy.rowText(UnsyncedNotes(1, 3, false)))
        assertEquals(Text.Uncounted, UnsyncedNotesDiscardPolicy.rowText(uncounted))
        assertEquals("files counted by name are not a count of changes", Text.Uncounted,
            UnsyncedNotesDiscardPolicy.rowText(UnsyncedNotes(3, 9, unreadable = true)))
        assertEquals("never a count of zero", Text.Uncounted, UnsyncedNotesDiscardPolicy.rowText(UnsyncedNotes.NOTHING))
        assertEquals(Text.Unlisted, UnsyncedNotesDiscardPolicy.rowText(unlisted))
        assertEquals("whatever else an answer of a store that could not be listed holds", Text.Unlisted,
            UnsyncedNotesDiscardPolicy.rowText(two.copy(listed = false)))
        assertEquals("a read that threw", Text.Unlisted, UnsyncedNotesDiscardPolicy.rowText(null))

        // The dialog of a discard takes its words from the same rule, so it never says 0 either.
        for (shown in listOf(two, uncounted, UnsyncedNotes.NOTHING, UnsyncedNotes(0, 0, unreadable = true))) {
            val text = UnsyncedNotesSignOutPolicy.text(shown)
            assertFalse("$shown", text is Text.Counted && text.count <= 0)
            assertEquals("$shown", text, UnsyncedNotesDiscardPolicy.rowText(shown))
        }

        // The hub: hidden while nothing is found, a sum only while every store was counted, else that not all of
        // them could be counted.
        assertNull(UnsyncedNotesDiscardPolicy.hubSummary(listing()))
        assertEquals(Text.Counted(3), UnsyncedNotesDiscardPolicy.hubSummary(listing(two, UnsyncedNotes(1, 3, false))))
        for (mixed in listOf(
            listing(two, unlisted), listing(two, uncounted), listing(two, null),
            listing(two, UnsyncedNotes(0, 0, unreadable = true)), listing(unlisted), listing(null),
            listing(two, othersUnlisted = true), listing(two, unknownOthers = true),
            listing(othersUnlisted = true), listing(unknownOthers = true),
        )) {
            assertEquals("$mixed", Text.Uncounted, UnsyncedNotesDiscardPolicy.hubSummary(mixed))
        }

        // With no store to show, the row stays while Android settings can't remove an account, or the accounts can't
        // be read, saying which, and only then.
        val refused = NotesRemovalSection.Section(listOf(
            NotesRemovalSection.Row("io.silentsuite", "a", NotesRemovalNotice.Kind.CONFIRM)), accountsUnread = false)
        val unread = NotesRemovalSection.Section(emptyList(), accountsUnread = true)
        val clear = NotesRemovalSection.Section(emptyList(), accountsUnread = false)
        assertEquals(HubRemoval.REFUSED, UnsyncedNotesDiscardPolicy.hubRemoval(null, refused))
        assertEquals(HubRemoval.ACCOUNTS_UNREAD, UnsyncedNotesDiscardPolicy.hubRemoval(null, unread))
        assertNull(UnsyncedNotesDiscardPolicy.hubRemoval(null, clear))
        for (summary in listOf(Text.Counted(3), Text.Uncounted)) {
            for (section in listOf(refused, unread)) {
                assertNull("the stores' summary comes first: $summary",
                    UnsyncedNotesDiscardPolicy.hubRemoval(summary, section))
            }
        }
    }

    @Test fun `every outcome maps by the step that was confirmed`() {
        val more = UnsyncedNotes(3, 8, false, names = two.names + "c.note")
        val nowUnlisted = UnsyncedNotes(0, 8, unreadable = true, listed = false)
        for (retry in listOf(false, true)) {
            // A discard, confirmed for a store that listed.
            for (shown in listOf(two, uncounted)) {
                assertEquals(Result.Done, result(shown, DiscardOutcome.Done, retry))
                assertEquals("the dialog shows again for what is there now", Result.Ask(directory, "alice", more),
                    result(shown, DiscardOutcome.Changed(more), retry))
                assertEquals("nothing is there now", Result.Reload,
                    result(shown, DiscardOutcome.Changed(UnsyncedNotes.NOTHING), retry))
                val noLongerListed = if (retry) Result.NotFinished(directory, "alice", shown)
                else Result.Ask(directory, "alice", nowUnlisted)
                assertEquals("a store that can no longer be listed", noLongerListed,
                    result(shown, DiscardOutcome.Changed(nowUnlisted), retry))
                // A Retry that records no permit, or fails before the store deletes, deleted nothing itself, but the
                // attempt before it may have: it is not finished either, and keeps Retry.
                val nothingNow = if (retry) Result.NotFinished(directory, "alice", shown) else Result.NothingDeleted
                assertEquals(nothingNow, result(shown, DiscardOutcome.PermitNotRecorded, retry))
                assertEquals(Result.NotFinished(directory, "alice", shown),
                    result(shown, DiscardOutcome.NotFinished, retry))
                assertEquals(Result.Acknowledged, result(shown, DiscardOutcome.Acknowledged, retry))
                assertEquals(Result.AcknowledgementNotRecorded,
                    result(shown, DiscardOutcome.AcknowledgementNotRecorded, retry))
                assertEquals(nothingNow, failed(shown, Failure.BEFORE_DISCARD, retry))
                assertEquals("where it stopped is unknown", Result.NotFinished(directory, "alice", shown),
                    failed(shown, Failure.UNKNOWN, retry))
                assertEquals("a store not matched to an account keeps that", Result.NotFinished(directory, null, shown),
                    failed(shown, Failure.UNKNOWN, retry, label = null))
            }

            // An acknowledgement, confirmed for a store that could not be listed: nothing on its way says discard,
            // deleted or not finished.
            assertEquals(Result.Acknowledged, result(unlisted, DiscardOutcome.Acknowledged, retry))
            assertEquals(Result.AcknowledgementNotRecorded,
                result(unlisted, DiscardOutcome.AcknowledgementNotRecorded, retry))
            assertEquals("once it lists, a fresh discard with the real count", Result.Ask(directory, "alice", more),
                result(unlisted, DiscardOutcome.Changed(more), retry))
            assertEquals(Result.Ask(directory, "alice", nowUnlisted),
                result(unlisted, DiscardOutcome.Changed(nowUnlisted), retry))
            assertEquals(Result.Reload, result(unlisted, DiscardOutcome.Changed(UnsyncedNotes.NOTHING), retry))
            for (failure in Failure.values()) {
                assertEquals("$failure", Result.AcknowledgementNotRecorded, failed(unlisted, failure, retry))
            }
            // After an acknowledgement the store never gives Done or PermitNotRecorded, and NotFinished only over a
            // store whose discard stopped, recording nothing; the screen then only reloads.
            for (outcome in listOf(DiscardOutcome.Done, DiscardOutcome.NotFinished, DiscardOutcome.PermitNotRecorded)) {
                assertEquals("$outcome", Result.Reload, result(unlisted, outcome, retry))
            }
        }
    }

    @Test fun `only a discard that did not finish offers Retry`() {
        val all = listOf(
            Result.Done, Result.Ask(directory, null, two), Result.Reload, Result.NothingDeleted,
            Result.NotFinished(directory, null, two), Result.Acknowledged, Result.AcknowledgementNotRecorded,
        )
        assertEquals(listOf<Result>(Result.NotFinished(directory, null, two)),
            all.filter(UnsyncedNotesDiscardPolicy::offersRetry))
        assertTrue(UnsyncedNotesDiscardPolicy.offersRetry(Result.NotFinished(directory, "alice", uncounted)))
    }

    // ---- the screen's words (placeholders for review) ----

    @Test fun `the acknowledgement never says discard and says nothing is deleted`() {
        // The dialog's own words: a title and a button reused from the sign-out dialogs, and a message of its own.
        val shown = Regex("R\\.string\\.(\\w+)").findAll(branch(Step.ACKNOWLEDGE)).map { it.groupValues[1] }.toList()
        assertEquals(listOf("notes_acknowledge_title", "notes_store_acknowledge_text", "notes_acknowledge_continue"),
            shown)
        // And every result an acknowledgement can lead to: a message of one of two, or none (the dialog again, or a
        // reload).
        val reachable = (endings.map { result(unlisted, it) } + Failure.values().map { failed(unlisted, it) })
            .mapNotNull(UnsyncedNotesDiscardPolicy::message).toSet()
        assertEquals(setOf(R.string.notes_acknowledged, R.string.notes_acknowledgement_not_recorded), reachable)
        val words = (shown + listOf("notes_acknowledged", "notes_acknowledgement_not_recorded")).map(::stringText)
        for (text in words) {
            assertFalse("never called a discard: $text", text.contains("discard", ignoreCase = true))
            assertFalse("nothing is said to be removed: $text", text.contains("remove", ignoreCase = true))
            // The title reused from the sign-out dialogs says "without deleting", the message that nothing is deleted,
            // and the results that this attempt deleted no Notes text; nothing else names a deletion.
            val rest = text.replace(Regex("(?i)nothing (is|will be) deleted"), "").replace("without deleting", "")
                .replace("This attempt deleted no Notes text", "")
            assertFalse("nothing is said to be deleted: $text", rest.contains("delet", ignoreCase = true))
            assertFalse("no recovery is promised: $text",
                text.contains("recover", ignoreCase = true) || text.contains("asked again"))
            assertFalse(text, text.contains("sign", ignoreCase = true))
        }
        for (name in listOf("notes_store_acknowledge_text", "notes_acknowledged",
                "notes_acknowledgement_not_recorded")) {
            val text = stringText(name)
            assertTrue(text, text.contains("may remain on this device") && text.contains("may no longer sync"))
        }
        assertTrue(stringText("notes_store_acknowledge_text").contains("nothing is deleted"))
        // The results speak for this attempt alone: an earlier confirmed discard of the store may have deleted part
        // of it, as before a restart.
        for (name in listOf("notes_acknowledged", "notes_acknowledgement_not_recorded")) {
            val text = stringText(name)
            assertTrue(text, text.startsWith("This attempt deleted no Notes text"))
            assertFalse("does not deny deletion in an earlier attempt: $text",
                text.contains("nothing was deleted", ignoreCase = true))
        }
    }

    @Test fun `only the Discard button confirms a discard, and the acknowledgement has a button of its own`() {
        assertTrue("the step comes from the answer the dialog shows",
            dialog.contains("when (UnsyncedNotesDiscardPolicy.step(shown)) {"))
        assertTrue(branch(Step.DISCARD).contains(".setPositiveButton(R.string.notes_discard) { _, _ -> confirm() }"))
        assertTrue(branch(Step.ACKNOWLEDGE).contains(
            ".setPositiveButton(R.string.notes_acknowledge_continue) { _, _ -> confirm() }"))
        assertEquals("one confirming button per step", 2, Regex("\\.setPositiveButton\\(").findAll(dialog).count())
        assertEquals("the word Discard is named once", 1,
            Regex("R\\.string\\.notes_discard\\b").findAll(dialog).count())
        assertEquals("one place sends a confirmation", 1, Regex("model\\.answer\\(").findAll(dialog).count())
        assertTrue(body(dialog, "fun confirm() {", "        ")
            .contains("model.answer(directory, label, shown, shownIn)"))
    }

    @Test fun `Cancel and Back send nothing`() {
        assertEquals("one Cancel, with no listener, for both steps", 1,
            dialog.split(".setNegativeButton(android.R.string.cancel, null)").size - 1)
        assertFalse("Back and a tap outside cancel the dialog, and nothing hears of it",
            dialog.contains("onCancel", ignoreCase = true))
        assertFalse(dialog.contains("onDismiss", ignoreCase = true))
    }

    @Test fun `a counted discard names the count and the account, and none shows 0`() {
        for (text in pluralTexts("notes_discard_store_text")) {
            assertTrue(text, text.startsWith("%1\$d ") && text.contains(" from %2\$s ") && text.contains("deleted"))
        }
        val uncountedText = stringText("notes_discard_store_uncounted")
        assertTrue(uncountedText, uncountedText.contains(" from %1\$s ") && !uncountedText.contains("%d"))
        for (text in pluralTexts("notes_store_unsynced") + pluralTexts("settings_unsynced_notes_summary")) {
            assertTrue(text, text.startsWith("%d "))
        }
        val fragment = source("UnsyncedNotesFragment.kt")
        assertTrue("the dialog's count is the policy's", branch(Step.DISCARD).contains(
            "resources.getQuantityString(R.plurals.notes_discard_store_text, text.count, text.count, name)"))
        assertTrue(dialog.contains("val text = UnsyncedNotesSignOutPolicy.text(shown)"))
        assertTrue(dialog.contains("val name = label ?: getString(R.string.notes_store_unmatched_name)"))
        assertTrue("a row's", fragment.contains("UnsyncedNotesDiscardPolicy.rowText(row.answer)") &&
            fragment.contains("getQuantityString(R.plurals.notes_store_unsynced, text.count, text.count)"))
        assertTrue("the hub row's", fragment.contains("UnsyncedNotesDiscardPolicy.hubSummary(listing)") &&
            fragment.contains(
                "getQuantityString(R.plurals.settings_unsynced_notes_summary, summary.count, summary.count)"))
        assertTrue("the hub row's removal text", fragment.contains(
            "UnsyncedNotesStores.read(app) to NotesRemovalSection.read(app)") &&
            fragment.contains("row.isVisible = summary != null || removalOnly != null") &&
            fragment.contains(
                "HubRemoval.REFUSED -> fragment.getString(R.string.settings_unsynced_notes_removal)") &&
            fragment.contains(
                "HubRemoval.ACCOUNTS_UNREAD -> fragment.getString(R.string.settings_unsynced_notes_accounts)"))
        // Each count shown comes only from a Counted text, which never holds 0.
        val counts = Regex("getQuantityString\\(R\\.plurals\\.\\w+, (\\w+\\.count), (\\w+\\.count)")
            .findAll(fragment).map { it.groupValues[1] to it.groupValues[2] }.toList()
        assertEquals(listOf("text.count" to "text.count", "summary.count" to "summary.count",
            "text.count" to "text.count"), counts)
        assertEquals(3, Regex("getQuantityString\\(").findAll(fragment).count())
    }

    @Test fun `the not-finished Snackbar is indefinite and carries Retry`() {
        val fragment = source("UnsyncedNotesFragment.kt")
        assertTrue(fragment.contains(
            "Snackbar.make(view, R.string.notes_discard_not_finished, Snackbar.LENGTH_INDEFINITE)\n" +
                "                    .setAction(R.string.retry) { model.retry(result) }"))
        assertTrue("the others are short",
            fragment.contains("Snackbar.make(view, message, Snackbar.LENGTH_LONG).show()"))
        // The third is the removal section's, also short, with room for an account name before its words. It takes the
        // place of a held Retry, which shows again once it goes, unless another Snackbar took its place.
        assertTrue(fragment.contains("Snackbar.make(view, text, Snackbar.LENGTH_LONG).setTextMaxLines(4)\n"))
        val removal = body(fragment, "private fun showRemoval(text: String) {")
        assertTrue(removal, removal.contains(
            "event != Snackbar.Callback.DISMISS_EVENT_CONSECUTIVE && held is Result.NotFinished &&\n" +
                "                        this@UnsyncedNotesFragment.view === view) showResult(held)"))
        assertTrue(removal, removal.contains("val held = model.result.value"))
        assertEquals(3, Regex("Snackbar\\.make\\(").findAll(fragment).count())
        assertEquals(R.string.notes_discard_not_finished,
            UnsyncedNotesDiscardPolicy.message(Result.NotFinished(directory, null, two)))
        assertEquals(R.string.notes_discard_done, UnsyncedNotesDiscardPolicy.message(Result.Done))
        assertEquals(R.string.notes_discard_nothing_deleted, UnsyncedNotesDiscardPolicy.message(Result.NothingDeleted))
        assertNull(UnsyncedNotesDiscardPolicy.message(Result.Reload))
        assertNull(UnsyncedNotesDiscardPolicy.message(Result.Ask(directory, null, two)))
        assertTrue(stringText("notes_discard_not_finished").contains("may already be deleted"))
        val nothingDeleted = stringText("notes_discard_nothing_deleted")
        assertTrue(nothingDeleted, nothingDeleted.contains("This attempt deleted no Notes text."))
        assertFalse("does not deny deletion in an earlier attempt: $nothingDeleted",
            nothingDeleted.contains("nothing was deleted", ignoreCase = true))
        // The bar sits in the activity's content view, so leaving the screen must take it away, or its Retry would
        // stay over the next screen with nothing behind it.
        assertTrue("leaving the screen dismisses the bar", body(fragment, "override fun onDestroyView() {")
            .contains("retryBar?.dismiss()\n        retryBar = null"))
    }

    @Test fun `a row opens nothing while a confirmation runs, nor for a store whose discard did not finish`() {
        val other = "fedcba9876543210".repeat(4)
        val held = Result.NotFinished(directory, "alice", two)
        // Only Retry goes on: the row never leads from "may already be deleted" to an acknowledgement, also once the
        // store cannot be listed.
        assertTrue(UnsyncedNotesDiscardPolicy.notFinished(directory, held))
        assertFalse(UnsyncedNotesDiscardPolicy.rowOpens(directory, held, answering = false))
        assertFalse(UnsyncedNotesDiscardPolicy.notFinished(other, held))
        assertTrue("another store's row opens", UnsyncedNotesDiscardPolicy.rowOpens(other, held, answering = false))
        // While a confirmation runs, no row opens another, so none is dropped unseen.
        for (h in listOf(null, held)) {
            assertFalse("$h", UnsyncedNotesDiscardPolicy.rowOpens(directory, h, answering = true))
            assertFalse("$h", UnsyncedNotesDiscardPolicy.rowOpens(other, h, answering = true))
        }
        for (h in listOf(null, Result.Done, Result.Ask(directory, null, two), Result.Reload, Result.NothingDeleted,
                Result.Acknowledged, Result.AcknowledgementNotRecorded)) {
            assertTrue("$h", UnsyncedNotesDiscardPolicy.rowOpens(directory, h, answering = false))
            assertFalse("$h", UnsyncedNotesDiscardPolicy.notFinished(directory, h))
        }

        // The screen words that row as not finished, with no action, and asks again at the tap, from what it holds
        // then, since the rows are read again only after a result.
        val fragment = source("UnsyncedNotesFragment.kt")
        val rows = body(fragment, "private fun showListing(listing: UnsyncedNotesListing) {")
        assertTrue(rows.contains(
            "val stopped = UnsyncedNotesDiscardPolicy.notFinished(row.directory, model.result.value)"))
        assertTrue(rows.contains(
            "summary = if (stopped) {\n                getString(R.string.notes_discard_not_finished)"))
        assertTrue(rows.contains("isEnabled = answer != null && !stopped"))
        val click = rows.substringAfter("setOnPreferenceClickListener {", "")
        val asks = click.indexOf("rowOpens(row.directory, model.result.value, model.answering)")
        assertTrue(click, asks >= 0 && asks < click.indexOf("ask(row.directory, row.owner?.name, answer)"))
        assertEquals("no other row asks", 1, Regex("\\bask\\(row\\.").findAll(fragment).count())
        // One dialog per store and step, so one store's open dialog never stands in for another's.
        assertTrue(fragment.contains("internal fun tag(step: Step, directory: String) = " +
            "\"unsynced-notes-store-\" + step.name + \":\" + directory"))
        assertTrue(fragment.contains("DiscardDialogFragment.tag(UnsyncedNotesDiscardPolicy.step(shown), directory)"))
    }

    @Test fun `the row of a store whose discard stopped is its Retry, and never a new step for that store`() {
        val fragment = source("UnsyncedNotesFragment.kt")
        val rows = body(fragment, "private fun showListing(listing: UnsyncedNotesListing) {")
        // Its words: the screen's while it holds that result, else the store's own, which say that a tap goes on.
        val held = rows.indexOf(
            "summary = if (stopped) {\n                getString(R.string.notes_discard_not_finished)\n")
        val own = rows.indexOf("} else if (row.stopped && row.answer != null) {\n" +
            "                getString(R.string.notes_discard_not_finished_row)\n")
        // A stopped store whose read threw says so too, with no Retry: with no answer, its row is not enabled.
        val unread = rows.indexOf("} else if (row.stopped) {\n" +
            "                getString(R.string.notes_discard_not_finished)\n")
        assertTrue(rows, held >= 0 && own > held && unread > own)
        assertEquals(stringText("notes_discard_not_finished") + " Tap to try again.",
            stringText("notes_discard_not_finished_row"))
        // Its tap, asked again at the tap and only while a row opens anything: the Retry, never ask().
        val click = rows.substringAfter("setOnPreferenceClickListener {", "")
        val opens = click.indexOf(
            "if (UnsyncedNotesDiscardPolicy.rowOpens(row.directory, model.result.value, model.answering)) {")
        val retries = click.indexOf("if (row.stopped) model.retryStopped(row.directory, row.owner?.name)\n" +
            "                    else ask(row.directory, row.owner?.name, answer)")
        assertTrue(click, opens >= 0 && retries > opens)
        val model = body(fragment, "internal class UnsyncedNotesViewModel", "")
        assertTrue("an answer of nothing, as a Retry", model.contains(
            "fun retryStopped(directory: String, label: String?) =\n" +
                "        discard(directory, label, UnsyncedNotes.NOTHING, retry = true)"))
        // The hub row of a stopped store that counts nothing shows, and says that not all could be counted.
        assertEquals(Text.Uncounted, UnsyncedNotesDiscardPolicy.hubSummary(
            UnsyncedNotesListing(listOf(row(UnsyncedNotes.NOTHING, stopped = true)), false, false)))
    }

    @Test fun `an answer from a dialog made in another process counts again, and discards and says nothing`() {
        val alice = ExactAccountIdentity("io.silentsuite", "alice", "gen-1")
        for (answer in listOf(two, uncounted, unlisted, UnsyncedNotes.NOTHING, null)) {
            for (stopped in listOf(false, true)) {
                val next = UnsyncedNotesDiscardPolicy.restored(row(answer, alice, stopped))
                val asks = !stopped && answer != null && answer.anything
                assertEquals("$answer, stopped $stopped",
                    if (asks) Result.Ask(directory, "alice", answer!!) else Result.Reload, next)
                assertNull("$answer, stopped $stopped", UnsyncedNotesDiscardPolicy.message(next))
                assertFalse(UnsyncedNotesDiscardPolicy.offersRetry(next))
            }
        }
        assertEquals("the count again, made in this process", Result.Ask(directory, "alice", two),
            UnsyncedNotesDiscardPolicy.restored(row(two, alice)))
        assertEquals("the acknowledgement again, for a store still unlisted", Result.Ask(directory, "alice", unlisted),
            UnsyncedNotesDiscardPolicy.restored(row(unlisted, alice)))
        assertEquals("a store whose discard stopped: its row is the Retry", Result.Reload,
            UnsyncedNotesDiscardPolicy.restored(row(two, alice, stopped = true)))
        assertEquals("a read that threw", Result.Reload, UnsyncedNotesDiscardPolicy.restored(row(null, alice)))
        assertEquals("a store not matched to an account", Result.Ask(directory, null, two),
            UnsyncedNotesDiscardPolicy.restored(row(two)))
    }

    @Test fun `the Settings dialog carries this process's token, and only its answers reach the store`() {
        val fragment = source("UnsyncedNotesFragment.kt")
        assertTrue("every dialog is made with this process's token",
            body(dialog, "internal fun newInstance(", "        ")
                .contains("putString(ARG_PROCESS, ProcessIncarnation.current())"))
        assertTrue("it is read as given, null for a dialog with none",
            dialog.contains("val shownIn = args.getString(ARG_PROCESS)\n"))
        assertFalse("a dialog with none is not taken as this process's", dialog.contains("getString(ARG_PROCESS)!!"))
        assertTrue(dialog.contains("internal const val ARG_PROCESS = \"unsyncedNotes.process\""))
        assertTrue("and sent with its confirmation",
            body(dialog, "fun confirm() {", "        ").contains("model.answer(directory, label, shown, shownIn)"))

        val model = body(fragment, "internal class UnsyncedNotesViewModel", "")
        val signature = "fun answer(directory: String, label: String?, shown: UnsyncedNotes, shownIn: String?) {"
        assertTrue("the model takes it with no default", model.contains(signature))
        assertTrue("and compares it once, before anything reaches the store", body(model, signature).contains(
            "if (ProcessIncarnation.isCurrent(shownIn)) discard(directory, label, shown, retry = false)\n" +
                "        else countAgain(directory)"))
        assertTrue(model.contains(
            "private fun discard(directory: String, label: String?, shown: UnsyncedNotes, retry: Boolean) {"))
        assertTrue("a Retry needs no token", model.contains("fun retry(notFinished: Result.NotFinished) =\n" +
            "        discard(notFinished.directory, notFinished.label, notFinished.shown, retry = true)"))
        val again = body(model, "private fun countAgain(directory: String) {")
        assertTrue(again, again.contains("UnsyncedNotesStores.reread(getApplication(), directory)") &&
            again.contains("UnsyncedNotesDiscardPolicy.restored(now)"))
        assertFalse("it discards nothing", again.contains("discard(") || again.contains("answer("))
    }

    @Test fun `a Settings dialog that has sent its confirmation does not hold back its step`() {
        val fragment = source("UnsyncedNotesFragment.kt")
        assertTrue("only the dialog sets it", dialog.contains("internal var ended = false\n        private set"))
        val confirm = body(dialog, "fun confirm() {", "        ")
        assertTrue(confirm, confirm.indexOf("ended = true") in 0 until confirm.indexOf("model.answer("))
        assertEquals("and nothing else sets it", 1, fragment.split("ended = true").size - 1)
        val ask = body(fragment, "private fun ask(directory: String, label: String?, shown: UnsyncedNotes): Boolean {")
        assertTrue("the screen counts a dialog of the step as open only while it has not ended", ask.contains(
            "val open = childFragmentManager.findFragmentByTag(tag) as? UnsyncedNotesDiscardDialogFragment\n" +
                "        if (open == null || open.ended) {"))
        assertFalse("not any dialog it finds", ask.contains("findFragmentByTag(tag) == null"))
    }
}
