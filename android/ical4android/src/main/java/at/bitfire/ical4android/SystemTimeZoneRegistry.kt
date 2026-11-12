package at.bitfire.ical4android

import at.bitfire.ical4android.util.ZoneRulesVTimeZone
import net.fortuna.ical4j.model.TimeZone
import net.fortuna.ical4j.model.TimeZoneRegistry
import net.fortuna.ical4j.model.TimeZoneRegistryFactory
import net.fortuna.ical4j.model.TimeZoneRegistryImpl
import java.time.ZoneId
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Level

/**
 * ical4j time zone registry that answers from the platform's time zone rules (on Android: the
 * system tzdata, which is updated independently of this app) instead of the snapshot ical4j bundles.
 *
 * Lookup order:
 *
 * 1. zones registered on this instance, i.e. VTIMEZONEs embedded in a parsed iCalendar
 *    (same precedence as ical4j's own registry),
 * 2. IDs the platform knows, built from its rules,
 * 3. ical4j's bundled registry, for everything else (Windows/Outlook names, tzurl.org IDs, aliases).
 */
class SystemTimeZoneRegistry: TimeZoneRegistry {

    companion object {
        /** Built zones per ID. The platform rules don't change while the process runs. */
        private val systemZones = ConcurrentHashMap<String, TimeZone>()

        fun systemTimeZone(id: String): TimeZone? {
            systemZones[id]?.let { return it }
            if (!ZoneId.getAvailableZoneIds().contains(id))
                return null
            return try {
                val tz = TimeZone(ZoneRulesVTimeZone.build(id))
                systemZones.putIfAbsent(id, tz) ?: tz
            } catch (e: Exception) {
                Ical4Android.log.log(Level.WARNING, "Couldn't build time zone $id from system rules, using ical4j's", e)
                null
            }
        }
    }

    private val registered = ConcurrentHashMap<String, TimeZone>()
    private val bundled = TimeZoneRegistryImpl()

    override fun register(timezone: TimeZone) {
        registered[timezone.id] = timezone
    }

    override fun register(timezone: TimeZone, update: Boolean) {
        registered[timezone.id] = (if (update) systemTimeZone(timezone.id) else null) ?: timezone
    }

    override fun clear() {
        registered.clear()
    }

    override fun getTimeZone(id: String): TimeZone? {
        registered[id]?.let { return it }
        // Fixed offsets (UTC, GMT, Etc/GMT+7 …) can't go stale. ical4j's data keeps their established IDs,
        // for instance "UTC" -> "Etc/UTC", which TimeZones.isUtc() and so UTC detection depend on.
        if (isFixedOffset(id))
            bundled.getTimeZone(id)?.let { return it }
        return systemTimeZone(id) ?: bundled.getTimeZone(id)
    }

    private fun isFixedOffset(id: String) =
        ZoneId.getAvailableZoneIds().contains(id) && ZoneId.of(id).rules.isFixedOffset

}

/** Configured in `ical4j.properties` (`net.fortuna.ical4j.timezone.registry`). */
class SystemTimeZoneRegistryFactory: TimeZoneRegistryFactory() {

    override fun createRegistry(): TimeZoneRegistry = SystemTimeZoneRegistry()

}
