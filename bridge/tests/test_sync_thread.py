"""Tests for the SyncThread timing and coordination."""

import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from silentsuite_bridge.radicale.storage import (
    SyncThread,
    refresh_sync_thread,
    start_sync_thread,
    stop_sync_thread,
)


class TestSyncThread:
    """Test SyncThread force/request/wait semantics."""

    def test_force_sync_sets_event(self):
        t = SyncThread("user@test.com")
        assert not t.forced_sync
        t.force_sync()
        assert t.forced_sync

    def test_force_sync_clears_done_event(self):
        t = SyncThread("user@test.com")
        assert t._done_syncing.is_set()
        t.force_sync()
        assert not t._done_syncing.is_set()

    def test_repeated_force_sync_requests_join_one_generation(self):
        t = SyncThread("user@test.com")

        first_generation = t.force_sync()
        second_generation = t.force_sync()

        assert first_generation == 1
        assert second_generation == first_generation
        assert t.generation_status(first_generation)["state"] == "pending"

    def test_request_sync_skips_when_recent(self):
        t = SyncThread("user@test.com")
        t.last_sync = time.time()  # just synced
        t.request_sync()
        assert not t.forced_sync  # should NOT force because < SYNC_MINIMUM

    def test_request_sync_forces_when_stale(self):
        t = SyncThread("user@test.com")
        t.last_sync = time.time() - 9999  # very old
        t.request_sync()
        assert t.forced_sync

    def test_request_sync_forces_when_no_last_sync(self):
        t = SyncThread("user@test.com")
        t.last_sync = None
        t.request_sync()
        # request_sync only fires if last_sync is truthy and stale
        assert not t.forced_sync

    def test_wait_for_sync_returns_immediately_when_done(self):
        t = SyncThread("user@test.com")
        # _done_syncing is set by default
        assert t.wait_for_sync(timeout=0.1) is True

    def test_wait_for_sync_times_out(self):
        t = SyncThread("user@test.com")
        t.force_sync()
        result = t.wait_for_sync(timeout=0.05)
        assert result is False

    def test_wait_for_sync_reports_generation_failure_for_every_waiter(self):
        t = SyncThread("user@test.com")
        generation = t.force_sync()
        t._begin_generation()
        t._complete_generation(
            generation,
            "failed",
            time.time(),
            error_code="ConnectionError",
        )
        for _ in range(2):
            with pytest.raises(RuntimeError, match="ConnectionError"):
                t.wait_for_sync(timeout=1)

    def test_set_interval(self):
        t = SyncThread("user@test.com")
        t.set_interval(60)
        assert t.interval == 60

    def test_set_interval_wakes_wait(self):
        t = SyncThread("user@test.com")
        t.set_interval(30)
        # Setting interval should set _force_sync to wake the wait
        assert t._force_sync.is_set()

    def test_stop_sets_stop_event_and_wakes_wait(self):
        t = SyncThread("user@test.com")
        t.stop()
        assert t._stop_sync.is_set()
        assert t._force_sync.is_set()


