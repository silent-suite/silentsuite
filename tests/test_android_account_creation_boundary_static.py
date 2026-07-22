"""Static contracts for the durable Android account-created boundary."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COORDINATOR = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/AccountCreationCoordinator.kt"
CREATOR = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/CreateAccountFragment.kt"
SETUP = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/PostLoginSetupActivity.kt"


def test_platform_sync_configuration_is_resumable_post_account_created_work():
    coordinator = COORDINATOR.read_text(encoding="utf-8")
    creator = CREATOR.read_text(encoding="utf-8")
    setup = SETUP.read_text(encoding="utf-8")

    assert 'writeAndReadBack("post_login_setup_state_v1", "ACCOUNT_CREATED")' in coordinator
    assert "configureAndReadBack" not in coordinator
    assert "fun accountCreated" not in coordinator
    assert "override fun configureAndReadBack" not in creator
    assert "override fun accountCreated" not in creator
    assert "PostLoginSyncConfigurator.configure(applicationContext, account)" in setup
    account_created_branch = setup.split("PostLoginSetupState.ACCOUNT_CREATED ->", 1)[1].split(
        "PostLoginSetupState.COLLECTIONS ->", 1
    )[0]
    assert account_created_branch.index("PostLoginSyncConfigurator.configure") < account_created_branch.index(
        "write(PostLoginSetupState.COLLECTIONS)"
    )
