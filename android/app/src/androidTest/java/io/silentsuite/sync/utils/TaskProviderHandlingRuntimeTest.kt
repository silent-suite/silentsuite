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
  // The provider's own task authority, not calendar: the calendar adapter is always syncable, so the platform can mark a new
  // account syncable after provision() cleared it, and updateTaskSync then skips the interval write checked below.
  val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context); val target=Account("create-${System.nanoTime()}@example.invalid",App.accountType); val creating=Account("creating-${System.nanoTime()}@example.invalid",App.accountType); val recovery=Account("recovery-${System.nanoTime()}@example.invalid",App.accountType); val malformed=Account("malformed-${System.nanoTime()}@example.invalid",App.accountType); val provider=TaskProvider.ProviderName.OpenTasks; val authority=provider.authority
  // Diagnostic only, never a witness of a mechanism: each explicit-zero write's value read once at once ("unavailable" when that read
  // fails). A 0 can also be the getter's answer when access is denied, and an entry can change before or after this sample.
  val syncableAfterSet=mutableMapOf<String,String>(); fun observe(read:() -> Any?):String=runCatching { read().toString() }.getOrElse { "unavailable" }
  fun provision(account:Account,state:PostLoginSetupState) { check(manager.addAccountExplicitly(account,null,null)); AccountSettings.setUserData(manager,account,URI("https://example.invalid"),account.name); check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_CREATION_ID,"id-${account.name}")); check(AccountSettings.writeSetupState(manager,account,state)); ContentResolver.removePeriodicSync(account,authority,Bundle()); ContentResolver.setSyncAutomatically(account,authority,false); ContentResolver.setIsSyncable(account,authority,0); syncableAfterSet[account.name]=observe { ContentResolver.getIsSyncable(account,authority) } }
  provision(target,PostLoginSetupState.CREATING); provision(creating,PostLoginSetupState.CREATING); provision(recovery,PostLoginSetupState.RECOVERY_REQUIRED); check(manager.addAccountExplicitly(malformed,null,null)); ContentResolver.setIsSyncable(malformed,authority,0); syncableAfterSet[malformed.name]=observe { ContentResolver.getIsSyncable(malformed,authority) }
  val writes=mutableListOf<Triple<Account,String,Long>>(); TaskProviderHandling.wantedProviderResolver={ provider }; TaskProviderHandling.providerAuthorityResolver={ authority }; TaskProviderHandling.calendarIntervalResolver={ Constants.DEFAULT_SYNC_INTERVAL.toLong() }; TaskProviderHandling.syncIntervalWriteObserver={ account,resolved,seconds -> writes += Triple(account,resolved,seconds) }; var primary:Throwable?=null
  try { listOf(target,creating,recovery,malformed).forEach { val syncable=ContentResolver.getIsSyncable(it,authority); assertEquals("precondition: ${it.name} syncable before updateTaskSync [afterSet=${syncableAfterSet[it.name] ?: "unavailable"} listed=${observe { it in manager.getAccountsByType(App.accountType) }} generation=${observe { manager.getUserData(it,AccountSettings.KEY_CREATION_ID)!=null }}]",0,syncable) }; val equivalent=manager.getAccountsByType(App.accountType).first { it.name==target.name }; TaskProviderHandling.updateTaskSync(context,provider,equivalent); assertTrue(ContentResolver.getIsSyncable(target,authority)>0); assertEquals(listOf(Triple(target.name,authority,Constants.DEFAULT_SYNC_INTERVAL.toLong())),writes.map { Triple(it.first.name,it.second,it.third) }); listOf(creating,recovery).forEach { assertEquals(0,ContentResolver.getIsSyncable(it,authority)) }; assertEquals(0,ContentResolver.getIsSyncable(malformed,authority)); org.junit.Assert.assertTrue(runCatching { AccountSettings(context,malformed) }.isFailure); ContentResolver.removePeriodicSync(target,authority,Bundle()); ContentResolver.setSyncAutomatically(target,authority,false); ContentResolver.setIsSyncable(target,authority,0); TaskProviderHandling.updateTaskSync(context,provider); assertEquals(0,ContentResolver.getIsSyncable(target,authority)); assertEquals(1,writes.size) }
  catch (t:Throwable) { primary=t; throw t }
  finally { TaskProviderHandling.wantedProviderResolver=null; TaskProviderHandling.providerAuthorityResolver=null; TaskProviderHandling.calendarIntervalResolver=null; TaskProviderHandling.syncIntervalWriteObserver=null; val cleanup=mutableListOf<Throwable>(); fun attempt(step:() -> Unit) { try { step() } catch (t:Throwable) { cleanup += t } }; listOf(target,creating,recovery,malformed).forEach { account -> attempt { ContentResolver.removePeriodicSync(account,authority,Bundle()) }; attempt { ContentResolver.setSyncAutomatically(account,authority,false) }; attempt { ContentResolver.setIsSyncable(account,authority,0) }; attempt { AndroidCompat.removeAccount(manager,account) } }; attempt { val deadline=android.os.SystemClock.uptimeMillis()+5000; while(manager.getAccountsByType(App.accountType).any { it in listOf(target,creating,recovery,malformed) } && android.os.SystemClock.uptimeMillis()<deadline) android.os.SystemClock.sleep(25); org.junit.Assert.assertTrue(manager.getAccountsByType(App.accountType).none { it in listOf(target,creating,recovery,malformed) }) }; val failure=primary; if (failure!=null) cleanup.forEach { failure.addSuppressed(it) } else cleanup.firstOrNull()?.let { first -> cleanup.drop(1).forEach { first.addSuppressed(it) }; throw first } }
 }
}
