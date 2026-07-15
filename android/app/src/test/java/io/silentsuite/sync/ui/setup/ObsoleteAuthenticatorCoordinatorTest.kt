package io.silentsuite.sync.ui.setup
import org.junit.Assert.assertEquals
import org.junit.Test
class ObsoleteAuthenticatorCoordinatorTest { @Test fun `cancels clears and launches once`() { val calls=mutableListOf<String>(); ObsoleteAuthenticatorCoordinator(object:ObsoleteAuthenticatorCoordinator.Seams { override fun cancel(){calls+="cancel"}; override fun clearSecrets(){calls+="clear"}; override fun launchNormalOnce(){calls+="launch"} }).handle(); assertEquals(listOf("cancel","clear","launch"),calls) } }
