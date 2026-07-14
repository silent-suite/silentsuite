package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AuthenticatorResponseLifecycleContractTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync/ui/setup")

    @Test
    fun controllerRestoresAndSavesOnlyFrameworkCallbackState() {
        val source = File(sourceRoot, "AuthenticatorResponseController.kt").readText()
        val saveState = source.substringAfter("fun onSaveInstanceState").substringBefore("val isCompleted")

        assertTrue(source.contains("savedInstanceState?.getParcelable<AccountAuthenticatorResponse>(KEY_RESPONSE)"))
        assertTrue(source.contains("savedInstanceState?.getBundle(KEY_RESULT)"))
        assertTrue(source.contains("response?.onRequestContinued()"))
        assertTrue(saveState.contains("outState.putParcelable(KEY_RESPONSE, response)"))
        assertTrue(saveState.contains("outState.putBundle(KEY_RESULT, result)"))
        assertTrue(saveState.contains("outState.putBoolean(KEY_COMPLETED, completed)"))
        assertTrue(saveState.contains("outState.putBoolean(KEY_DELIVERED, delivered)"))
        assertFalse(saveState.contains("password"))
        assertFalse(saveState.contains("configuration"))
        assertFalse(saveState.contains("etebase"))
    }

    @Test
    fun controllerDeliversThePendingResultOrCancellationExactlyOnceAtFinish() {
        val source = File(sourceRoot, "AuthenticatorResponseController.kt").readText()
        val finish = source.substringAfter("fun finish()").substringBefore("fun onSaveInstanceState")

        assertTrue(finish.contains("if (delivered) return"))
        assertTrue(finish.contains("response?.onResult(requireNotNull(result))"))
        assertTrue(finish.contains("response?.onError(AccountManager.ERROR_CODE_CANCELED"))
        assertTrue(finish.contains("response = null"))
        assertTrue(finish.contains("delivered = true"))
    }

    @Test
    fun registryRecordsOpaqueFlowIdsRatherThanActivityOrControllerReferences() {
        val source = File(sourceRoot, "SignupContinuationRegistry.kt").readText()

        assertTrue(source.contains("ConcurrentHashMap<String, String>"))
        assertTrue(source.contains("fun issue(flowId: String)"))
        assertTrue(source.contains("fun consume(token: String?, flowId: String)"))
        assertTrue(source.contains("continuations.remove(token, flowId)"))
        assertTrue(source.contains("fun remove(flowId: String)"))
        assertFalse(source.contains("ConcurrentHashMap<String, AuthenticatorResponseController>"))
        assertFalse(source.contains("import android.app.Activity"))
        assertFalse(source.contains("import android.content.Context"))
        assertFalse(source.contains("password"))
        assertFalse(source.contains("session"))
    }
}
