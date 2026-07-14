package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SetupSecretSerializationTest {
    private val sourceRoot = File("src/main/java")

    @Test
    fun loginCredentialsDoesNotSerializePasswordToParcel() {
        val source = File(sourceRoot, "io/silentsuite/sync/ui/setup/LoginCredentials.kt").readText()

        assertFalse("LoginCredentials must not be Parcelable", source.contains("Parcelable"))
        assertFalse("LoginCredentials must not write passwords to Parcel", source.contains("writeToParcel"))
        assertFalse("LoginCredentials must not write password strings to Parcel", source.contains("writeString(password)"))
    }

    @Test
    fun setupFlowDoesNotSerializeSetupSecretsThroughAndroidState() {
        val source = sourceRoot
            .walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .joinToString("\n") { it.readText() }

        val forbiddenPatterns = listOf(
            "putParcelable(ARG_LOGIN_CREDENTIALS",
            "getParcelable<LoginCredentials>",
            "putSerializable(KEY_CONFIG",
            "EXTRA_ETEBASE_SESSION",
            "putExtra(EXTRA_ETEBASE_SESSION",
            "getStringExtra(EXTRA_ETEBASE_SESSION",
            "extras.getString(EXTRA_ETEBASE_SESSION",
            "rawPassword",
            "var password"
        )

        forbiddenPatterns.forEach { pattern ->
            assertFalse("Setup secret serialization pattern must stay removed: $pattern", source.contains(pattern))
        }
    }

    @Test
    fun setupSecretsAreNeverPutIntoAndroidStateAndPasswordViewStateIsDisabled() {
        val setupSource = File(sourceRoot, "io/silentsuite/sync/ui/setup").walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .joinToString("\n") { it.readText() }
        val loginLayout = File("src/main/res/layout/login_credentials_fragment.xml").readText()

        listOf(
            "putString(\"password\"",
            "putString(\"session\"",
            "putExtra(\"password\"",
            "putExtra(\"session\"",
            "SavedStateHandle",
            "LoginCredentials : Parcelable",
            "Serializable"
        ).forEach { pattern ->
            assertFalse("Setup secrets must not be serialized through Android state: $pattern", setupSource.contains(pattern))
        }
        assertTrue("The actual login password field must not save view state", loginLayout.contains(
            "android:id=\"@+id/login_password\"") && loginLayout.contains("android:saveEnabled=\"false\""))
    }

    @Test
    fun loginActivityNeverAcceptsCredentialsFromAnIntent() {
        val loginSource = File(sourceRoot, "io/silentsuite/sync/ui/setup/LoginActivity.kt").readText()

        listOf(
            "EXTRA_INITIAL_PASSWORD",
            "EXTRA_INITIAL_USERNAME",
            "getStringExtra(EXTRA_INITIAL_PASSWORD)",
            "getStringExtra(EXTRA_INITIAL_USERNAME)",
            "putExtra(EXTRA_INITIAL_PASSWORD",
            "putExtra(EXTRA_INITIAL_USERNAME"
        ).forEach { pattern ->
            assertFalse("LoginActivity must not transport credentials through Intent extras: $pattern", loginSource.contains(pattern))
        }
    }

}
