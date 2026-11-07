package io.silentsuite.sync.ui

import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.NotesFolderListings
import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.notes.edit.PendingNotesDiscardPermits
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.DiscardOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import io.silentsuite.sync.ui.NotesRemovalAllowance.FolderStat
import io.silentsuite.sync.ui.NotesRemovalAllowance.Fingerprint
import io.silentsuite.sync.ui.NotesRemovalAllowance.Key
import io.silentsuite.sync.ui.NotesRemovalOffer.Outcome
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Cause
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.CreationId
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Row
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.ui.setup.AccountCreationRegistry
import io.silentsuite.sync.ui.setup.AccountCreationRegistry.Phase
import io.silentsuite.sync.utils.AccountRowChanges
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest

/**
 * The confirmation for an account whose Notes files cannot be checked, below its dialog: when it is offered, what the
 * tap does, and what the removal's callback reports. The guard, the registry, the folders' stats and the account rows
 * are the test's own.
 */
class NotesRemovalOfferTest {
    @get:Rule val tmp = TemporaryFolder()

    private val rows = AccountRowChanges()
    private var folderCount = 0L

    /** The allowance's clock, in milliseconds since boot; it stands still unless a test moves it. */
    private var now = 0L
    private var ids = 0
    private val allowance = NotesRemovalAllowance(rows, { folderCount }, { now }, { "shown-${++ids}" })

    /** Every reading and step the offer asked for, in order. */
    private val asked = ArrayList<String>()

    private var decision = Decision(Verdict.ROOT_UNLISTABLE_ONLY, creationId = null)

    /** Runs inside the guard's reads, as an add or removal elsewhere could. */
    private var duringDecision: () -> Unit = {}
    private var records: List<AccountCreationRegistry.Record>? = emptyList()
    private val pending = Fingerprint(mapOf(Folder.PENDING to FolderStat.Stat(1, 2, 3, 4)))
    private var present: Boolean? = false
    private val cleared = ArrayList<String>()

    /** The callback of the removal the button started, which the test runs. */
    private var removal: (() -> Unit)? = null

    private val offer = NotesRemovalOffer(TYPE, allowance, object : NotesRemovalOffer.Seams {
        override fun decision(type: String, name: String): Decision {
            asked += "decision $name"
            duringDecision()
            return decision
        }
        override fun records(): List<AccountCreationRegistry.Record>? = records.also { asked += "records" }
        override fun fingerprint(decision: Decision): Fingerprint {
            val reason = decision.verdict.reason.orEmpty()
            asked += "fingerprint $reason" + if (decision.unknown.isEmpty()) "" else " ${decision.unknown}"
            return if (reason.isEmpty()) Fingerprint(emptyMap()) else pending.copy(names = decision.unknown)
        }
        override fun remove(type: String, name: String, removed: () -> Unit) {
            asked += "remove $name"
            removal = removed
        }
        override fun present(type: String, name: String): Boolean? = present.also { asked += "present $name" }
        override fun clearRecord(type: String, name: String, creationId: String): Boolean {
            cleared += "$name $creationId"
            return true
        }
    })

    @After fun reset() {
        NotesRemovalOffer.afterMintForTesting = null
        PendingNotesStore.identityForTesting = null
        PendingNotesStore.resetForTesting()
    }

    private fun record(name: String, phase: Phase) = AccountCreationRegistry.Record(name, "gen-$name", phase, 1, TYPE)

    @Test fun `it is offered only for the main account type, an eligible verdict, and no creation in progress`() {
        assertNull(offer.show("io.silentsuite.address_book", "b"))
        assertEquals("nothing is read for another type", emptyList<String>(), asked)
        for (refused in Verdict.entries.filterNot { it.eligible }) {
            decision = Decision(refused, null)
            assertNull("$refused", offer.show(TYPE, "b"))
        }
        decision = Decision(Verdict.ROOT_UNLISTABLE_ONLY, null)
        for (phase in listOf(Phase.PREPARED, Phase.CREATING)) {
            records = listOf(record("b", phase))
            assertNull("$phase", offer.show(TYPE, "b"))
        }
        records = listOf(record("b", Phase.PREPARED).copy(accountType = "other.type"), record("c", Phase.CREATING),
            record("b", Phase.RECOVERY_REQUIRED).copy(accountName = "b2"))
        assertNotNull("another type's or another name's record does not stop it", offer.show(TYPE, "b"))
        records = null
        val shown = offer.show(TYPE, "b")!!
        assertEquals("a registry that cannot be read does not stop it", Key(TYPE, "b", null), shown.key)
        assertEquals(setOf(Cause.PENDING_UNLISTED), shown.reason)
        // Each reason binds its own row, and its reason reaches the fingerprint. The guard gives no eligible verdict to
        // a row whose creation id reads.
        for (verdict in listOf(Verdict.PERMITS_UNLISTABLE_ONLY, Verdict.BOTH_UNLISTABLE_ONLY)) {
            decision = Decision(verdict, null)
            asked.clear()
            val bound = offer.show(TYPE, "d")!!
            assertEquals("$verdict", Key(TYPE, "d", null), bound.key)
            assertEquals(verdict.reason, bound.reason)
            assertEquals("fingerprint ${verdict.reason}", asked.last())
        }
    }

