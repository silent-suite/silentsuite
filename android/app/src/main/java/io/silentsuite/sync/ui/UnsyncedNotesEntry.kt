package io.silentsuite.sync.ui

import android.view.Menu
import android.view.MenuItem
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.lifecycleScope
import io.silentsuite.sync.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The overflow item that opens Settings, Unsynced Notes from the sign-in and setup screens, so the way out for
 * unsynced Notes is there also when no account can reach its dashboard. It opens the screen as the root of Settings
 * with no account ([AppSettingsActivity.newUnsyncedNotesIntent]), with no hub, so Back returns to the screen it came
 * from.
 *
 * The item is hidden only while the last read found certainly nothing to show there, by the rule that hides the
 * Settings hub row ([UnsyncedNotesFragment.anythingToShow]): no store with unsynced text, none that can't be read, no
 * other Notes file left unread, and no account Android settings can't remove. Every resume of [activity] reads again,
 * off the main thread. Until a read has answered, and after a read that throws, the item shows.
 */
internal class UnsyncedNotesEntry(private val activity: AppCompatActivity) {
    private var shown = true
    private var reading: Job? = null

    init {
        activity.lifecycle.addObserver(LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refresh()
        })
    }

    private fun refresh() {
        val app = activity.applicationContext
        reading?.cancel()
        reading = activity.lifecycleScope.launch {
            val anything = try {
                UnsyncedNotesFragment.anythingToShow(app)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                true
            }
            if (anything != shown) {
                shown = anything
                activity.invalidateOptionsMenu()
            }
        }
    }

    fun addTo(menu: Menu) {
        menu.add(Menu.NONE, ITEM_ID, Menu.NONE, R.string.settings_unsynced_notes).apply {
            setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
            isVisible = shown
        }
    }

    /** Opens Unsynced Notes for this item and answers true; false for any other item. */
    fun opens(item: MenuItem): Boolean {
        if (item.itemId != ITEM_ID) return false
        activity.startActivity(AppSettingsActivity.newUnsyncedNotesIntent(activity))
        return true
    }

    companion object {
        /** Not 0, which Help's item has, and below the resource ids and android.R.id.home (0x01000000 and above). */
        const val ITEM_ID = 0x00554e53
    }
}
