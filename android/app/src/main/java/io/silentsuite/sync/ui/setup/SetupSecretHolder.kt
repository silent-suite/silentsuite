package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.ui.etebase.SignupCredentials
import java.util.concurrent.ConcurrentHashMap

object SetupSecretHolder {
    @Volatile
    private var loginCredentials: LoginCredentials? = null

    @Volatile
    private var signupCredentials: SignupCredentials? = null

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

    fun setSignupCredentials(credentials: SignupCredentials) {
        signupCredentials = credentials
    }

    fun getSignupCredentials(): SignupCredentials? = signupCredentials

    fun clearSignupCredentials() {
        signupCredentials = null
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
        signupCredentials = null
        pendingConfiguration = null
    }
}