    @Test fun `a decision that read a creation id shows nothing, whatever its verdict`() {
        for (verdict in Verdict.entries.filter { it.eligible }) {
            decision = Decision(verdict, creationId = "gen-b")
            assertNull("$verdict", offer.show(TYPE, "b"))
        }
    }

    @Test fun `the counts are read before the guard reads any account, so a change during its reads fails the tap`() {
        duringDecision = { rows.before() }
        val shown = offer.show(TYPE, "b")!!
        assertEquals(listOf("decision b", "records", "fingerprint [PENDING_UNLISTED]"), asked)
        duringDecision = {}
        asked.clear()
        offer.confirm(TYPE, "b", shown.id) { asked += "done $it" }
        assertEquals(listOf("decision b", "records", "fingerprint [PENDING_UNLISTED]", "done CHANGED"), asked)
        assertNull(removal)
    }

    @Test fun `a tap mints, runs the seam, starts the removal, and reports removed once the row is gone`() {
        records = listOf(record("b", Phase.RECOVERY_REQUIRED), record("c", Phase.RECOVERY_REQUIRED))
        val shown = offer.show(TYPE, "b")!!
        NotesRemovalOffer.afterMintForTesting = { asked += "after mint" }
        asked.clear()
        val outcomes = ArrayList<Outcome>()
        offer.confirm(TYPE, "b", shown.id) { outcomes += it }
        assertEquals(listOf("decision b", "records", "fingerprint [PENDING_UNLISTED]", "after mint", "remove b"), asked)
        assertEquals("nothing reported before the removal's callback", emptyList<Outcome>(), outcomes)
        assertTrue("the slot is there for the authenticator", allowance.answer(Key(TYPE, "b", null),
            Verdict.ROOT_UNLISTABLE_ONLY, pending))
        removal!!()
        assertEquals(listOf(Outcome.REMOVED), outcomes)
        assertEquals("only the record the confirmation saw, compared by its own id", listOf("b gen-b"), cleared)
    }

    @Test fun `a row still there after the callback is a retry, and a row list that cannot be read says so`() {
        records = listOf(record("b", Phase.RECOVERY_REQUIRED))
        // A list that cannot be read is no proof that nothing was removed.
        for ((stillThere, outcome) in listOf(true to Outcome.RETRY, null to Outcome.UNKNOWN)) {
            val outcomes = ArrayList<Outcome>()
            offer.confirm(TYPE, "b", offer.show(TYPE, "b")!!.id) { outcomes += it }
            present = stillThere
            removal!!()
            assertEquals("$stillThere", listOf(outcome), outcomes)
        }
        assertEquals("nothing cleared", emptyList<String>(), cleared)
        // Removed by another caller in the meantime is still reported removed; with no record seen, none is cleared.
        records = emptyList()
        val outcomes = ArrayList<Outcome>()
        offer.confirm(TYPE, "b", offer.show(TYPE, "b")!!.id) { outcomes += it }
        present = false
        removal!!()
        assertEquals(listOf(Outcome.REMOVED), outcomes)
        assertEquals(emptyList<String>(), cleared)
    }

