"""Etebase SDK continuity check for an existing Bridge data directory (CI only).

Driven by .github/workflows/bridge-sdk-continuity.yml against a throwaway server and a
synthetic account. It runs under whichever stack is installed (old: Python 3.10 with
etebase 0.31.5 or the macOS arm64 0.31.9 git build; new: Python 3.12 with etebase 0.32.0)
and goes through the Bridge's own code: local_cache.Etebase restores the stored session
and syncs, and the Radicale storage collection serves, writes and tokenises DAV state.

A fixture directory holds:
  data/           SILENTSUITE_DATA_DIR (bridge_data.db)
  session.txt     Account.save(None) output the Bridge would have stored
  account.json    server URL, username and password of the synthetic account
  expected.json   the DAV-visible state, pending local intents, hrefs and sync tokens

Commands:
  seed     sign up the synthetic account and create a calendar and an address book
  init     sign in, store the session, first sync and DAV listing; write expected.json
  check    offline: restore, cache_load every stored blob, compare with expected.json
  mutate   offline: pending DAV create, edit and delete plus a collection meta edit
  push     online: sync, prove the server holds the local state, re-record expected.json
  session  write a new stored session (re-save of the restored one, or a fresh sign-in)

It deliberately lives outside bridge/tests: the unit suite replaces etebase with a mock,
and this check must load the real native module (asserted on every command).
"""

import argparse
import importlib
import importlib.metadata
import json
import logging
import os
import platform
import re
import sys
import time
import types
from pathlib import Path

SEEDS = 8
KINDS = {"etebase.vevent": ".ics", "etebase.vcard": ".vcf"}
MARKER = re.compile(r"cm-([A-Za-z0-9_-]+)")


def fail(message):
    print(f"CONTINUITY FAILURE: {message}", file=sys.stderr)
    sys.exit(1)


def millis():
    return int(time.time() * 1000)


