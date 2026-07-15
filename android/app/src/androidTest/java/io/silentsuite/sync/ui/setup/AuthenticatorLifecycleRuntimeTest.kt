package io.silentsuite.sync.ui.setup

import androidx.test.ext.junit.runners.AndroidJUnit4
import android.accounts.Account
import android.os.Bundle
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import io.silentsuite.sync.App
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Runtime policy coverage; dead binder delivery is intentionally not claimed. */
@RunWith(AndroidJUnit4::class)
class AuthenticatorLifecycleRuntimeTest {
    @Test fun staleLoginActivityRestorationUsesObsoletePathBeforeController() {
        var cancel=0; var clear=0; var launch=0; var controllers=0
        val stale=Bundle().apply { putBoolean(LoginActivity.KEY_WAS_AUTHENTICATOR,true); putString("authenticator_process_epoch","stale"); putString(AuthenticatorResponseController.KEY_ACCOUNT_NAME,"staged") }
        LoginActivity.obsoleteSeamsFactory={ _,_,_ -> object:ObsoleteAuthenticatorCoordinator.Seams { override fun cancel(){cancel++}; override fun clearSecrets(){clear++}; override fun launchNormalOnce(){launch++} } }
        LoginActivity.controllerFactory={ _,_ -> controllers++; AuthenticatorResponseController(object:AuthenticatorResponseController.Delivery { override fun continued(){}; override fun result(result:Bundle){}; override fun error(code:Int,message:String){} },null) }
        StaleLoginHarnessActivity.restored=stale
        try { val instrumentation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation(); val testContext=instrumentation.context; val targetContext=instrumentation.targetContext; val component=android.content.ComponentName(targetContext.packageName,StaleLoginHarnessActivity::class.java.name); assertEquals(targetContext.packageName,component.packageName); org.junit.Assert.assertFalse(component.packageName==testContext.packageName); ActivityScenario.launch<StaleLoginHarnessActivity>(Intent().setComponent(component)).use {}; assertEquals(1,cancel);assertEquals(1,clear);assertEquals(1,launch);assertEquals(0,controllers) }
        finally { LoginActivity.obsoleteSeamsFactory=null;LoginActivity.controllerFactory=null;StaleLoginHarnessActivity.restored=null }
    }
    @Test fun obsoleteCoordinatorCancelsBeforeNormalLaunch() {
        val calls=mutableListOf<String>()
        ObsoleteAuthenticatorCoordinator(object: ObsoleteAuthenticatorCoordinator.Seams { override fun cancel(){calls += "cancel"}; override fun clearSecrets(){calls += "clear"}; override fun launchNormalOnce(){calls += "launch"} }).handle()
        assertEquals(listOf("cancel","clear","launch"), calls)
    }
    @Test fun controllerLiveResultCancellationDuplicatesAndRestoreAreExactOnce() {
        class Fake : AuthenticatorResponseController.Delivery { var continued=0; val results=mutableListOf<Bundle>(); var errors=0; override fun continued(){continued++}; override fun result(result: Bundle){results += Bundle(result)}; override fun error(code:Int,message:String){errors++} }
        val success=Fake(); AuthenticatorResponseController(success,null).apply { complete(Account("a","t")); finish(); finish() }
        assertEquals(1,success.continued); assertEquals(1,success.results.size); assertEquals("a", success.results.single().getString(android.accounts.AccountManager.KEY_ACCOUNT_NAME)); assertEquals("t", success.results.single().getString(android.accounts.AccountManager.KEY_ACCOUNT_TYPE)); assertEquals(0,success.errors)
        val canceled=Fake(); AuthenticatorResponseController(canceled,null).apply { finish(); finish() }; assertEquals(1,canceled.errors)
        val staged = Fake(); val beforeRotation = AuthenticatorResponseController(staged, null); beforeRotation.complete(Account("rotated", "type")); val state = Bundle(); beforeRotation.onSaveInstanceState(state)
        val restored = Fake(); AuthenticatorResponseController(restored, state).finish(); assertEquals(1, restored.results.size); assertEquals("rotated", restored.results.single().getString(android.accounts.AccountManager.KEY_ACCOUNT_NAME))
    }
    @Test fun sameProcessRotationPolicyPreservesAuthenticator() {
        assertFalse(AuthenticatorRestorePolicy.mustRestartNormally(true, App.processEpoch, App.processEpoch))
    }
}
