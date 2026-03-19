package at.bitfire.ical4android

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assume
import org.junit.Before
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
abstract class AbstractTasksTest(
        providerName: TaskProvider.ProviderName
) {

    companion object {
        @Parameterized.Parameters(name="{0}")
        @JvmStatic
        fun taskProviders() = TaskProvider.ProviderName.values()
    }

    private val providerOrNull: TaskProvider? by lazy {
        TaskProvider.acquire(InstrumentationRegistry.getInstrumentation().targetContext, providerName)
    }
    protected val provider: TaskProvider by lazy {
        Assume.assumeNotNull(providerOrNull)
        providerOrNull!!
    }

    init {
        TestUtils.requestTaskPermissions()
    }

    @Before
    open fun prepare() {
        Ical4Android.log.fine("Using task provider: $provider")
    }

    @After
    open fun shutdown() {
        providerOrNull?.close()
    }

}
