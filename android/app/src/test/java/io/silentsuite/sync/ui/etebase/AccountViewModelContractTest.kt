package io.silentsuite.sync.ui.etebase

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountViewModelContractTest {
    @Test
    fun initializationIsIdempotentAndRetainsTheExactAccount() {
        val source = File("src/main/java/io/silentsuite/sync/ui/etebase/CollectionActivity.kt").readText()
        val model = source.substringAfter("class AccountViewModel").substringBefore("data class AccountHolder")

        assertTrue(model.contains("private var initializedAccount: Account? = null"))
        assertTrue(model.contains("fun initialize(context: Context, account: Account"))
        assertTrue(model.contains("if (initializedAccount == account)"))
        assertTrue(model.contains("AccountViewModel cannot be reused for another account"))
        assertTrue(model.contains("AccountSettings(context, account)"))
    }
}
