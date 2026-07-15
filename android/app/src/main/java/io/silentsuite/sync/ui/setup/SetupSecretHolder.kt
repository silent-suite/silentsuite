package io.silentsuite.sync.ui.setup

import java.util.concurrent.ConcurrentHashMap

object SetupSecretHolder {
    @Volatile
    private var loginCredentials: LoginCredentials? = null

    @Volatile
    private var pendingConfiguration: BaseConfigurationFinder.Configuration? = null

    private val pendingSessions = ConcurrentHashMap<String, String>()

    fun setLoginCredentials(credentials: LoginCredentials) {
        loginCredentials = credentials
    }

    fun getLoginCredentials(): LoginCredentials? = loginCredentials

    fun clearLoginCredentials() {
        loginCredentials = null
    }

    fun setPendingConfiguration(config: BaseConfigurationFinder.Configuration) {
        pendingConfiguration = config
    }

    fun getPendingConfiguration(): BaseConfigurationFinder.Configuration? = pendingConfiguration

    fun clearPendingConfiguration() {
        pendingConfiguration = null
    }

    fun setPendingSession(accountName: String, etebaseSession: String?) {
        if (etebaseSession != null) {
            pendingSessions[accountName] = etebaseSession
        }
    }

    fun consumePendingSession(accountName: String): String? = pendingSessions.remove(accountName)

    fun clearCredentialsAndConfiguration() {
        loginCredentials = null
        pendingConfiguration = null
    }

    fun clearProcessOnlySecrets() {
        clearCredentialsAndConfiguration()
        pendingSessions.clear()
    }
}
