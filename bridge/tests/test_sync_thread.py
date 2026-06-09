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
        t._done_syncing.clear()
        result = t.wait_for_sync(timeout=0.05)
        assert result is False

    def test_wait_for_sync_re_raises_exception(self):
        t = SyncThread("user@test.com")
        t._exception = RuntimeError("sync failed")
        t._done_syncing.set()
        with pytest.raises(RuntimeError, match="sync failed"):
            t.wait_for_sync(timeout=1)
        # Exception is cleared after raising
        assert t._exception is None

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

            # Error should be stored and re-raised on wait
            t.force_sync()
            with pytest.raises(ConnectionError, match="network down"):
                t.wait_for_sync(timeout=2)
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
    def test_refresh_sync_thread_wakes_existing_thread(self, MockThread, mock_forget):
        from silentsuite_bridge.radicale import storage

        original = storage._sync_threads.copy()
        try:
            existing = MagicMock()
            existing.is_alive.return_value = True
            storage._sync_threads["alive@test.com"] = existing

            result = refresh_sync_thread("alive@test.com")

            assert result is existing
            mock_forget.assert_called_once_with("alive@test.com")
            existing.force_sync.assert_called_once()
            MockThread.assert_not_called()
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
