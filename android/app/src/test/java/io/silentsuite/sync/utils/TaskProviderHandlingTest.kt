package io.silentsuite.sync.utils
import android.accounts.Account
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import org.junit.Assert.assertEquals
import org.junit.Test
class TaskProviderHandlingTest { @Test fun `explicit creating target alone is admitted`() { val target=Account("target","t"); val sibling=Account("sibling","t"); assertEquals(listOf(target),TaskProviderHandling.eligibleAccounts(listOf(target,sibling),target) { PostLoginSetupState.CREATING }) }
 @Test fun `invalid null and recovery siblings are skipped while established target remains`() { val target=Account("target","t"); val invalid=Account("bad","t"); val recovery=Account("recover","t"); val unknown=Account("unknown","t"); assertEquals(listOf(target),TaskProviderHandling.eligibleAccounts(listOf(target,invalid,recovery,unknown),null) { if(it===invalid) throw IllegalStateException() else if(it===recovery) PostLoginSetupState.RECOVERY_REQUIRED else if(it===unknown) null else PostLoginSetupState.COMPLETE }) } }
