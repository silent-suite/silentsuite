package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
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
}
