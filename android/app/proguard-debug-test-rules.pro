# The AndroidX instrumentation runner executes from a separate test APK but
# resolves Kotlin runtime classes from the tested debug app. Keep them in the
# minified debug APK so API-level runtime tests can start. Release does not use
# this rules file.
-keep class kotlin.** { *; }

# The registry process-boundary instrumentation links to these startup types from the separate
# test APK; keep their members so that linkage never depends on what R8 inlines or removes.
-keep class io.silentsuite.sync.ui.setup.AccountCreationRegistry { *; }
-keep class io.silentsuite.sync.ui.setup.AccountCreationRegistry$* { *; }
-keep class io.silentsuite.sync.ui.setup.PostLoginStartupChecks { *; }
-keep class io.silentsuite.sync.ui.setup.PostLoginStartupChecks$Snapshot { *; }
-keep class io.silentsuite.sync.ui.setup.PostLoginStartupOutcome { *; }
-keep class io.silentsuite.sync.ui.setup.PostLoginStartupOutcome$* { *; }