    @Test fun `a tap that cannot mint starts no removal, and says why`() {
        fun tap(change: () -> Unit): Outcome {
            decision = Decision(Verdict.ROOT_UNLISTABLE_ONLY, null)
            records = emptyList()
            val shown = offer.show(TYPE, "b")!!
            change()
            val outcomes = ArrayList<Outcome>()
            removal = null
            offer.confirm(TYPE, "b", shown.id) { outcomes += it }
            assertNull("no removal started", removal)
            return outcomes.single()
        }
        assertEquals("a listing of the folder since it showed", Outcome.READABLE, tap { folderCount++ })
        assertEquals(Outcome.CHANGED, tap { rows.before() })
        assertEquals("the row's id reads now", Outcome.CHANGED,
            tap { decision = Decision(Verdict.ROOT_UNLISTABLE_ONLY, "gen-new") })
        assertEquals("a creation of that name started", Outcome.CHANGED,
            tap { records = listOf(record("b", Phase.PREPARED)) })
        val other = Key(TYPE, "d", null)
        var since: String? = null
        assertEquals("another confirmation since", Outcome.CHANGED,
            tap { since = allowance.show(allowance.counts(), other, Verdict.ROOT_UNLISTABLE_ONLY, pending, null)!!.id })
        assertNotNull("and the tap on the old one leaves it showing", allowance.shown(since!!))
        assertEquals(Outcome.RETRY, tap { decision = Decision(Verdict.REFUSE_STORE, null) })
    }

    @Test fun `the two minutes count from the time the tap hands over, not from when the offer starts`() {
        val shown = offer.show(TYPE, "b")!!
        // The tap at 0 waited on another thread until 130 seconds; the offer's own work takes no time.
        now = 130_000
        val outcomes = ArrayList<Outcome>()
        offer.confirm(TYPE, "b", shown.id, 0) { outcomes += it }
        assertNull("no removal started", removal)
        assertEquals(listOf(Outcome.RETRY), outcomes)
    }

    @Test fun `a creation that started before the tap ends the confirmation`() {
        val shown = offer.show(TYPE, "b")!!
        records = listOf(record("b", Phase.PREPARED))
        val outcomes = ArrayList<Outcome>()
        offer.confirm(TYPE, "b", shown.id) { outcomes += it }
        assertEquals(listOf(Outcome.CHANGED), outcomes)
        assertNull("the tap used it up", allowance.shown(shown.id))
    }

    @Test fun `confirmation work that runs past two minutes from the tap starts no removal and leaves no allowance`() {
        val shown = offer.show(TYPE, "b")!!
        val before = rows.count()
        // The tap at 0, and the guard's reads at the tap take 130 seconds, with nothing else changing.
        duringDecision = { now += 130_000 }
        val outcomes = ArrayList<Outcome>()
        offer.confirm(TYPE, "b", shown.id) { outcomes += it }
        duringDecision = {}
        assertNull("no removal started", removal)
        assertEquals(listOf(Outcome.RETRY), outcomes)
        assertEquals("the row counter did not move", before, rows.count())
        assertFalse("and the authenticator gets no allowance", allowance.answer(Key(TYPE, "b", null),
            Verdict.ROOT_UNLISTABLE_ONLY, pending))
    }

    @Test fun `the allowance a tap makes ends two minutes after the tap, not after its confirmation work`() {
        // The tap at 0, a minute of work, and the answer just under two minutes after the tap: it holds.
        var shown = offer.show(TYPE, "b")!!
        duringDecision = { now += 60_000 }
        offer.confirm(TYPE, "b", shown.id) {}
        duringDecision = {}
        assertNotNull("within two minutes of the tap, the removal starts", removal)
        now = 119_999
        assertTrue(allowance.answer(Key(TYPE, "b", null), Verdict.ROOT_UNLISTABLE_ONLY, pending))
        // The tap at 200 s, a minute of work, and the answer two minutes after the tap, one after the work: it does not.
        now = 200_000
        removal = null
        shown = offer.show(TYPE, "b")!!
        duringDecision = { now += 60_000 }
        offer.confirm(TYPE, "b", shown.id) {}
        duringDecision = {}
        assertNotNull(removal)
        now = 320_000
        assertFalse("two minutes from the tap, though one from the end of its work", allowance.answer(
            Key(TYPE, "b", null), Verdict.ROOT_UNLISTABLE_ONLY, pending))
    }