def body(col_type, uid, marker):
    if col_type == "etebase.vcard":
        return (
            "BEGIN:VCARD\r\nVERSION:3.0\r\n"
            f"UID:{uid}\r\nFN:Continuity {marker}\r\nN:{marker};Continuity;;;\r\n"
            f"NOTE:cm-{marker}\r\nEND:VCARD\r\n"
        )
    return (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SilentSuite//continuity//EN\r\n"
        f"BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20261114T120000Z\r\n"
        "DTSTART:20261201T100000Z\r\nDTEND:20261201T110000Z\r\n"
        f"SUMMARY:cm-{marker}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )


def marker_of(text):
    found = MARKER.search(text if isinstance(text, str) else text.decode())
    if not found:
        fail("item without a continuity marker")
    return found.group(1)


# --- environment -----------------------------------------------------------------


def real_sdk(expected_version):
    """Import the real etebase and prove it is the expected native build, not a mock."""
    import etebase

    native = importlib.import_module("etebase.etebase_python")
    native_file = getattr(native, "__file__", None) or ""
    if not native_file.endswith((".so", ".pyd")) or not os.path.isfile(native_file):
        fail(f"etebase.etebase_python is not a native extension ({native_file!r})")
    version = importlib.metadata.version("etebase")
    if expected_version and version != expected_version:
        fail(f"etebase {version} is installed, expected {expected_version}")
    print(
        f"stack: python {platform.python_version()} {platform.system()} {platform.machine()}, "
        f"etebase {version} ({Path(native_file).name}), from {Path(etebase.__file__).parent}"
    )
    return etebase


def bridge(fixture):
    """Point the Bridge at the fixture's data directory, then import it."""
    data = (fixture / "data").resolve()
    os.environ["SILENTSUITE_DATA_DIR"] = str(data)
    os.environ["SILENTSUITE_DATABASE_FILE"] = str(data / "bridge_data.db")
    import silentsuite_bridge
    from silentsuite_bridge.local_cache import Etebase, db, models
    from silentsuite_bridge.radicale import storage

    print(f"bridge source: {Path(silentsuite_bridge.__file__).parent}")
    return types.SimpleNamespace(Etebase=Etebase, db=db, models=models, storage=storage)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def open_service(b, fixture, session_file=None):
    account = read_json(fixture / "account.json")
    session = (session_file or fixture / "session.txt").read_text(encoding="utf-8").strip()
    # Account.restore of the stored session: no sign-in, no password.
    return b.Etebase(account["username"], session, account["server"])


def close(b):
    database = b.db.database_proxy.obj
    if database.is_closed():
        database.connect()
    database.execute_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    database.close()


def dav(b, service, uid):
    return b.storage.Collection(types.SimpleNamespace(etesync=service), f"/{service.username}/{uid}/")


# --- state -----------------------------------------------------------------------


def load_every_blob(b, service):
    """cache_load every stored collection, item and quarantined envelope."""
    m = b.models
    col_mgr = service.etebase.get_collection_manager()
    counts = {"collections": 0, "items": 0, "unresolved": 0}
    with b.db.atomic_connection():
        for cache_col in m.CollectionEntity.select().where(m.CollectionEntity.local_user == service.user):
            col = col_mgr.cache_load(cache_col.eb_col)
            if col.uid != cache_col.uid:
                fail("collection blob does not match its row")
            counts["collections"] += 1
            item_mgr = col_mgr.get_item_manager(col)
            for cache_item in cache_col.items:
                item = item_mgr.cache_load(cache_item.eb_item)
                if cache_item.remote_uid and item.uid != cache_item.remote_uid:
                    fail("item blob does not match its row")
                counts["items"] += 1
            for unresolved in cache_col.dav_unresolved:
                item_mgr.cache_load(unresolved.eb_item)
                counts["unresolved"] += 1
    return counts


def tables(b, service):
    """Hrefs, DAV tokens and pending local intents exactly as stored."""
    m = b.models
    with b.db.atomic_connection():
        cols = list(m.CollectionEntity.select().where(m.CollectionEntity.local_user == service.user))
        hrefs, tokens, pending = [], [], []
        for c in cols:
            if c.dirty or c.new:
                pending.append([c.uid, "collection", c.new, c.dirty, c.deleted])
            for item in c.items:
                mapper = m.HrefMapper.get_or_none(m.HrefMapper.content == item)
                if mapper is not None:
                    hrefs.append([c.uid, item.remote_uid or item.uid, mapper.href, item.deleted])
                if item.dirty or item.new:
                    pending.append([c.uid, item.remote_uid or item.uid, item.new, item.dirty, item.deleted])
            for t in c.dav_sync_tokens:
                tokens.append([c.uid, t.token, t.revision, t.state_hash])
            tokens.append([c.uid, "dav_revision", c.dav_revision, c.local_stoken])
    return {"hrefs": sorted(hrefs), "tokens": sorted(tokens), "pending": sorted(pending)}


def dav_view(b, service):
    """What a DAV client sees: each collection's hrefs and item markers, read through Radicale storage."""
    view = {}
    for collection in service.list():
        if collection.col_type not in KINDS:
            continue
        items = {}
        for item in dav(b, service, collection.uid).get_all():
            items[item.href] = marker_of(item.serialize())
        view[collection.uid] = {
            "type": collection.col_type,
            "description": collection.meta.get("description"),
            "items": items,
        }
    return view


def record(b, service, fixture):
    """Write expected.json from the current state, with one current DAV token per collection."""
    view = dav_view(b, service)
    for uid, col in view.items():
        token, _ = dav(b, service, uid).sync()
        col["token"] = token
    write_json(fixture / "expected.json", {"view": view, "tables": tables(b, service)})
    pending = len(tables(b, service)["pending"])
    print(f"recorded {len(view)} collections, {sum(len(c['items']) for c in view.values())} items, {pending} pending")


def compare(label, actual, expected):
    if actual != expected:
        print(f"{label} expected: {json.dumps(expected, sort_keys=True)}", file=sys.stderr)
        print(f"{label} actual:   {json.dumps(actual, sort_keys=True)}", file=sys.stderr)
        fail(f"{label} changed")


# --- commands --------------------------------------------------------------------


def cmd_seed(args):
    etebase = real_sdk(args.sdk)
    fixture = Path(args.fixture)
    fixture.mkdir(parents=True, exist_ok=True)
    account = {"server": args.server, "username": args.username, "password": os.environ["CONTINUITY_PASSWORD"]}
    write_json(fixture / "account.json", account)
    client = etebase.Client("silentsuite-ci-continuity", args.server)
    user = etebase.User(args.username, f"{args.username}@example.invalid")
    acct = etebase.Account.signup(client, user, account["password"])
    col_mgr = acct.get_collection_manager()
    for col_type, name in (("etebase.vevent", "Continuity calendar"), ("etebase.vcard", "Continuity contacts")):
        col = col_mgr.create(col_type, {"name": name, "description": "cm-seed", "mtime": millis()}, b"")
        col_mgr.upload(col, None)
        item_mgr = col_mgr.get_item_manager(col)
        items = []
        for n in range(1, SEEDS + 1):
            uid = f"continuity-{col_type.split('.')[1]}-seed-{n}"
            items.append(item_mgr.create({"name": uid, "mtime": millis()}, body(col_type, uid, f"seed-{n}").encode()))
        item_mgr.batch(items, None, None)
    acct.logout()
    print(f"seeded 2 collections with {SEEDS} items each")


def cmd_init(args):
    etebase = real_sdk(args.sdk)
    fixture = Path(args.fixture)
    account = read_json(fixture / "account.json")
    client = etebase.Client("silentsuite-bridge", account["server"])
    acct = etebase.Account.login(client, account["username"], account["password"])
    (fixture / "session.txt").write_text(acct.save(None), encoding="utf-8")
    b = bridge(fixture)
    service = open_service(b, fixture)
    service.sync()
    if len(dav_view(b, service)) != 2:
        fail("first sync did not cache both collections")
    record(b, service, fixture)
    close(b)


def cmd_check(args):
    real_sdk(args.sdk)
    fixture = Path(args.fixture)
    expected = read_json(fixture / "expected.json")
    b = bridge(fixture)
    service = open_service(b, fixture, Path(args.session) if args.session else None)
    counts = load_every_blob(b, service)
    compare("stored hrefs/tokens/pending", tables(b, service), expected["tables"])
    view = dav_view(b, service)
    stripped = {uid: {k: v for k, v in col.items() if k != "token"} for uid, col in expected["view"].items()}
    compare("DAV view", view, stripped)
    for uid, col in expected["view"].items():
        token, changed = dav(b, service, uid).sync(col["token"])
        if token != col["token"] or changed:
            fail(f"DAV sync token moved or reported {len(changed)} changes without a DAV write")
    compare("stored hrefs/tokens/pending after DAV sync", tables(b, service), expected["tables"])
    close(b)
    print(
        f"check passed: session restored, {counts['collections']} collection, {counts['items']} item and "
        f"{counts['unresolved']} quarantined blobs loaded, {len(expected['tables']['pending'])} pending intents, "
        "hrefs and DAV tokens unchanged"
    )


def cmd_mutate(args):
    import radicale.item
    import vobject

    real_sdk(args.sdk)
    fixture = Path(args.fixture)
    b = bridge(fixture)
    service = open_service(b, fixture)
    before = len([row for row in tables(b, service)["pending"] if row[1] != "collection"])
    view = dav_view(b, service)
    for uid, col in view.items():
        collection = dav(b, service, uid)
        suffix = KINDS[col["type"]]
        by_marker = {marker: href for href, marker in col["items"].items()}

        def put(href, item_uid, marker):
            vobj = vobject.readOne(body(col["type"], item_uid, marker))
            collection.upload(href, radicale.item.Item(collection_path=collection.path, vobject_item=vobj))

        kind = col["type"].split(".")[1]
        put(f"continuity-{args.tag}-new{suffix}", f"continuity-{kind}-{args.tag}-new", f"{args.tag}-new")
        edit_href = by_marker[f"seed-{args.edit}"]
        edited = collection._get(edit_href)
        put(edit_href, edited.uid, f"{args.tag}-edit")
        collection.delete(by_marker[f"seed-{args.delete}"])
        service.get(uid).update_meta({"description": f"cm-{args.tag}"})
    pending = tables(b, service)["pending"]
    after = len([row for row in pending if row[1] != "collection"])
    if after != before + 6:
        fail(f"expected 6 new pending item intents, found {after - before}")
    if sorted(row[0] for row in pending if row[1] == "collection") != sorted(view):
        fail("collection metadata edits are not pending")
    record(b, service, fixture)
    close(b)


def cmd_push(args):
    etebase = real_sdk(args.sdk)
    fixture = Path(args.fixture)
    expected = read_json(fixture / "expected.json")
    b = bridge(fixture)
    service = open_service(b, fixture)
    service.sync()
    if tables(b, service)["pending"]:
        fail("pending intents left after sync")
    view = dav_view(b, service)
    col_mgr = service.etebase.get_collection_manager()
    for uid, col in view.items():
        remote_col = col_mgr.fetch(uid, None)
        if remote_col.meta.get("description") != col["description"]:
            fail("collection metadata on the server differs from the Bridge")
        item_mgr = col_mgr.get_item_manager(remote_col)
        remote, stoken, done = [], None, False
        while not done:
            page = item_mgr.list(etebase.FetchOptions().stoken(stoken))
            remote += [marker_of(i.content) for i in page.data if not i.deleted]
            stoken, done = page.stoken, page.done
        compare("server items vs Bridge DAV view", sorted(remote), sorted(col["items"].values()))
        old = expected["view"].get(uid)
        if old:
            # The token issued before the upgrade must still be honoured after the push.
            _, changed = dav(b, service, uid).sync(old["token"])
            print(f"pre-push DAV token still valid; delta {len(changed)} hrefs")
            for href, marker in old["items"].items():
                if marker in col["items"].values() and col["items"].get(href) != marker:
                    fail("an item kept its content but moved to a different href")
    record(b, service, fixture)
    close(b)
    print("push passed: no pending intents, server matches the Bridge")


def cmd_session(args):
    etebase = real_sdk(args.sdk)
    fixture = Path(args.fixture)
    account = read_json(fixture / "account.json")
    if args.login:
        client = etebase.Client("silentsuite-bridge", account["server"])
        stored = etebase.Account.login(client, account["username"], account["password"]).save(None)
    else:
        b = bridge(fixture)
        stored = open_service(b, fixture).etebase.save(None)
        close(b)
    Path(args.out).write_text(stored, encoding="utf-8")
    print(f"wrote a stored session ({'fresh sign-in' if args.login else 're-save of the restored session'})")


def main():
    logging.basicConfig(level=logging.WARNING)
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("seed", "init", "check", "mutate", "push", "session"):
        p = sub.add_parser(name)
        p.add_argument("fixture")
        p.add_argument("--sdk", required=True, help="exact etebase version this stack must load")
    sub.choices["seed"].add_argument("--server", required=True)
    sub.choices["seed"].add_argument("--username", required=True)
    sub.choices["check"].add_argument("--session", help="stored session file to restore instead of session.txt")
    for option in ("--tag", "--edit", "--delete"):
        sub.choices["mutate"].add_argument(option, required=True)
    sub.choices["session"].add_argument("--out", required=True)
    sub.choices["session"].add_argument("--login", action="store_true", help="fresh sign-in instead of a re-save")
    args = parser.parse_args()
    globals()[f"cmd_{args.command}"](args)


if __name__ == "__main__":
    main()