class TestSyncThreadRun:
    """Test the SyncThread.run() loop with mocked etesync."""

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.update_status")
    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    def test_run_syncs_and_sets_done(self, mock_log, mock_status, mock_etesync_ctx):
        mock_etesync = MagicMock()
        mock_etesync.list.return_value = []
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        t = SyncThread("user@test.com", daemon=True)
        t.interval = 0.05  # short interval for testing

        t.start()
        try:
            time.sleep(0.2)

            assert t.last_sync is not None
            mock_etesync.sync.assert_called()
            # Thread should still be alive (looping)
            assert t.is_alive()
        finally:
            t.stop()
            t.join(1)

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.update_status")
    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    def test_force_sync_wakes_thread(self, mock_log, mock_status, mock_etesync_ctx):
        mock_etesync = MagicMock()
        mock_etesync.list.return_value = []
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        t = SyncThread("user@test.com", daemon=True)
        t.interval = 300  # very long so it only syncs when forced

        t.start()
        try:
            time.sleep(0.15)  # let initial sync complete
            initial_count = mock_etesync.sync.call_count

            t.force_sync()
            t.wait_for_sync(timeout=2)

            assert mock_etesync.sync.call_count > initial_count
        finally:
            t.stop()
            t.join(1)


    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.update_status")
    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    def test_sync_error_captured(self, mock_log, mock_status, mock_etesync_ctx):
        mock_etesync = MagicMock()
        mock_etesync.sync.side_effect = ConnectionError("network down")
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        t = SyncThread("user@test.com", daemon=True)
        t.interval = 300

        t.start()
        try:
            time.sleep(0.15)

            # Failure is retained on the requested generation for every waiter.
            t.force_sync()
            with pytest.raises(RuntimeError, match="ConnectionError"):
                t.wait_for_sync(timeout=2)
            assert "network down" not in str(mock_log.call_args_list)
            assert "network down" not in str(mock_status.call_args_list)
            assert mock_status.call_args.kwargs["error"] == "ConnectionError"
        finally:
            t.stop()
            t.join(1)


    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.update_status")
    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    def test_requested_generation_reports_success_after_completion(
        self, mock_log, mock_status, mock_etesync_ctx
    ):
        mock_etesync = MagicMock()
        mock_etesync.list.return_value = []
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)
        t = SyncThread("user@test.com", daemon=True)
        t.interval = 300
        generation = t.force_sync()

        t.start()
        try:
            assert t.wait_for_generation(generation, timeout=2) is True
            status = t.generation_status(generation)
            assert status["state"] == "succeeded"
            assert status["completed_at"] is not None
            assert t.last_sync == status["completed_at"]
        finally:
            t.stop()
            t.join(1)

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.update_status")
    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    def test_failed_generation_is_sanitized_and_does_not_advance_last_sync(
        self, mock_log, mock_status, mock_etesync_ctx
    ):
        mock_etesync = MagicMock()
        mock_etesync.sync.side_effect = ConnectionError("private endpoint details")
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)
        t = SyncThread("user@test.com", daemon=True)
        t.interval = 300
        generation = t.force_sync()

        t.start()
        try:
            assert t.wait_for_generation(generation, timeout=2) is True
            status = t.generation_status(generation)
            assert status["state"] == "failed"
            assert status["error_code"] == "ConnectionError"
            assert "private endpoint details" not in str(status)
            assert t.last_sync is None
            assert "private endpoint details" not in str(mock_log.call_args_list)
        finally:
            t.stop()
            t.join(1)