    @Test fun `names of an unknown kind bind their row and the guard's own names, and outlast its listings`() {
        val names = listOf("FUTURE", "future.dat")
        decision = Decision(Verdict.UNKNOWN_KIND_ONLY, null, names)
        val shown = offer.show(TYPE, "b")!!
        assertEquals(Key(TYPE, "b", null), shown.key)
        assertEquals(setOf(Cause.PENDING_UNKNOWN_KIND), shown.reason)
        assertEquals("the fingerprint is the decision's own", "fingerprint [PENDING_UNKNOWN_KIND] $names", asked.last())
        // The guard's own listing at the tap moves notes-pending's counter, which binds nothing here.
        folderCount++
        val outcomes = ArrayList<Outcome>()
        offer.confirm(TYPE, "b", shown.id) { outcomes += it }
        assertEquals("remove b", asked.last())
        folderCount++
        assertTrue(allowance.answer(Key(TYPE, "b", null), Verdict.UNKNOWN_KIND_ONLY, pending.copy(names = names)))
        // Other names at the tap than at the show start nothing.
        val next = offer.show(TYPE, "b")!!
        decision = Decision(Verdict.UNKNOWN_KIND_ONLY, null, listOf("future.dat"))
        removal = null
        offer.confirm(TYPE, "b", next.id) { outcomes += it }
        assertNull(removal)
        assertEquals(listOf(Outcome.RETRY), outcomes)
    }

    @Test fun `a fingerprint takes the stat of each folder of its reason, and for unknown names the lstat of each`() {
        val noBackup = File("no_backup")
        val pendingFolder = File(noBackup, PendingNotesStore.PENDING)
        val statted = ArrayList<String>()
        val lstatted = ArrayList<String>()
        val stat = { f: File -> statted += f.path; FolderStat.Stat(1, statted.size.toLong(), 0x41c0, 0) }
        val lstat = { f: File -> lstatted += f.path; FolderStat.Failed(2) }
        val names = listOf("FUTURE", "future.dat")
        val printed = NotesRemovalOffer.fingerprint(noBackup, Decision(Verdict.UNKNOWN_KIND_ONLY, null, names),
            stat, lstat)
        assertEquals("notes-pending's stat alone", listOf(pendingFolder.path), statted)
        assertEquals("each name's lstat, which follows no link", names.map { File(pendingFolder, it).path }, lstatted)
        assertEquals(Fingerprint(mapOf(Folder.PENDING to FolderStat.Stat(1, 1, 0x41c0, 0)), names,
            names.associateWith { FolderStat.Failed(2) }), printed)
        // The other reasons take the stat of their folders alone, never an entry's; a verdict that is not eligible
        // takes none, though its decision named entries of an unknown kind.
        for (verdict in listOf(Verdict.ROOT_UNLISTABLE_ONLY, Verdict.PERMITS_UNLISTABLE_ONLY,
                Verdict.BOTH_UNLISTABLE_ONLY, Verdict.REFUSE_UNKNOWN_KIND)) {
            statted.clear()
            lstatted.clear()
            val other = NotesRemovalOffer.fingerprint(noBackup, Decision(verdict, null, names), stat, lstat)
            assertEquals("$verdict", verdict.reason.orEmpty().map { File(noBackup, it.folder.folderName).path },
                statted)
            assertEquals("$verdict", emptyList<String>(), lstatted)
            assertEquals("$verdict", Fingerprint(other.stats), other)
        }
    }

    // ---- a confirmed removal on real files ----

    /** Replaces the target in one step on Windows too, as in PendingNotesStoreTest. */
    private val atomicMove: (File, File) -> Unit = { from, to ->
        Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    /**
     * A stat for the JVM, which cannot call Os, by nio: for an lstat, the device and inode where it has a unix view;
     * otherwise 0.
     */
    private fun nioStat(path: File, follow: Boolean): FolderStat = try {
        val options = if (follow) emptyArray() else arrayOf(LinkOption.NOFOLLOW_LINKS)
        val attributes = Files.readAttributes(path.toPath(), BasicFileAttributes::class.java, *options)
        val identity = if (follow) null else PendingNotesStore.nioIdentity(path)
        FolderStat.Stat(identity?.device ?: 0, identity?.inode ?: 0, if (attributes.isDirectory) 0x4000 else 0x8000,
            attributes.lastModifiedTime().toMillis())
    } catch (e: java.io.IOException) {
        FolderStat.Failed(2)
    }

    /**
     * What an entry of an unknown kind is, without following a link: for it and everything below it, by relative
     * path, the kind, the size, the modification time, the SHA-256 of a file's bytes, a folder's sorted names, a
     * link's target, and where this JVM has a unix view (none on Windows), the device and inode (the store's own lstat
     * helper) and the mode, change time and link count.
     */
    private fun identity(entry: Path): Map<String, List<Any?>> {
        val below = if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) Files.walk(entry).use { it.toList() }
        else listOf(entry)
        return below.sorted().associate { path ->
            val attributes = Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            val kind = when {
                attributes.isSymbolicLink -> "link " + Files.readSymbolicLink(path)
                attributes.isDirectory -> "folder " + path.toFile().list()!!.sorted()
                attributes.isRegularFile -> "file " + MessageDigest.getInstance("SHA-256")
                    .digest(Files.readAllBytes(path)).joinToString("") { "%02x".format(it) }
                else -> "other"
            }
            entry.relativize(path).toString() to listOf(kind, attributes.size(), attributes.lastModifiedTime(),
                PendingNotesStore.nioIdentity(path.toFile()), unixAttributes(path))
        }
    }

