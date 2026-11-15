package io.silentsuite.sync.notes

import android.os.Looper
import io.silentsuite.sync.notes.edit.PendingNotesStore
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertTrue

/**
 * Records every call that reaches the pending Notes store's listing seam ([PendingNotesStore.listFilesForTesting]), its
 * removal seam ([PendingNotesStore.beforeRemoveForTesting]), its write seam ([PendingNotesStore.beforeRenameForTesting])
 * or its read seam ([PendingNotesStore.beforeReadForTesting]) on the main thread, so a device case can show that a
 * screen reaches the store only off it: every listing the store makes, of its own folder, the folders above it and the
 * permits' root, every file it removes, every entry it writes (a release or a save), and every file it reads by its
 * path (an entry, a landed record, a notebook copy), passes one of the four. A load on an instance that already
 * recovered lists nothing and reads by path only, so the read seam is what catches it. It only records: the seams run
 * inside a store call on a worker thread, which rethrows anything, so an assertion there would end the app process.
 * The test thread asks [assertNoneOnMain].
 *
 * While it is installed, the probe holds all four seams. A case that sets its own listing, removal, write or read sets
 * [listing], [removal], [write] or [read], never the store's seam, and the probe applies it as it is: a listing that
 * answers null is one that failed, and is never replaced by File.listFiles(), and a read hook that throws makes that
 * read fail as the read itself would.
 */
internal class MainThreadStoreProbe {
    /** What a listing of the directory it is given answers in place of File.listFiles(); null is one that failed. */
    @Volatile var listing: ((File) -> Array<File>?)? = null

    /** Called with the file before each removal, once the probe has seen it. */
    @Volatile var removal: ((File) -> Unit)? = null

    /** Called with the entry file before each write is renamed into place, once the probe has seen it. */
    @Volatile var write: ((File) -> Unit)? = null

    /** Called with the file before each read of one file by its path, once the probe has seen it; it may throw IOException. */
    @Volatile var read: ((File) -> Unit)? = null

    /** How many listings, removals, writes and reads reached the probe, on any thread. */
    private val seen = AtomicInteger()

    /** What reached it on the main thread, in order. */
    private val onMain = ArrayList<String>()

    fun install() {
        PendingNotesStore.listFilesForTesting = { d ->
            record("a listing of ${d.name}")
            listing.let { if (it != null) it(d) else d.listFiles() }
        }
        PendingNotesStore.beforeRemoveForTesting = { file ->
            record("a removal of ${file.name}")
            removal?.invoke(file)
        }
        PendingNotesStore.beforeRenameForTesting = { file ->
            record("a write of ${file.name}")
            write?.invoke(file)
        }
        PendingNotesStore.beforeReadForTesting = { file ->
            record("a read of ${file.name}")
            read?.invoke(file)
        }
    }

    /** Resets the four seams of the store, and the case's own listing, removal, write and read. */
    fun uninstall() {
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.beforeRenameForTesting = null
        PendingNotesStore.beforeReadForTesting = null
        listing = null
        removal = null
        write = null
        read = null
    }

    /** Counts every call, and keeps the ones made on the main looper's thread. */
    private fun record(what: String) {
        seen.incrementAndGet()
        if (Thread.currentThread() === Looper.getMainLooper().thread) synchronized(onMain) { onMain += what }
    }

    /** Fails, naming each call, while any reached the store on the main thread, or while none reached the probe. */
    fun assertNoneOnMain() {
        val found = synchronized(onMain) { onMain.toList() }
        assertTrue("store calls on the main thread: $found", found.isEmpty())
        assertTrue("no listing, removal, write or read reached the probe, so it saw nothing", seen.get() > 0)
    }
}