class TestStartSyncThread:
    """Test the start_sync_thread helper."""

    @patch("silentsuite_bridge.radicale.storage.SyncThread")
    def test_starts_new_thread(self, MockThread):
        from silentsuite_bridge.radicale import storage
        # Clear global registry
        original = storage._sync_threads.copy()
        storage._sync_threads.clear()
        try:
            mock_thread = MagicMock()
            mock_thread.is_alive.return_value = True
            MockThread.return_value = mock_thread

            result = start_sync_thread("new@test.com")
            assert result is mock_thread
            mock_thread.start.assert_called_once()
        finally:
            storage._sync_threads = original

    @patch("silentsuite_bridge.radicale.storage.SyncThread")
    def test_returns_existing_alive_thread(self, MockThread):
        from silentsuite_bridge.radicale import storage
        original = storage._sync_threads.copy()
        try:
            existing = MagicMock()
            existing.is_alive.return_value = True
            storage._sync_threads["alive@test.com"] = existing

            result = start_sync_thread("alive@test.com")
            assert result is existing
            MockThread.assert_not_called()
        finally:
            storage._sync_threads = original

    @patch("silentsuite_bridge.radicale.storage.SyncThread")
    def test_replaces_alive_worker_that_is_already_stopping(self, MockThread):
        from silentsuite_bridge.radicale import storage

        original = storage._sync_threads.copy()
        try:
            existing = MagicMock()
            existing.is_alive.return_value = True
            existing._stop_sync = threading.Event()
            existing._stop_sync.set()
            replacement = MagicMock()
            MockThread.return_value = replacement
            storage._sync_threads["stopping@test.com"] = existing

            result = start_sync_thread("stopping@test.com")

            assert result is replacement
            replacement.start.assert_called_once()
        finally:
            storage._sync_threads = original

    @patch("silentsuite_bridge.radicale.storage.forget_etesync_user")
    @patch("silentsuite_bridge.radicale.storage.SyncThread")
    def test_refresh_sync_thread_starts_new_thread(self, MockThread, mock_forget):
        from silentsuite_bridge.radicale import storage

        original = storage._sync_threads.copy()
        storage._sync_threads.clear()
        try:
            mock_thread = MagicMock()
            mock_thread.is_alive.return_value = True
            MockThread.return_value = mock_thread

            result = refresh_sync_thread("new@test.com")

            assert result is mock_thread
            mock_forget.assert_called_once_with("new@test.com")
            mock_thread.start.assert_called_once()
            mock_thread.force_sync.assert_not_called()
        finally:
            storage._sync_threads = original

    @patch("silentsuite_bridge.radicale.storage.forget_etesync_user")
    @patch("silentsuite_bridge.radicale.storage.SyncThread")
    def test_refresh_sync_thread_replaces_existing_worker(self, MockThread, mock_forget):
        from silentsuite_bridge.radicale import storage

        original = storage._sync_threads.copy()
        try:
            existing = MagicMock()
            existing.is_alive.return_value = True
            existing._stop_sync = threading.Event()
            existing.stop.side_effect = existing._stop_sync.set
            replacement = MagicMock()
            MockThread.return_value = replacement
            storage._sync_threads["alive@test.com"] = existing

            result = refresh_sync_thread("alive@test.com")

            assert result is replacement
            existing.stop.assert_called_once()
            mock_forget.assert_called_once_with("alive@test.com")
            replacement.start.assert_called_once()
        finally:
            storage._sync_threads = original

    def test_stop_sync_thread_missing_user_is_noop(self):
        assert stop_sync_thread("missing@test.com", timeout=0) is True

    def test_stop_sync_thread_removes_stopped_thread(self):
        from silentsuite_bridge.radicale import storage

        original = storage._sync_threads.copy()
        try:
            storage._sync_threads.clear()
            thread = MagicMock()
            thread.is_alive.return_value = False
            storage._sync_threads["stopped@test.com"] = thread

            assert stop_sync_thread("stopped@test.com", timeout=0) is True

            thread.stop.assert_called_once()
            thread.join.assert_called_once_with(0)
            assert "stopped@test.com" not in storage._sync_threads
        finally:
            storage._sync_threads = original

    def test_stop_sync_thread_does_not_join_current_thread(self, monkeypatch):
        from silentsuite_bridge.radicale import storage

        original = storage._sync_threads.copy()
        try:
            storage._sync_threads.clear()
            thread = MagicMock()
            monkeypatch.setattr(threading, "current_thread", lambda: thread)
            storage._sync_threads["self@test.com"] = thread

            assert stop_sync_thread("self@test.com", timeout=0) is False

            thread.stop.assert_called_once()
            thread.join.assert_not_called()
            assert storage._sync_threads["self@test.com"] is thread
        finally:
            storage._sync_threads = original

    @patch("silentsuite_bridge.radicale.storage.SyncThread")
    def test_stop_timeout_keeps_thread_and_prevents_duplicate(self, MockThread):
        from silentsuite_bridge.radicale import storage

        original = storage._sync_threads.copy()
        try:
            storage._sync_threads.clear()
            existing = MagicMock()
            existing.is_alive.return_value = True
            storage._sync_threads["slow@test.com"] = existing

            assert stop_sync_thread("slow@test.com", timeout=0) is False
            assert storage._sync_threads["slow@test.com"] is existing

            assert start_sync_thread("slow@test.com") is existing
            MockThread.assert_not_called()
        finally:
            storage._sync_threads = original


def test_generation_timeout_is_shared_and_terminal():
    thread = SyncThread("account@example.com")
    generation = thread.force_sync(deadline=time.time() - 1)

    assert thread.generation_status(generation)["state"] == "timed_out"

    thread._complete_generation(generation, "succeeded", time.time())
    assert thread.generation_status(generation)["state"] == "timed_out"
    assert thread.force_sync(deadline=time.time() + 30) != generation


def test_completion_after_deadline_is_timeout_without_prior_poll():
    thread = SyncThread("account@example.com")
    deadline = time.time() + 1
    generation = thread.force_sync(deadline=deadline)

    thread._complete_generation(generation, "succeeded", deadline + 1)

    status = thread.generation_status(generation)
    assert status["state"] == "timed_out"
    assert status["completed_at"] == deadline


