package io.silentsuite.sync.utils
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
class TaskProviderHandlingTest {
 data class Candidate(val id:String)
 @Test fun `explicit creating target alone is admitted`() { val target=Candidate("target"); val sibling=Candidate("sibling"); assertEquals(listOf(target),TaskProviderHandling.eligibleItems(listOf(target,sibling),target,{ left,right -> left.id==right?.id }) { PostLoginSetupState.CREATING }) }
 @Test fun `invalid null and recovery siblings are skipped while established target remains`() { val target=Candidate("target"); val invalid=Candidate("bad"); val recovery=Candidate("recover"); val unknown=Candidate("unknown"); assertEquals(listOf(target),TaskProviderHandling.eligibleItems(listOf(target,invalid,recovery,unknown),null,{ left,right -> left.id==right?.id }) { if(it===invalid) throw IllegalStateException() else if(it===recovery) PostLoginSetupState.RECOVERY_REQUIRED else if(it===unknown) null else PostLoginSetupState.COMPLETE }) }
 @Test fun `account identity requires nonblank exact name and type`() { assertTrue(TaskProviderHandling.sameAccountIdentity("a","t","a","t")); assertFalse(TaskProviderHandling.sameAccountIdentity("a","t","a","other")); assertFalse(TaskProviderHandling.sameAccountIdentity(null,null,null,null)) }
}
