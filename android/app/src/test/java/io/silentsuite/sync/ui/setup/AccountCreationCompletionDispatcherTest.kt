package io.silentsuite.sync.ui.setup
import org.junit.Assert.assertEquals
import org.junit.Test
class AccountCreationCompletionDispatcherTest {
 private class Fake(var stage:Boolean=true):AccountCreationCompletionDispatcher.Seams { val calls=mutableListOf<String>(); override fun stageExact(n:String,t:String,id:String)=stage.also{calls+="stage:$n:$t:$id"}; override fun openSetup(){calls+="setup"};override fun openDashboard(){calls+="dash"};override fun finish(){calls+="finish"} }
 @Test fun `completed stages exact and opens dashboard once`() { val f=Fake();AccountCreationCompletionDispatcher(f).dispatch(AccountCreationCompletionDispatcher.Kind.Dashboard,"n","t","id");assertEquals(listOf("stage:n:t:id","dash","finish"),f.calls) }
 @Test fun `created opens setup and staging failure is terminally inert`() { val ok=Fake();AccountCreationCompletionDispatcher(ok).dispatch(AccountCreationCompletionDispatcher.Kind.Setup,"n","t","id");assertEquals(listOf("stage:n:t:id","setup","finish"),ok.calls);val no=Fake(false);AccountCreationCompletionDispatcher(no).dispatch(AccountCreationCompletionDispatcher.Kind.Dashboard,"n","t","id");assertEquals(listOf("stage:n:t:id"),no.calls) }
 @Test fun `retry busy never dispatches terminal success`() { val f=Fake(); AccountCreationCompletionDispatcher(f).dispatch(AccountCreationCompletionDispatcher.Kind.Retry,"n","t","id"); assertEquals(emptyList<String>(),f.calls) }
}