def test_generation_wait_wakes_at_generation_deadline_without_worker():
    thread = SyncThread("account@example.com")
    generation = thread.force_sync(deadline=time.time() + 0.02)

    assert thread.wait_for_generation(generation, timeout=None) is True
    assert thread.generation_status(generation)["state"] == "timed_out"


def test_stopped_worker_rejects_new_generation_terminally():
    thread = SyncThread("account@example.com")
    thread.stop()

    generation = thread.force_sync()

    assert thread.wait_for_generation(generation, timeout=0) is True
    status = thread.generation_status(generation)
    assert status["state"] == "failed"
    assert status["error_code"] == "SyncStopped"


def test_begin_does_not_revive_timed_out_pending_generation():
    thread = SyncThread("account@example.com")
    generation = thread.force_sync(deadline=time.time() - 1)
    assert thread.generation_status(generation)["state"] == "timed_out"

    begun_generation, _ = thread._begin_generation()

    assert begun_generation == generation
    assert thread.generation_status(generation)["state"] == "timed_out"


def test_force_sync_after_active_generation_queues_successor():
    thread = SyncThread("account@example.com")
    generation = thread.force_sync()
    thread._begin_generation()

    successor = thread.force_sync(after_generation=generation)

    assert successor > generation
    assert thread._requested_generation == successor
    assert thread._force_sync.is_set()

    thread._complete_generation(generation, "succeeded", time.time())

    assert not thread._done_syncing.is_set()
    assert thread.wait_for_sync(timeout=0.01) is False


def test_stop_terminalizes_queued_successor():
    thread = SyncThread("account@example.com")
    generation = thread.force_sync()
    thread._begin_generation()
    successor = thread.force_sync(after_generation=generation)

    thread.stop()

    status = thread.generation_status(successor)
    assert status["state"] == "failed"
    assert status["error_code"] == "SyncStopped"


def test_stop_terminalizes_active_generation_without_native_return():
    thread = SyncThread("account@example.com")
    generation = thread.force_sync()
    thread._begin_generation()

    thread.stop()

    assert thread.wait_for_generation(generation, timeout=0.01)
    status = thread.generation_status(generation)
    assert status["state"] == "failed"
    assert status["error_code"] == "SyncStopped"

    thread._complete_generation(generation, "succeeded", time.time())
    status = thread.generation_status(generation)
    assert status["state"] == "failed"
    assert status["error_code"] == "SyncStopped"


@patch("silentsuite_bridge.radicale.storage.etesync_for_user")
@patch("silentsuite_bridge.radicale.storage.update_status")
@patch("silentsuite_bridge.radicale.storage.log_sync_event")
def test_late_native_success_does_not_publish_connected(
    mock_log, mock_status, mock_etesync_ctx,
):
    mock_etesync = MagicMock()
    mock_etesync.sync.side_effect = lambda: time.sleep(0.05)
    mock_etesync.list.return_value = []
    mock_etesync_ctx.return_value.__enter__ = MagicMock(
        return_value=(mock_etesync, False)
    )
    mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)
    thread = SyncThread("account@example.com", daemon=True)
    thread.interval = 300
    generation = thread.force_sync(deadline=time.time() + 0.01)

    thread.start()
    try:
        assert thread.wait_for_generation(generation, timeout=1)
    finally:
        thread.stop()
        thread.join(1)

    assert thread.generation_status(generation)["state"] == "timed_out"
    assert thread.last_sync is None
    assert not any(
        call.args and call.args[0] == "connected"
        for call in mock_status.call_args_list
    )
    assert not any(
        call.args == ("sync", "Synced account")
        for call in mock_log.call_args_list
    )


@patch("silentsuite_bridge.radicale.storage.etesync_for_user")
@patch("silentsuite_bridge.radicale.storage.update_status")
@patch("silentsuite_bridge.radicale.storage.log_sync_event")
def test_deadline_crossed_during_collection_listing_does_not_publish_success(
    mock_log, mock_status, mock_etesync_ctx,
):
    mock_etesync = MagicMock()
    mock_etesync.list.side_effect = lambda: (time.sleep(0.05) or [])
    mock_etesync_ctx.return_value.__enter__ = MagicMock(
        return_value=(mock_etesync, False)
    )
    mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)
    thread = SyncThread("account@example.com", daemon=True)
    thread.interval = 300
    generation = thread.force_sync(deadline=time.time() + 0.01)

    thread.start()
    try:
        assert thread.wait_for_generation(generation, timeout=1)
    finally:
        thread.stop()
        thread.join(1)

    assert thread.generation_status(generation)["state"] == "timed_out"
    assert thread.last_sync is None
    assert not any(
        call.args and call.args[0] == "connected"
        for call in mock_status.call_args_list
    )
    assert not any(
        call.args == ("sync", "Synced account")
        for call in mock_log.call_args_list
    )


