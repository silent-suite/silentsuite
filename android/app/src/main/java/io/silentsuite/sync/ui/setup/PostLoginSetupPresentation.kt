package io.silentsuite.sync.ui.setup

/** Pure presentation selected from setup state and non-durable display facts. */
data class PostLoginSetupPresentation(
    val stage: Stage,
    val title: Title,
    val body: Body,
) {
    enum class Stage { CONNECT, PREPARE, READY }
    enum class Title {
        CREATING,
        ACCOUNT_CREATED,
        SYNC_CONFIGURATION_FAILED,
        COLLECTIONS,
        COLLECTIONS_FAILED,
        PERMISSIONS_LOADING,
        PERMISSIONS,
        INITIAL_SYNC,
        READY,
        COMPLETE,
        PERMISSION_DENIED,
        PERMISSION_BLOCKED,
        REMOVAL_FAILED,
        AMBIGUOUS,
    }
    enum class Body {
        CREATING,
        ACCOUNT_CREATED,
        SYNC_CONFIGURATION_FAILED,
        COLLECTIONS,
        COLLECTIONS_FAILED,
        PERMISSIONS_LOADING,
        PERMISSIONS,
        PERMISSION_DENIED,
        PERMISSION_BLOCKED,
        NO_TASK_PROVIDER,
        INITIAL_SYNC,
        READY,
        COMPLETE,
        RECOVERY,
        REMOVAL_PENDING,
        REMOVAL_FAILED,
        AMBIGUOUS,
    }
}

fun presentationFor(
    state: PostLoginSetupState,
    condition: PostLoginSetupPresentationCondition =
        PostLoginSetupPresentationCondition.DEFAULT,
    noTaskProvider: Boolean = false,
): PostLoginSetupPresentation {
    if (condition == PostLoginSetupPresentationCondition.AMBIGUOUS) {
        return presentation(
            PostLoginSetupPresentation.Stage.CONNECT,
            PostLoginSetupPresentation.Title.AMBIGUOUS,
            PostLoginSetupPresentation.Body.AMBIGUOUS,
        )
    }
    val presentation = when (state) {
        PostLoginSetupState.CREATING ->
            presentation(
                PostLoginSetupPresentation.Stage.CONNECT,
                PostLoginSetupPresentation.Title.CREATING,
                PostLoginSetupPresentation.Body.CREATING,
            )
        PostLoginSetupState.ACCOUNT_CREATED ->
            if (condition == PostLoginSetupPresentationCondition.SYNC_CONFIGURATION_FAILED) {
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.SYNC_CONFIGURATION_FAILED,
                    PostLoginSetupPresentation.Body.SYNC_CONFIGURATION_FAILED,
                )
            } else {
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.ACCOUNT_CREATED,
                    PostLoginSetupPresentation.Body.ACCOUNT_CREATED,
                )
            }
        PostLoginSetupState.COLLECTIONS ->
            if (condition == PostLoginSetupPresentationCondition.INVENTORY_RECOVERY) {
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.COLLECTIONS_FAILED,
                    PostLoginSetupPresentation.Body.COLLECTIONS_FAILED,
                )
            } else {
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.COLLECTIONS,
                    PostLoginSetupPresentation.Body.COLLECTIONS,
                )
            }
        PostLoginSetupState.PERMISSIONS -> when (condition) {
            PostLoginSetupPresentationCondition.PERMISSION_BLOCKED ->
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.PERMISSION_BLOCKED,
                    PostLoginSetupPresentation.Body.PERMISSION_BLOCKED,
                )
            PostLoginSetupPresentationCondition.PERMISSION_DENIED ->
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.PERMISSION_DENIED,
                    PostLoginSetupPresentation.Body.PERMISSION_DENIED,
                )
            PostLoginSetupPresentationCondition.INVENTORY_LOADING ->
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.PERMISSIONS_LOADING,
                    PostLoginSetupPresentation.Body.PERMISSIONS_LOADING,
                )
            PostLoginSetupPresentationCondition.INVENTORY_RECOVERY ->
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.COLLECTIONS_FAILED,
                    PostLoginSetupPresentation.Body.COLLECTIONS_FAILED,
                )
            else ->
                presentation(
                    PostLoginSetupPresentation.Stage.PREPARE,
                    PostLoginSetupPresentation.Title.PERMISSIONS,
                    if (noTaskProvider) {
                        PostLoginSetupPresentation.Body.NO_TASK_PROVIDER
                    } else {
                        PostLoginSetupPresentation.Body.PERMISSIONS
                    },
                )
        }
        PostLoginSetupState.INITIAL_SYNC ->
            presentation(
                PostLoginSetupPresentation.Stage.PREPARE,
                PostLoginSetupPresentation.Title.INITIAL_SYNC,
                PostLoginSetupPresentation.Body.INITIAL_SYNC,
            )
        PostLoginSetupState.READY ->
            presentation(
                PostLoginSetupPresentation.Stage.READY,
                PostLoginSetupPresentation.Title.READY,
                PostLoginSetupPresentation.Body.READY,
            )
        PostLoginSetupState.COMPLETE ->
            presentation(
                PostLoginSetupPresentation.Stage.READY,
                PostLoginSetupPresentation.Title.COMPLETE,
                PostLoginSetupPresentation.Body.COMPLETE,
            )
        PostLoginSetupState.RECOVERY_REQUIRED ->
            presentation(
                PostLoginSetupPresentation.Stage.CONNECT,
                when (condition) {
                    PostLoginSetupPresentationCondition.REMOVAL_FAILED ->
                        PostLoginSetupPresentation.Title.REMOVAL_FAILED
                    PostLoginSetupPresentationCondition.AMBIGUOUS ->
                        PostLoginSetupPresentation.Title.AMBIGUOUS
                    else -> PostLoginSetupPresentation.Title.CREATING
                },
                when (condition) {
                    PostLoginSetupPresentationCondition.REMOVAL_PENDING ->
                        PostLoginSetupPresentation.Body.REMOVAL_PENDING
                    PostLoginSetupPresentationCondition.REMOVAL_FAILED ->
                        PostLoginSetupPresentation.Body.REMOVAL_FAILED
                    PostLoginSetupPresentationCondition.AMBIGUOUS ->
                        PostLoginSetupPresentation.Body.AMBIGUOUS
                    else -> PostLoginSetupPresentation.Body.RECOVERY
                },
            )
    }
    return presentation
}

enum class PostLoginSetupPresentationCondition {
    DEFAULT,
    SYNC_CONFIGURATION_FAILED,
    INVENTORY_LOADING,
    INVENTORY_RECOVERY,
    PERMISSION_DENIED,
    PERMISSION_BLOCKED,
    REMOVAL_PENDING,
    REMOVAL_FAILED,
    AMBIGUOUS,
}

private fun presentation(
    stage: PostLoginSetupPresentation.Stage,
    title: PostLoginSetupPresentation.Title,
    body: PostLoginSetupPresentation.Body,
) = PostLoginSetupPresentation(stage, title, body)
