package io.silentsuite.sync.resource

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import at.bitfire.ical4android.LegacyRecorderFloor
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.TimeZone
import java.util.UUID

/**
 * D2 N2: runs the shared positive [LegacyRecorderFloor] on the device runtime inside the product (debug) APK and writes
 * one schema-1 carrier file per method to the target app's files directory, for host retrieval by
 * `android/scripts/run-legacy-recorder-runtime.sh` via `run-as`.
 *
 * Prerequisites: a fresh dedicated emulator, empty app state, no account fixtures. The fixtures are provider-free; app
 * startup is unchanged. Evidence collection only: no restriction, no production reader, no ART success/safety claim.
 */
@RunWith(AndroidJUnit4::class)
class LegacyUnknownPropertyRecorderRuntimeTest {

    @Test
    fun testLegacyRecorder_RoutedPropertyFamilies_RoundTrip() =
            runGroup("testLegacyRecorder_RoutedPropertyFamilies_RoundTrip", "routed-properties") { it.routedPropertyFamilies() }

    @Test
    fun testLegacyRecorder_ClazzForms_RoundTrip() =
            runGroup("testLegacyRecorder_ClazzForms_RoundTrip", "clazz") { it.clazzForms() }

    @Test
    fun testLegacyRecorder_DefaultParameterFamilies_RoundTrip() =
            runGroup("testLegacyRecorder_DefaultParameterFamilies_RoundTrip", "default-parameters") { it.defaultParameterFamilies() }

    @Test
    fun testLegacyRecorder_DateTimeValueShapes_RoundTrip() =
            runGroup("testLegacyRecorder_DateTimeValueShapes_RoundTrip", "date-time-shapes") { it.dateTimeValueShapes() }

    @Test
    fun testLegacyRecorder_ParsedEventUnknownProperties_RoundTrip() =
            runGroup("testLegacyRecorder_ParsedEventUnknownProperties_RoundTrip", "parsed-event") { it.parsedEventUnknownProperties() }


    /** Primary test exception is never replaced by a capture failure (v3 §6). */
    private fun runGroup(method: String, group: String, body: (LegacyRecorderFloor) -> Unit) {
        val nonce = InstrumentationRegistry.getArguments().getString(NONCE_ARGUMENT)
        if (nonce == null || !NONCE.matches(nonce))
            throw AssertionError("setup: instrumentation argument $NONCE_ARGUMENT missing or invalid: $nonce")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val sink = ArtFileSink.open(context, nonce, method, group)   // a throw here is a setup failure (no primary yet)

        var primary: Throwable? = null
        try {
            writeRuntimeProvenance(sink)
            body(LegacyRecorderFloor { sink.line(it) })
        } catch (t: Throwable) {
            primary = t
        }
        var capture: Throwable? = null
        try {
            sink.finish(if (primary == null) "PASS" else "FAIL")
        } catch (t: Throwable) {
            capture = t
            Log.e(LOG_TAG, "D2-RECORDER-CAPTURE-FAILED method=$method nonce=$nonce error=${t.javaClass.name}")
        }
        val primaryFailure = primary
        val captureFailure = capture
        if (primaryFailure != null) {
            if (captureFailure != null)
                primaryFailure.addSuppressed(captureFailure)
            throw primaryFailure
        }
        if (captureFailure != null)
            throw AssertionError("capture: finalize failed for $method", captureFailure)
    }

    /** Presence and class-loader facts only; no artifact identity is claimed on the device. */
    private fun writeRuntimeProvenance(sink: ArtFileSink) {
        val loader = LegacyRecorderFloor::class.java.classLoader
        val names = listOf("java.time.Ser", "java.time.Duration", "java.time.ZoneOffset", "j\$.time.Ser", "j\$.time.Duration",
                TimeZone.getDefault().javaClass.name)
        for (name in names) {
            val cls = try {
                Class.forName(name, false, loader)
            } catch (e: ClassNotFoundException) {
                null
            } catch (e: LinkageError) {
                null
            }
            val loaderName = when {
                cls == null -> "none"
                cls.classLoader == null -> "boot"
                else -> cls.classLoader!!.javaClass.name
            }
            sink.line("D2-RECORDER provenance-runtime class=$name present=${cls != null} loader=$loaderName")
        }
    }


