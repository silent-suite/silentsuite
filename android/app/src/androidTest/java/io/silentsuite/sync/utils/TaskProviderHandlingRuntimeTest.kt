package io.silentsuite.sync.utils

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import at.bitfire.ical4android.TaskProvider
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI

/** Framework AccountManager/ContentResolver boundary for the explicit CREATING target exception. */
@RunWith(AndroidJUnit4::class)
class TaskProviderHandlingRuntimeTest {
 @Test fun explicitCreatingTargetOnlyReceivesProviderConfiguration() {
  val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context); val target=Account("create-${System.nanoTime()}@example.invalid",App.accountType); val creating=Account("creating-${System.nanoTime()}@example.invalid",App.accountType); val recovery=Account("recovery-${System.nanoTime()}@example.invalid",App.accountType); val malformed=Account("malformed-${System.nanoTime()}@example.invalid",App.accountType); val provider=TaskProvider.ProviderName.OpenTasks
  fun provision(account:Account,state:PostLoginSetupState) { check(manager.addAccountExplicitly(account,null,null)); AccountSettings.setUserData(manager,account,URI("https://example.invalid"),account.name); check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_CREATION_ID,"id-${account.name}")); check(AccountSettings.writeSetupState(manager,account,state)); ContentResolver.setIsSyncable(account,android.provider.CalendarContract.AUTHORITY,1); ContentResolver.setSyncAutomatically(account,android.provider.CalendarContract.AUTHORITY,true); ContentResolver.addPeriodicSync(account,android.provider.CalendarContract.AUTHORITY,Bundle(),Constants.DEFAULT_SYNC_INTERVAL.toLong()); ContentResolver.setIsSyncable(account,provider.authority,0) }
  provision(target,PostLoginSetupState.CREATING); provision(creating,PostLoginSetupState.CREATING); provision(recovery,PostLoginSetupState.RECOVERY_REQUIRED); check(manager.addAccountExplicitly(malformed,null,null)); ContentResolver.setIsSyncable(malformed,provider.authority,0)
  TaskProviderHandling.wantedProviderResolver={ provider }
  try { val equivalent=manager.getAccountsByType(App.accountType).first { it.name==target.name }; TaskProviderHandling.updateTaskSync(context,provider,equivalent); assertTrue(ContentResolver.getIsSyncable(target,provider.authority)>0); assertEquals(Constants.DEFAULT_SYNC_INTERVAL.toLong(),AccountSettings(context,target).getSyncInterval(provider.authority)); listOf(creating,recovery).forEach { assertEquals(0,ContentResolver.getIsSyncable(it,provider.authority)); assertEquals(null,AccountSettings(context,it).getSyncInterval(provider.authority)) }; assertEquals(0,ContentResolver.getIsSyncable(malformed,provider.authority)); org.junit.Assert.assertTrue(runCatching { AccountSettings(context,malformed) }.isFailure); org.junit.Assert.assertTrue(ContentResolver.getPeriodicSyncs(malformed,provider.authority).isEmpty()); ContentResolver.removePeriodicSync(target,provider.authority,Bundle()); ContentResolver.setIsSyncable(target,provider.authority,0); TaskProviderHandling.updateTaskSync(context,provider); assertEquals(0,ContentResolver.getIsSyncable(target,provider.authority)); assertTrue(ContentResolver.getPeriodicSyncs(target,provider.authority).isEmpty()) }
  finally { TaskProviderHandling.wantedProviderResolver=null; listOf(target,creating,recovery,malformed).forEach { ContentResolver.removePeriodicSync(it,provider.authority,Bundle()); ContentResolver.setIsSyncable(it,provider.authority,0); AndroidCompat.removeAccount(manager,it) }; val deadline=android.os.SystemClock.uptimeMillis()+5000; while(manager.getAccountsByType(App.accountType).any { it in listOf(target,creating,recovery,malformed) } && android.os.SystemClock.uptimeMillis()<deadline) android.os.SystemClock.sleep(25); org.junit.Assert.assertTrue(manager.getAccountsByType(App.accountType).none { it in listOf(target,creating,recovery,malformed) }) }
 }
}
