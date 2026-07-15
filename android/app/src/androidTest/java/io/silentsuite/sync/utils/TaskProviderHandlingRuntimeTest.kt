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
  val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context); val target=Account("create-${System.nanoTime()}@example.invalid",App.accountType); val creating=Account("creating-${System.nanoTime()}@example.invalid",App.accountType); val recovery=Account("recovery-${System.nanoTime()}@example.invalid",App.accountType); val malformed=Account("malformed-${System.nanoTime()}@example.invalid",App.accountType); val provider=TaskProvider.ProviderName.OpenTasks; val authority=android.provider.CalendarContract.AUTHORITY
  fun provision(account:Account,state:PostLoginSetupState) { check(manager.addAccountExplicitly(account,null,null)); AccountSettings.setUserData(manager,account,URI("https://example.invalid"),account.name); check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_CREATION_ID,"id-${account.name}")); check(AccountSettings.writeSetupState(manager,account,state)); ContentResolver.removePeriodicSync(account,authority,Bundle()); ContentResolver.setSyncAutomatically(account,authority,false); ContentResolver.setIsSyncable(account,authority,0) }
  provision(target,PostLoginSetupState.CREATING); provision(creating,PostLoginSetupState.CREATING); provision(recovery,PostLoginSetupState.RECOVERY_REQUIRED); check(manager.addAccountExplicitly(malformed,null,null)); ContentResolver.setIsSyncable(malformed,authority,0)
  val writes=mutableListOf<Triple<Account,String,Long>>(); TaskProviderHandling.wantedProviderResolver={ provider }; TaskProviderHandling.providerAuthorityResolver={ authority }; TaskProviderHandling.calendarIntervalResolver={ Constants.DEFAULT_SYNC_INTERVAL.toLong() }; TaskProviderHandling.syncIntervalWriteObserver={ account,resolved,seconds -> writes += Triple(account,resolved,seconds) }
  try { val equivalent=manager.getAccountsByType(App.accountType).first { it.name==target.name }; TaskProviderHandling.updateTaskSync(context,provider,equivalent); assertTrue(ContentResolver.getIsSyncable(target,authority)>0); assertEquals(listOf(Triple(target.name,authority,Constants.DEFAULT_SYNC_INTERVAL.toLong())),writes.map { Triple(it.first.name,it.second,it.third) }); listOf(creating,recovery).forEach { assertEquals(0,ContentResolver.getIsSyncable(it,authority)) }; assertEquals(0,ContentResolver.getIsSyncable(malformed,authority)); org.junit.Assert.assertTrue(runCatching { AccountSettings(context,malformed) }.isFailure); ContentResolver.removePeriodicSync(target,authority,Bundle()); ContentResolver.setSyncAutomatically(target,authority,false); ContentResolver.setIsSyncable(target,authority,0); TaskProviderHandling.updateTaskSync(context,provider); assertEquals(0,ContentResolver.getIsSyncable(target,authority)); assertEquals(1,writes.size) }
  finally { TaskProviderHandling.wantedProviderResolver=null; TaskProviderHandling.providerAuthorityResolver=null; TaskProviderHandling.calendarIntervalResolver=null; TaskProviderHandling.syncIntervalWriteObserver=null; listOf(target,creating,recovery,malformed).forEach { ContentResolver.removePeriodicSync(it,provider.authority,Bundle()); ContentResolver.removePeriodicSync(it,authority,Bundle()); ContentResolver.setSyncAutomatically(it,authority,false); ContentResolver.setIsSyncable(it,provider.authority,0); ContentResolver.setIsSyncable(it,authority,0); AndroidCompat.removeAccount(manager,it) }; val deadline=android.os.SystemClock.uptimeMillis()+5000; while(manager.getAccountsByType(App.accountType).any { it in listOf(target,creating,recovery,malformed) } && android.os.SystemClock.uptimeMillis()<deadline) android.os.SystemClock.sleep(25); org.junit.Assert.assertTrue(manager.getAccountsByType(App.accountType).none { it in listOf(target,creating,recovery,malformed) }) }
 }
}
