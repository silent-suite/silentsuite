package io.silentsuite.sync.ui.settings

enum class SettingsCategory(val route: String) {
    HOME("home"),
    ACCOUNT("account"),
    SYNC("sync"),
    NOTIFICATIONS("notifications"),
    APPEARANCE("appearance"),
    PRIVACY_SECURITY("privacy-security"),
    HELP("help"),
    ADVANCED("advanced");

    companion object {
        fun fromRoute(route: String?): SettingsCategory =
            values().firstOrNull { it.route == route } ?: HOME
    }
}