    /** Schema-1 carrier (v3 §3): UTF-8, LF-only, escaped floor lines, percent-encoded BEGIN/END values, atomic rename. */
    private class ArtFileSink private constructor(
            private val method: String,
            private val group: String,
            private val nonce: String,
            private val packageName: String,
            private val temp: File,
            private val target: File,
            private val stream: FileOutputStream
    ) {
        private val digest = MessageDigest.getInstance("SHA-256")
        private val keys = mutableListOf<Triple<String, String, String>>()
        private var lines = 0
        private var records = 0
        private var failures = 0

        /** One floor line, escaped so that it stays a single LF-terminated carrier line. */
        fun line(text: String) = writeLine(escape(text))

        private fun writeLine(raw: String) {
            val bytes = (raw + "\n").toByteArray(Charsets.UTF_8)
            stream.write(bytes)
            digest.update(bytes)
            lines++
            RECORD_LINE.matchEntire(raw)?.let { match ->
                records++
                keys += Triple(match.groupValues[1], match.groupValues[2], match.groupValues[3])
                if (match.groupValues[4].startsWith("status=FAILED"))
                    failures++
            }
        }

        fun finish(status: String) {
            val end = "D2-RECORDER-END schema=1 method=${pct(method)} group=${pct(group)} nonce=${pct(nonce)} " +
                    "package=${pct(packageName)} lines=$lines records=$records failures=$failures " +
                    "keysSha256=${LegacyRecorderFloor.canonicalKeySha256(keys)} status=$status " +
                    "sha256=${LegacyRecorderFloor.hex(digest.digest())}"
            try {
                stream.write((end + "\n").toByteArray(Charsets.UTF_8))
                stream.flush()
                stream.fd.sync()
            } finally {
                stream.close()
            }
            check(!target.exists() && temp.renameTo(target)) { "atomic rename to ${target.name} failed" }
            Log.i(LOG_TAG, end)
        }

        companion object {
            fun open(context: Context, nonce: String, method: String, group: String): ArtFileSink {
                val directory = File(context.filesDir, "d2-legacy-recorder/$nonce").apply { mkdirs() }
                check(directory.isDirectory) { "setup: cannot create ${directory.path}" }
                val target = File(directory, "$method.txt")
                check(!target.exists()) { "setup: carrier ${target.name} already exists" }
                val temp = File(directory, ".$method.${UUID.randomUUID()}.tmp")
                check(temp.createNewFile()) { "setup: cannot create temp carrier" }
                val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
                val sink = ArtFileSink(method, group, nonce, context.packageName, temp, target, FileOutputStream(temp))
                sink.writeLine("D2-RECORDER-BEGIN schema=1 method=${pct(method)} group=${pct(group)} nonce=${pct(nonce)} " +
                        "package=${pct(context.packageName)} versionCode=${packageInfo.longVersionCode} " +
                        "versionName=${pct(packageInfo.versionName.orEmpty())} sdk=${Build.VERSION.SDK_INT} " +
                        "abi=${pct(Build.SUPPORTED_ABIS.firstOrNull().orEmpty())} fingerprint=${pct(Build.FINGERPRINT)} " +
                        "securityPatch=${pct(Build.VERSION.SECURITY_PATCH)} vm=${pct(System.getProperty("java.vm.version").orEmpty())}")
                return sink
            }
        }
    }

    companion object {
        private const val LOG_TAG = "D2LegacyRecorder"
        private const val NONCE_ARGUMENT = "d2RecorderNonce"
        private val NONCE = Regex("[A-Za-z0-9._-]+")
        private val RECORD_LINE = Regex("D2-RECORDER group=(\\S+) family=(\\S+) variant=(\\S+) (class=\\S+ descriptors=\\S*|status=FAILED error=.*)")

        /** `\` -> `\\`, LF -> `\n`, CR -> `\r` (in this order). */
        private fun escape(text: String): String =
                text.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")

        /** RFC 3986 percent-encoding over UTF-8; unreserved characters are kept. */
        private fun pct(value: String): String {
            val out = StringBuilder()
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val c = byte.toInt() and 0xFF
                val ch = c.toChar()
                if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '-' || ch == '.' || ch == '_' || ch == '~')
                    out.append(ch)
                else
                    out.append('%').append("%02X".format(c))
            }
            return out.toString()
        }
    }
}
