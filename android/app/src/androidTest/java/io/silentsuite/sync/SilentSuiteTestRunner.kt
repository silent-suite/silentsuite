package io.silentsuite.sync

import android.app.Application
import android.os.Bundle
import androidx.test.runner.AndroidJUnitRunner
import io.silentsuite.sync.ui.setup.RegistryProcessBoundaryProbe

/** Captures registry process-boundary evidence before the real application starts. */
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
}