    /** The mode, change time and link count of [path], not following a link, where the JVM has a unix view. */
    private fun unixAttributes(path: Path): Map<String, Any?>? = try {
        Files.readAttributes(path, "unix:mode,ctime,nlink", LinkOption.NOFOLLOW_LINKS)
    } catch (e: UnsupportedOperationException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    } catch (e: java.io.IOException) {
        null
    }

    /** Every file and folder under [root], by relative path, with each file's bytes. */
    private fun tree(root: File) = root.walk().associate { f ->
        f.relativeTo(root).path to (if (f.isFile) f.readBytes().toList() else null)
    }

    @Test fun `a removal confirmed through the allowance leaves every entry of an unknown kind as it was`() {
        val noBackup = tmp.newFolder("no_backup")
        val pendingFolder = File(noBackup, PendingNotesStore.PENDING)
        fun store(name: String) = PendingNotesStore.forNoBackup(noBackup, TYPE, name, "gen-$name", {}, atomicMove)
        // A clean orphan, whose last change was pushed, and an orphan with a draft that its permit covers.
        val clean = store("clean")
        clean.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        assertEquals(SendOutcome.Done, clean.completeSend("n1", clean.beginSend("n1")!!.version, "r1",
            "landed".toByteArray()))
        val covered = store("covered")
        covered.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        covered.coverForTesting()
        // Entries of kinds this build does not know: a file of random bytes, a folder holding a file and a folder,
        // a folder named with 64 uppercase hex characters, and a link to a file outside no_backup where this JVM may
        // make one (Windows needs a privilege for it).
        File(pendingFolder, "future.dat").writeBytes(ByteArray(4096).also { java.util.Random(7).nextBytes(it) })
        assertTrue(File(pendingFolder, "FUTURE/deeper").mkdirs())
        File(pendingFolder, "FUTURE/inside.dat").writeBytes("inside".toByteArray())
        assertTrue(File(pendingFolder, "0123456789ABCDEF".repeat(4)).mkdir())
        val outside = tmp.newFile("outside.dat").also { it.writeBytes("outside".toByteArray()) }
        val linked = try {
            Files.createSymbolicLink(File(pendingFolder, "future-link").toPath(), outside.toPath())
            true
        } catch (e: java.io.IOException) {
            false
        } catch (e: UnsupportedOperationException) {
            false
        }
        val unknown = (listOf("future.dat", "FUTURE", "0123456789ABCDEF".repeat(4)) +
            if (linked) listOf("future-link") else emptyList()).sorted()
        // Where it can make links, a link with a store folder's name, to the folder of an unknown kind above, which a
        // discard through it would empty. It is acknowledged first, bound to the link's own identity, as lstat gives
        // one on a device: this JVM may have no unix view to read it from.
        val storeLink = PendingNotesStore.identityDir(noBackup, TYPE, "link", "gen-link")
        if (linked) {
            Files.createSymbolicLink(storeLink.toPath(), File(pendingFolder, "FUTURE").toPath())
            PendingNotesStore.identityForTesting = { d ->
                if (!Files.isSymbolicLink(d.toPath())) null
                else PendingNotesStore.DirectoryIdentity(device = 7, inode = 1)
            }
            val link = PendingNotesStore.forNoBackupDirectory(noBackup, storeLink.name, {}, atomicMove)
            assertEquals(DiscardOutcome.Acknowledged, link.discardStore(link.unsynced()))
        }
        val entries = unknown + if (linked) listOf(storeLink.name) else emptyList()
        PendingNotesStore.resetForTesting()
        fun identities() = entries.associateWith { identity(File(pendingFolder, it).toPath()) }
        val identitiesBefore = identities()
        val treeBefore = tree(noBackup)
        val outsideBefore = outside.readBytes().toList()

        // The offer over the real guard, given the maintainer's yes for these names, over this process's folder
        // counters, which the guard's own listings move at the show, the tap and the answer.
        val allowance = NotesRemovalAllowance(AccountRowChanges(), NotesFolderListings::count, { 0 }, { "shown" })
        val answers = ArrayList<Boolean>()
        var gone = false
        val seams = object : NotesRemovalOffer.Seams {
            override fun decision(type: String, name: String) = PendingNotesRemovalGuard.decision(
                PendingNotesRemovalGuard.input(noBackup, TYPE, type, name, CreationId.Unreadable,
                    accounts = { if (gone) emptyList() else listOf(Row(name, CreationId.Unreadable)) },
                    active = { null }, records = { emptyList() }, presence = PendingNotesStore.nioPresence,
                    open = { PendingNotesStore.forNoBackupDirectory(noBackup, it, {}, atomicMove) }),
                Verdict.UNKNOWN_KIND_ONLY)
            override fun records() = emptyList<AccountCreationRegistry.Record>()
            override fun fingerprint(decision: Decision) = NotesRemovalOffer.fingerprint(noBackup, decision,
                stat = { nioStat(it, follow = true) }, lstat = { nioStat(it, follow = false) })
            // As Android asks the authenticator: a decision and a fingerprint of their own, then the answer.
            override fun remove(type: String, name: String, removed: () -> Unit) {
                val now = decision(type, name)
                answers += allowance.answer(Key(type, name, now.creationId), now.verdict, fingerprint(now))
                gone = answers.last()
                removed()
            }
            override fun present(type: String, name: String) = !gone
            override fun clearRecord(type: String, name: String, creationId: String) = false
        }
        val offer = NotesRemovalOffer(TYPE, allowance, seams)
        val listingsBefore = NotesFolderListings.count(Folder.PENDING)
        val shown = offer.show(TYPE, "b")!!
        assertEquals(setOf(Cause.PENDING_UNKNOWN_KIND), shown.reason)
        val outcomes = ArrayList<Outcome>()
        offer.confirm(TYPE, "b", shown.id) { outcomes += it }
        assertEquals("exactly one yes", listOf(true), answers)
        assertEquals(listOf(Outcome.REMOVED), outcomes)
        assertNotEquals("the guard listed notes-pending on the way", listingsBefore,
            NotesFolderListings.count(Folder.PENDING))
        val again = seams.decision(TYPE, "b")
        assertFalse("a second answer is refused", allowance.answer(Key(TYPE, "b", again.creationId), again.verdict,
            seams.fingerprint(again)))

        assertEquals("each entry of an unknown kind, and the store-named link and its target, as it was",
            identitiesBefore, identities())
        assertEquals("and every file in no_backup", treeBefore, tree(noBackup))
        assertEquals(outsideBefore, outside.readBytes().toList())
        assertTrue("its permit stays", File(noBackup, PendingNotesDiscardPermits.ROOT).list()!!.isNotEmpty())
        if (linked) {
            assertTrue("the link's acknowledgement stays",
                File(noBackup, "${PendingNotesDiscardPermits.ROOT}/${storeLink.name}.acknowledgement").isFile)
        }
    }

