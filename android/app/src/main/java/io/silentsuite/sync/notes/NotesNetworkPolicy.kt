package io.silentsuite.sync.notes

/**
 * Whether a Notes run may use the network it would run on (design 3.6; answers 4 and 5 of 2026-10-12
 * on #709). Two settings per account: one for runs nobody asked for (opening Notes, the run after an
 * adapter sync), one for runs the user starts (Sync now, pull to refresh, turning Notes on, the syncs
 * the app starts after its own actions). An automatic run also follows the account's own Wi-Fi
 * switch, and a network name saved with it refuses every automatic run (#971). No Android types, so
 * every row is unit-testable.
 */
object NotesNetworkPolicy {
    /**
     * NONE: the platform reports no active network (it can do so under some VPNs while the device is
     * online), or one that is not connected. OTHER: a connected network that is not Wi-Fi.
     */
    enum class Connection { NONE, WIFI, OTHER }

    /** The network as the platform reports it. The Wi-Fi name is not part of it: nothing reads it (#971). */
    data class Reading(val connection: Connection)

    enum class Allowed {
        WIFI_ONLY, ANY_NETWORK;

        companion object {
            /** A value this build does not know reads as the default of that setting. */
            fun parse(stored: String?, default: Allowed): Allowed = values().firstOrNull { it.name == stored } ?: default
        }
    }

    data class Settings(val automatic: Allowed, val syncNow: Allowed) {
        companion object {
            val DEFAULT = Settings(Allowed.WIFI_ONLY, Allowed.ANY_NETWORK)
            fun fromStored(automatic: String?, syncNow: String?) =
                Settings(Allowed.parse(automatic, DEFAULT.automatic), Allowed.parse(syncNow, DEFAULT.syncNow))
        }
    }

    /** The account's own rule: the switch, and the one network name it may carry. */
    data class AccountRule(val wifiOnly: Boolean, val networkName: String?)

    enum class Blocker { NOTES_SETTING, ACCOUNT_WIFI_ONLY, ACCOUNT_NETWORK_NAME }

    /** [connection] is null when the network was not read for the run: see [refusedUnread]. */
    data class Verdict(val blockers: Set<Blocker>, val connection: Connection?) {
        val run: Boolean get() = blockers.isEmpty()
    }

    /** The account switch's own mapping (onConnectedWifi): connected and of type Wi-Fi is Wi-Fi. */
    fun connectionOf(present: Boolean, connected: Boolean, wifi: Boolean): Connection = when {
        !present || !connected -> Connection.NONE
        wifi -> Connection.WIFI
        else -> Connection.OTHER
    }

    /**
     * What the account's own rule holds against [reading], or null. A stored name means nothing while
     * the switch is off. With the switch on, a saved name refuses on every network, before the
     * connection is looked at: Android gives this app no Wi-Fi names, so the name cannot be checked
     * (#971). Without a name the switch needs a connected Wi-Fi network.
     */
    fun accountBlocker(rule: AccountRule, reading: Reading): Blocker? = when {
        !rule.wifiOnly -> null
        rule.networkName != null -> Blocker.ACCOUNT_NETWORK_NAME
        reading.connection != Connection.WIFI -> Blocker.ACCOUNT_WIFI_ONLY
        else -> null
    }

    /** A run the user started follows [Settings.syncNow] alone. Any other run needs [Settings.automatic] and [account]. */
    fun decide(explicit: Boolean, settings: Settings, account: AccountRule, reading: Reading): Verdict {
        val blockers = LinkedHashSet<Blocker>()
        val allowed = if (explicit) settings.syncNow else settings.automatic
        if (allowed == Allowed.WIFI_ONLY && reading.connection != Connection.WIFI) blockers += Blocker.NOTES_SETTING
        if (!explicit) accountBlocker(account, reading)?.let { blockers += it }
        return Verdict(blockers, reading.connection)
    }

    /**
     * The refusal of an automatic run that needs no reading, or null. With the switch on, a saved
     * network name refuses on every network (#971), so a run gate that asks this first reads no
     * network for that run. Every other run, and every run the user starts, goes to [decide].
     */
    fun refusedUnread(explicit: Boolean, account: AccountRule): Verdict? =
        if (!explicit && account.wifiOnly && account.networkName != null) Verdict(setOf(Blocker.ACCOUNT_NETWORK_NAME), null) else null

    /**
     * One sentence of the line the notebook list shows while Notes do not sync by themselves on the
     * network the platform reports. The screen has one text for each and shows them in the order
     * [notice] gives.
     */
    enum class NoticePart {
        /** Opens the line: what the device holds may be old. */
        MAY_BE_OUT_OF_DATE,

        /** The automatic Notes setting is Wi-Fi only. */
        NOTES_SETTING,

        /** The account's own Wi-Fi-only switch is on. */
        ACCOUNT_WIFI_ONLY,

        /**
         * The reading is not Wi-Fi. NONE gets this sentence too: no active network is what the platform
         * reports, not proof that there is no connection.
         */
        NO_WIFI_REPORTED,

        /** The account's switch is on with a network name saved, which refuses on every network. */
        ACCOUNT_NETWORK_NAME,

        /** A run the user starts would not be refused. It is an attempt; it can still fail. */
        TRY_NOW,

        /** A run the user starts would be refused too: Sync now is Wi-Fi only and the reading is not Wi-Fi. */
        SYNC_NOW_NEEDS_WIFI,
    }

    /**
     * What the notebook list says about the network, sentence by sentence, or nothing when an
     * automatic run would not be refused now (answer 5 of 2026-10-12 on #709). First that Notes may
     * be out of date, then every rule that refuses the automatic run with what the platform reports,
     * then what a run the user starts would get. A saved network name is the only reason given when it
     * refuses, since it refuses on every network. Network reasons only: a run that is not refused can
     * still fail.
     */
    fun notice(settings: Settings, account: AccountRule, reading: Reading): List<NoticePart> {
        val automatic = decide(explicit = false, settings, account, reading)
        if (automatic.run) return emptyList()
        val parts = ArrayList<NoticePart>()
        parts += NoticePart.MAY_BE_OUT_OF_DATE
        if (Blocker.ACCOUNT_NETWORK_NAME in automatic.blockers) {
            parts += NoticePart.ACCOUNT_NETWORK_NAME
        } else {
            if (Blocker.NOTES_SETTING in automatic.blockers) parts += NoticePart.NOTES_SETTING
            if (Blocker.ACCOUNT_WIFI_ONLY in automatic.blockers) parts += NoticePart.ACCOUNT_WIFI_ONLY
            parts += NoticePart.NO_WIFI_REPORTED
        }
        parts += if (decide(explicit = true, settings, account, reading).run) NoticePart.TRY_NOW else NoticePart.SYNC_NOW_NEEDS_WIFI
        return parts
    }
}
