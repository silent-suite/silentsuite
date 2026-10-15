package io.silentsuite.sync.notes

/**
 * Whether a Notes run may use the network it would run on (design 3.6; answers 4 and 5 of 2026-10-12
 * on #709). Two settings per account: one for runs nobody asked for (opening Notes, the run after an
 * adapter sync, later the editor's Save), one for runs the user starts (Sync now, pull to refresh,
 * turning Notes on, the syncs the app starts after its own actions). An automatic run also needs the
 * account's own Wi-Fi switch and its network name. No Android types, so every row is unit-testable.
 */
object NotesNetworkPolicy {
    /**
     * NONE: the platform reports no active network (it can do so under some VPNs while the device is
     * online), or one that is not connected. OTHER: a connected network that is not Wi-Fi.
     */
    enum class Connection { NONE, WIFI, OTHER }

    /**
     * [wifiName] as the platform reports it, quotes included; null when not on Wi-Fi, not asked for, or
     * the platform gave none; a name the platform withholds arrives as its unknown-name value, which is
     * not null.
     */
    data class Reading(val connection: Connection, val wifiName: String? = null)

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

    /** The account's own rule as the adapters apply it: the switch, and the one network name it may carry. */
    data class AccountRule(val wifiOnly: Boolean, val networkName: String?)

    enum class Blocker { NOTES_SETTING, ACCOUNT_WIFI_ONLY, ACCOUNT_NETWORK_NAME }

    data class Verdict(val blockers: Set<Blocker>, val connection: Connection) {
        val run: Boolean get() = blockers.isEmpty()
    }

    /** The account switch's own mapping (syncConditionsAllow): connected and of type Wi-Fi is Wi-Fi. */
    fun connectionOf(present: Boolean, connected: Boolean, wifi: Boolean): Connection = when {
        !present || !connected -> Connection.NONE
        wifi -> Connection.WIFI
        else -> Connection.OTHER
    }

    /**
     * What the account's own rule holds against [reading], or null. A stored name means nothing while
     * the switch is off. With a name set, a name that does not match is a refusal, and so is the
     * platform's unknown-name value, in the adapters' rule (syncConditionsAllow in
     * syncadapter/SyncAdapterService.kt) and here alike. One difference: with no Wi-Fi info object the
     * adapters' log line throws; here that is a refusal.
     */
    fun accountBlocker(rule: AccountRule, reading: Reading): Blocker? = when {
        !rule.wifiOnly -> null
        reading.connection != Connection.WIFI -> Blocker.ACCOUNT_WIFI_ONLY
        rule.networkName != null && reading.wifiName != "\"" + rule.networkName + "\"" -> Blocker.ACCOUNT_NETWORK_NAME
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
     * One sentence of the line the notebook list shows while Notes do not sync by themselves on the
     * network the platform reports. The screen has one text for each and shows them in the order
     * [notice] gives.
     */
    enum class NoticePart {
        /** Opens the line while changes wait on a notebook row. */
        CHANGES_WAITING,

        /** Opens the line while none do: what the device holds may be old. */
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

        /** The reading is Wi-Fi, but not the network the account names, or the platform gave no name. */
        ACCOUNT_NETWORK_NAME,

        /** A run the user starts would not be refused. It is an attempt; it can still fail. */
        TRY_NOW,

        /** A run the user starts would be refused too: Sync now is Wi-Fi only and the reading is not Wi-Fi. */
        SYNC_NOW_NEEDS_WIFI,
    }

    /**
     * What the notebook list says about the network, sentence by sentence, or nothing when an
     * automatic run would not be refused now (answer 5 of 2026-10-12 on #709). First whether changes
     * wait, then every rule that refuses the automatic run with what the platform reports, then what
     * a run the user starts would get. Network reasons only: a change can also wait for another
     * reason, and a run that is not refused can still fail.
     */
    fun notice(waiting: Int, settings: Settings, account: AccountRule, reading: Reading): List<NoticePart> {
        val automatic = decide(explicit = false, settings, account, reading)
        if (automatic.run) return emptyList()
        val parts = ArrayList<NoticePart>()
        parts += if (waiting > 0) NoticePart.CHANGES_WAITING else NoticePart.MAY_BE_OUT_OF_DATE
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