@patch("silentsuite_bridge.radicale.storage.etesync_for_user")
@patch("silentsuite_bridge.radicale.storage.update_status")
@patch("silentsuite_bridge.radicale.storage.log_sync_event")
def test_native_success_after_stop_does_not_restore_removed_account_status(
    mock_log, mock_status, mock_etesync_ctx,
):
    started = threading.Event()
    release = threading.Event()
    mock_etesync = MagicMock()

    def sync():
        started.set()
        assert release.wait(1)

    mock_etesync.sync.side_effect = sync
    mock_etesync_ctx.return_value.__enter__ = MagicMock(
        return_value=(mock_etesync, False)
    )
    mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)
    thread = SyncThread("account@example.com", daemon=True)
    thread.interval = 300
    generation = thread.force_sync()
    thread.start()
    assert started.wait(1)

    thread.stop()
    release.set()
    thread.join(1)

    status = thread.generation_status(generation)
    assert status["state"] == "failed"
    assert status["error_code"] == "SyncStopped"
    assert thread.last_sync is None
    mock_etesync.list.assert_not_called()
    assert not any(
        call.args and call.args[0] == "connected"
        for call in mock_status.call_args_list
    )
    assert not any(
        call.args == ("sync", "Synced account")
        for call in mock_log.call_args_list
    )


@patch("silentsuite_bridge.radicale.storage.etesync_for_user")
@patch("silentsuite_bridge.radicale.storage.update_status")
@patch("silentsuite_bridge.radicale.storage.log_sync_event")
def test_connected_publication_observes_terminal_success(
    mock_log, mock_status, mock_etesync_ctx,
):
    mock_etesync = MagicMock()
    mock_etesync.list.return_value = []
    mock_etesync_ctx.return_value.__enter__ = MagicMock(
        return_value=(mock_etesync, False)
    )
    mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)
    thread = SyncThread("account@example.com", daemon=True)
    thread.interval = 300
    generation = thread.force_sync()
    published_states = []

    def capture_status(state, **_kwargs):
        if state == "connected":
            published_states.append(thread.generation_status(generation)["state"])

    mock_status.side_effect = capture_status
    thread.start()
    try:
        assert thread.wait_for_generation(generation, timeout=1)
    finally:
        thread.stop()
        thread.join(1)

    assert published_states == ["succeeded"]
    assert thread.last_sync is not None
    mock_log.assert_any_call("sync", "Synced account")


@patch("silentsuite_bridge.radicale.storage.etesync_for_user")
@patch("silentsuite_bridge.radicale.storage.update_status")
@patch("silentsuite_bridge.radicale.storage.log_sync_event")
def test_collection_enumeration_failure_is_not_success(
    mock_log, mock_status, mock_etesync_ctx,
):
    mock_etesync = MagicMock()
    mock_etesync.list.side_effect = RuntimeError("private enumeration payload")
    mock_etesync_ctx.return_value.__enter__ = MagicMock(
        return_value=(mock_etesync, False)
    )
    mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)
    thread = SyncThread("account@example.com", daemon=True)
    thread.interval = 300
    generation = thread.force_sync()

    thread.start()
    try:
        assert thread.wait_for_generation(generation, timeout=1)
    finally:
        thread.stop()
        thread.join(1)

    assert thread.generation_status(generation)["state"] == "failed"
    assert thread.last_sync is None
    assert not any(
        call.args and call.args[0] == "connected"
        for call in mock_status.call_args_list
    )
    assert not any(
        call.args == ("sync", "Synced account")
        for call in mock_log.call_args_list
    )


def test_terminal_generation_history_is_bounded():
    thread = SyncThread("account@example.com")
    for _ in range(105):
        generation = thread.force_sync()
        thread._begin_generation()
        thread._complete_generation(generation, "succeeded", time.time())

    assert len(thread._generation_statuses) == 100
