"""Per-account Etebase session coordination regressions."""

import threading

import pytest

from silentsuite_bridge.radicale import etesync_cache


def test_wedged_account_session_does_not_block_another_account(monkeypatch):
    monkeypatch.setattr(
        etesync_cache._etesync_cache,
        "etesync_for_user",
        lambda user: (object(), False),
    )
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()

    def hold_first_account():
        with etesync_cache.etesync_for_user("first@example.com"):
            first_entered.set()
            release_first.wait(2)

    def enter_second_account():
        with etesync_cache.etesync_for_user("second@example.com"):
            second_entered.set()

    first = threading.Thread(target=hold_first_account)
    second = threading.Thread(target=enter_second_account)
    first.start()
    assert first_entered.wait(1)
    second.start()
    try:
        assert second_entered.wait(0.2)
    finally:
        release_first.set()
        first.join(1)
        second.join(1)


def test_same_account_session_remains_serialized(monkeypatch):
    monkeypatch.setattr(
        etesync_cache._etesync_cache,
        "etesync_for_user",
        lambda user: (object(), False),
    )
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()

    def hold_account():
        with etesync_cache.etesync_for_user("same@example.com"):
            first_entered.set()
            release_first.wait(2)

    def reenter_account():
        with etesync_cache.etesync_for_user("same@example.com"):
            second_entered.set()

    first = threading.Thread(target=hold_account)
    second = threading.Thread(target=reenter_account)
    first.start()
    assert first_entered.wait(1)
    second.start()
    try:
        assert not second_entered.wait(0.1)
    finally:
        release_first.set()
        first.join(1)
        second.join(1)
    assert second_entered.is_set()


def test_same_account_read_session_bypasses_wedged_exclusive_session(monkeypatch):
    shared = object()
    local_reader = object()
    monkeypatch.setattr(
        etesync_cache._etesync_cache,
        "etesync_for_user",
        lambda user: (shared, False),
    )
    monkeypatch.setattr(
        etesync_cache._etesync_cache,
        "fresh_for_user",
        lambda user: (local_reader, True),
        raising=False,
    )
    exclusive_entered = threading.Event()
    release_exclusive = threading.Event()
    reader_result = []

    def hold_exclusive_session():
        with etesync_cache.etesync_for_user("same@example.com"):
            exclusive_entered.set()
            release_exclusive.wait(2)

    def open_local_reader():
        with etesync_cache.etesync_for_user(
            "same@example.com", exclusive=False
        ) as result:
            reader_result.append(result)

    exclusive = threading.Thread(target=hold_exclusive_session)
    reader = threading.Thread(target=open_local_reader)
    exclusive.start()
    assert exclusive_entered.wait(1)
    reader.start()
    try:
        reader.join(0.2)
        assert reader_result == [(local_reader, True)]
    finally:
        release_exclusive.set()
        exclusive.join(1)
        reader.join(1)


def test_exclusive_session_wait_has_a_bounded_timeout(monkeypatch):
    monkeypatch.setattr(
        etesync_cache._etesync_cache,
        "etesync_for_user",
        lambda user: (object(), False),
    )
    entered = threading.Event()
    release = threading.Event()

    def hold_session():
        with etesync_cache.etesync_for_user("same@example.com"):
            entered.set()
            release.wait(2)

    holder = threading.Thread(target=hold_session)
    holder.start()
    assert entered.wait(1)
    try:
        with pytest.raises(etesync_cache.EteSyncBusyError):
            with etesync_cache.etesync_for_user(
                "same@example.com", timeout=0.01
            ):
                pass
    finally:
        release.set()
        holder.join(1)


def test_forget_user_does_not_wait_for_wedged_exclusive_session(monkeypatch):
    monkeypatch.setattr(
        etesync_cache._etesync_cache,
        "etesync_for_user",
        lambda user: (object(), False),
    )
    forgotten = threading.Event()
    monkeypatch.setattr(
        etesync_cache._etesync_cache,
        "forget_user",
        lambda user: forgotten.set(),
    )
    entered = threading.Event()
    release = threading.Event()

    def hold_session():
        with etesync_cache.etesync_for_user("same@example.com"):
            entered.set()
            release.wait(2)

    holder = threading.Thread(target=hold_session)
    holder.start()
    assert entered.wait(1)
    try:
        etesync_cache.forget_etesync_user("same@example.com")
        assert forgotten.wait(0.1)
        with etesync_cache.account_maintenance(
            "same@example.com", timeout=0
        ) as available:
            assert available is False
    finally:
        release.set()
        holder.join(1)
