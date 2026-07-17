package io.silentsuite.sync

import android.content.ContentResolver
import android.os.Build
import androidx.test.runner.AndroidJUnitRunner

/** Keeps Android 5's SyncManager out of its account-removal concurrency crash during runtime tests. */
class SilentSuiteTestRunner : AndroidJUnitRunner() {
    override fun onStart() {
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.LOLLIPOP) {
            ContentResolver.setMasterSyncAutomatically(false)
        }
        super.onStart()
    }
}
