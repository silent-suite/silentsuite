package io.silentsuite.sync.ui.setup
import android.os.Bundle
class StaleLoginHarnessActivity : LoginActivity() {
 companion object { var restored: Bundle?=null }
 override fun onCreate(state: Bundle?) { super.onCreate(restored ?: state) }
}
