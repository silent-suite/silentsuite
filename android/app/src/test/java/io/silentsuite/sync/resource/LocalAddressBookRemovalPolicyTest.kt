package io.silentsuite.sync.resource

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalAddressBookRemovalPolicyTest {
    @Test fun `child removal is recorded only after true confirmation`() {
        var recorded = 0
        onConfirmedAddressBookRemoval(false) { recorded++ }
        assertEquals(0, recorded)
        onConfirmedAddressBookRemoval(true) { recorded++ }
        assertEquals(1, recorded)
    }
}
