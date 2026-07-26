# The AndroidX instrumentation runner executes from a separate test APK but
# resolves Kotlin runtime classes from the tested debug app. Keep them in the
# minified debug APK so API-level runtime tests can start. Release does not use
# this rules file.
-keep class kotlin.** { *; }