    @Test fun `each reason has its own words, and each outcome its message`() {
        assertEquals(R.string.notes_remove_uncheckable_text_root,
            NotesRemovalOffer.text(setOf(Cause.PENDING_UNLISTED)))
        assertEquals(R.string.notes_remove_uncheckable_text_permits,
            NotesRemovalOffer.text(setOf(Cause.DISCARD_UNLISTED)))
        assertEquals(R.string.notes_remove_uncheckable_text_both,
            NotesRemovalOffer.text(setOf(Cause.PENDING_UNLISTED, Cause.DISCARD_UNLISTED)))
        assertEquals(R.string.notes_remove_uncheckable_text_unknown_kind,
            NotesRemovalOffer.text(setOf(Cause.PENDING_UNKNOWN_KIND)))
        val texts = Verdict.entries.filter { it.eligible }.map { NotesRemovalOffer.text(it.reason!!) }
        assertEquals("one text for each eligible verdict", texts.distinct(), texts)
        assertEquals(listOf(R.string.notes_remove_uncheckable_done, R.string.notes_remove_uncheckable_readable,
            R.string.notes_remove_uncheckable_changed, R.string.notes_remove_uncheckable_retry,
            R.string.notes_remove_uncheckable_unknown), Outcome.entries.map(NotesRemovalOffer::message))
    }

    private companion object {
        const val TYPE = "io.silentsuite"
    }
}
