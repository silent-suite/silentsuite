package io.silentsuite.sync

import android.app.Application
import android.content.ContentResolver
import android.os.Build
import android.os.Bundle
import androidx.test.runner.AndroidJUnitRunner
import io.silentsuite.sync.ui.setup.RegistryProcessBoundaryProbe

/** Keeps Android 5's SyncManager out of its account-removal concurrency crash during runtime tests. */
class SilentSuiteTestRunner : AndroidJUnitRunner() {
    private var registryBoundaryProbe = false

    override fun onCreate(arguments: Bundle?) {
        registryBoundaryProbe = arguments?.getString(RegistryProcessBoundaryProbe.RUNNER_ARGUMENT) == "true"
        super.onCreate(arguments)
    }

    /** Only the registry process-boundary lane opts in; every other lane is unchanged. */
    override fun callApplicationOnCreate(app: Application) {
        if (registryBoundaryProbe) RegistryProcessBoundaryProbe.captureBeforeLaunch(app)
        super.callApplicationOnCreate(app)
    }

    override fun onStart() {
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.LOLLIPOP) {
            ContentResolver.setMasterSyncAutomatically(false)
        }
        super.onStart()
    }
}
