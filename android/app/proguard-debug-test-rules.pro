# The AndroidX instrumentation runner executes from a separate test APK but
# resolves Kotlin runtime classes from the tested debug app. Keep them in the
# minified debug APK so API-level runtime tests can start. Release does not use
# this rules file.
-keep class kotlin.** { *; }

# The web screen's instrumentation test runs from the test APK and calls these
# AndroidX WebKit entry points in the debug app; R8 must not inline or drop them.
-keep class androidx.webkit.WebViewFeature { *; }
-keep class androidx.webkit.ProfileStore { *; }
