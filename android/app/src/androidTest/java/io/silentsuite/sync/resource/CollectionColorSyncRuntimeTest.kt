package io.silentsuite.sync.resource

import android.content.ContentValues
import android.provider.CalendarContract.Calendars
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.etebase.client.Account
import com.etebase.client.Client
import com.etebase.client.ItemMetadata
import com.etebase.client.User
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.Constants
import io.silentsuite.sync.notes.FakeEtebaseServer
import okhttp3.OkHttpClient
import org.dmfs.tasks.contract.TaskContract.TaskLists
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the ContentValues used by sync to create and update calendars and task lists. */
@RunWith(AndroidJUnit4::class)
class CollectionColorSyncRuntimeTest {
    private val collectionManager by lazy {
        // The existing interceptor fixture handles signup entirely in memory, without a socket.
        val fake = FakeEtebaseServer()
        val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
        Account.signup(client, User("collection-colors", "colors@example.invalid"), "stand-in-server-only")
            .collectionManager
    }

    @Test fun calendarSyncValuesTolerateInvalidColorsAndPreserveExistingColorBehavior() {
        assertSyncColors(Constants.ETEBASE_TYPE_CALENDAR, Calendars.CALENDAR_COLOR,
            LocalCalendar.Companion::valuesFromCachedCollection)
    }

    @Test fun taskListSyncValuesTolerateInvalidColorsAndPreserveExistingColorBehavior() {
        assertSyncColors(Constants.ETEBASE_TYPE_TASKS, TaskLists.LIST_COLOR,
            LocalTaskList.Companion::valuesFromCachedCollection)
    }

    private fun assertSyncColors(
        type: String,
        colorColumn: String,
        valuesFromCollection: (CachedCollection, Boolean) -> ContentValues,
    ) {
        val cases = listOf(
            "orange" to LocalCalendar.defaultColor,
            "#purple" to LocalCalendar.defaultColor,
            "lavender" to LocalCalendar.defaultColor,
            "#ff0000zz" to LocalCalendar.defaultColor,
            null to LocalCalendar.defaultColor,
            "" to LocalCalendar.defaultColor,
            "   " to LocalCalendar.defaultColor,
            "red" to LocalCalendar.defaultColor,
            "#FF0000" to 0xFFFF0000.toInt(),
            "00ff00" to 0xFF00FF00.toInt(),
            "#0000FF80" to 0x800000FF.toInt(),
        )
        for ((color, expected) in cases) {
            val metadata = ItemMetadata().apply { name = "Color fixture"; this.color = color }
            val collection = collectionManager.create(type, metadata, "")
            val cached = CachedCollection(collection, collection.meta, type)
            assertEquals("fixture preserves color $color", color, cached.meta.color)

            val values = valuesFromCollection(cached, true)
            assertEquals("sync color for $type: $color", expected, values.getAsInteger(colorColumn))
            assertFalse("disabled color management must omit $colorColumn",
                valuesFromCollection(cached, false).containsKey(colorColumn))
        }
    }
}
