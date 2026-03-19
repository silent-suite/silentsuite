package at.bitfire.ical4android

@Target(AnnotationTarget.CLASS, AnnotationTarget.CONSTRUCTOR, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY)
@Retention(AnnotationRetention.SOURCE)
@MustBeDocumented
/**
 * Requires the current thread's [Thread.getContextClassLoader] to be set (not null).
 */
annotation class UsesThreadContextClassLoader