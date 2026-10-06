"""Synthetic fence and conditional-write fixtures (CI only).

Fixture-only schema. Nothing here imports or starts the real server. The
`origin` argument is a synthetic request attribute: these tests cannot show
what real browsers or native/bridge clients send.
"""
import os
import sqlite3
import tempfile
import threading
import unittest

PG_DSN = os.environ.get("OFFLINE744_PG_DSN")
REQUIRE_PG = os.environ.get("OFFLINE744_REQUIRE_PG") == "1"

DDL = [
    "CREATE TABLE principal (id TEXT PRIMARY KEY, web_fenced BOOLEAN NOT NULL)",
    "CREATE TABLE collection (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL)",
    "CREATE TABLE item (uid TEXT PRIMARY KEY, collection_id TEXT NOT NULL, etag TEXT NOT NULL)",
]
SEED = [
    ("INSERT INTO principal (id, web_fenced) VALUES (?, ?)", ("p1", False)),
    ("INSERT INTO collection (id, principal_id) VALUES (?, ?)", ("c1", "p1")),
    ("INSERT INTO item (uid, collection_id, etag) VALUES (?, ?, ?)", ("i1", "c1", "e0")),
]


class Fenced(Exception):
    pass


class Conflict(Exception):
    pass


class Unauthorized(Exception):
    """Test-only expectation: principal/collection/item binding refused."""


# Test-only seeding for the ownership regressions (finding 10). The original
# p1/c1/i1 seed above is unchanged.
OWNERSHIP_SEED = [
    ("INSERT INTO principal (id, web_fenced) VALUES (?, ?)", ("p2", False)),
    ("INSERT INTO collection (id, principal_id) VALUES (?, ?)", ("c2", "p2")),
    ("INSERT INTO collection (id, principal_id) VALUES (?, ?)", ("c1b", "p1")),
    ("INSERT INTO item (uid, collection_id, etag) VALUES (?, ?, ?)", ("i2", "c2", "f0")),
]


class Conn:
    def __init__(self, engine):
        self.engine = engine
        self.raw = engine.connect()

    def x(self, sql, params=()):
        if self.engine.name == "postgresql":
            sql = sql.replace("?", "%s")
        cur = self.raw.cursor()
        cur.execute(sql, params)
        return cur

    def begin(self):
        if self.engine.name == "sqlite":
            self.x("BEGIN IMMEDIATE")  # database-level write lock

    def commit(self):
        if self.engine.name == "sqlite":
            if self.raw.in_transaction:
                self.x("COMMIT")
        else:
            self.raw.commit()

    def rollback(self):
        if self.engine.name == "sqlite":
            if self.raw.in_transaction:
                self.x("ROLLBACK")
        else:
            self.raw.rollback()


def read_fence(conn, principal):
    if conn.engine.name == "postgresql":
        return conn.x("SELECT web_fenced FROM principal WHERE id = ? FOR SHARE", (principal,)).fetchone()[0]
    return conn.x("SELECT web_fenced FROM principal WHERE id = ?", (principal,)).fetchone()[0]


def write(conn, principal, collection, uid, expected, new, endpoint, origin, hook=None, pre_read_fence=None):
    conn.begin()
    try:
        lock = " FOR UPDATE" if conn.engine.name == "postgresql" else ""
        conn.x("SELECT id FROM collection WHERE id = ?" + lock, (collection,))
        fenced = read_fence(conn, principal) if pre_read_fence is None else pre_read_fence
        if hook:
            hook()
        if fenced and endpoint == "batch" and origin:
            raise Fenced()
        row = conn.x("SELECT etag FROM item WHERE uid = ?", (uid,)).fetchone()
        current = row[0] if row else None
        if endpoint == "transaction" and current != expected:
            raise Conflict()
        if row:
            conn.x("UPDATE item SET etag = ? WHERE uid = ?", (new, uid))
        else:
            conn.x("INSERT INTO item (uid, collection_id, etag) VALUES (?, ?, ?)", (uid, collection, new))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def activate(conn, principal):
    conn.begin()
    try:
        if conn.x("UPDATE principal SET web_fenced = ? WHERE id = ?", (True, principal)).rowcount != 1:
            raise LookupError("principal")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


class FenceCases:
    def conn(self):
        c = Conn(self.engine)
        self.conns.append(c)
        return c

    def etag(self, uid):
        c = self.conn()
        value = c.x("SELECT etag FROM item WHERE uid = ?", (uid,)).fetchone()[0]
        c.rollback()
        return value

    def run_threads(self, *targets):
        errors = []

        def wrap(fn):
            def inner():
                try:
                    fn()
                except BaseException as err:  # surfaced to the test thread
                    errors.append(err)
            return inner

        return errors, [threading.Thread(target=wrap(t)) for t in targets]

    def test_stale_transaction_rejected_and_rolled_back(self):
        c = self.conn()
        with self.assertRaises(Conflict):
            write(c, "p1", "c1", "i1", "stale", "e1", "transaction", origin=True)
        self.assertEqual(self.etag("i1"), "e0")
        write(c, "p1", "c1", "i1", "e0", "e1", "transaction", origin=True)
        self.assertEqual(self.etag("i1"), "e1")

    def test_unfenced_batch_overwrites_unconditionally_control(self):
        write(self.conn(), "p1", "c1", "i1", "stale", "old-body", "batch", origin=True)
        self.assertEqual(self.etag("i1"), "old-body")

    def test_fence_rejects_synthetic_browser_batch_only(self):
        activate(self.conn(), "p1")
        with self.assertRaises(Fenced):
            write(self.conn(), "p1", "c1", "i1", None, "x", "batch", origin=True)
        write(self.conn(), "p1", "c1", "i1", None, "originless", "batch", origin=False)
        self.assertEqual(self.etag("i1"), "originless")
        write(self.conn(), "p1", "c1", "i1", "originless", "tx", "transaction", origin=True)
        self.assertEqual(self.etag("i1"), "tx")

    def test_inflight_write_serializes_before_activation(self):
        locked, release, order = threading.Event(), threading.Event(), []

        def old_request():
            write(self.conn(), "p1", "c1", "i1", None, "old", "batch", origin=True,
                  hook=lambda: (locked.set(), release.wait(10)))
            order.append("old-commit")

        def activator():
            activate(self.conn(), "p1")
            order.append("activated")

        errors, (t1, t2) = self.run_threads(old_request, activator)
        t1.start()
        self.assertTrue(locked.wait(10))
        t2.start()
        t2.join(0.5)
        self.assertTrue(t2.is_alive(), "activation must wait for the in-flight writer")
        release.set()
        t1.join(10)
        t2.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(order, ["old-commit", "activated"])
        with self.assertRaises(Fenced):
            write(self.conn(), "p1", "c1", "i1", None, "late", "batch", origin=True)
        self.assertEqual(self.etag("i1"), "old")

    def test_delayed_request_reads_fence_at_commit(self):
        stale_snapshot = read_fence_once(self)  # synthetic: read before activation
        activate(self.conn(), "p1")
        with self.assertRaises(Fenced):
            write(self.conn(), "p1", "c1", "i1", None, "late", "batch", origin=True)
        self.assertEqual(self.etag("i1"), "e0")
        # control: trusting a fence value read before the transaction lets it through
        write(self.conn(), "p1", "c1", "i1", None, "late", "batch", origin=True, pre_read_fence=stale_snapshot)
        self.assertEqual(self.etag("i1"), "late")

    def test_error_rolls_back_and_releases_locks(self):
        def boom():
            raise RuntimeError("synthetic abort")

        with self.assertRaises(RuntimeError):
            write(self.conn(), "p1", "c1", "i1", "e0", "e9", "transaction", origin=True, hook=boom)
        self.assertEqual(self.etag("i1"), "e0")
        errors, (t,) = self.run_threads(lambda: activate(self.conn(), "p1"))
        t.start()
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertEqual(errors, [])

    def test_activation_requires_existing_principal(self):
        with self.assertRaises(LookupError):
            activate(self.conn(), "missing")

    # ---- finding 10 ownership regressions (test-only helpers) ----

    def seed(self, rows):
        c = self.conn()
        c.begin()
        try:
            for sql, params in rows:
                c.x(sql, params)
            c.commit()
        except BaseException:
            c.rollback()
            raise

    def count(self, sql, params):
        c = self.conn()
        value = c.x(sql, params).fetchone()[0]
        c.rollback()
        return value

    def count_item(self, uid, collection, etag):
        return self.count(
            "SELECT COUNT(*) FROM item WHERE uid = ? AND collection_id = ? AND etag = ?", (uid, collection, etag))

    def count_owned(self, principal, collection, uid):
        return self.count(
            "SELECT COUNT(*) FROM item i JOIN collection c ON c.id = i.collection_id "
            "WHERE i.uid = ? AND c.id = ? AND c.principal_id = ?", (uid, collection, principal))

    def integrity_errors(self):
        errors = (sqlite3.IntegrityError,)
        if self.engine.name == "postgresql":
            errors += (self.engine.pg.IntegrityError,)
        return errors

    def test_ownership_seed_cardinality(self):
        self.seed(OWNERSHIP_SEED)
        self.assertEqual(self.count_owned("p1", "c1", "i1"), 1)
        self.assertEqual(self.count_owned("p2", "c2", "i2"), 1)
        self.assertEqual(self.count_owned("p2", "c1", "i1"), 0)
        self.assertEqual(self.count_owned("p1", "c1b", "i1"), 0)

    def test_principal_cannot_write_through_another_owners_collection(self):
        self.seed(OWNERSHIP_SEED)
        activate(self.conn(), "p1")
        with self.assertRaises(Unauthorized, msg="SEMANTIC: unfenced p2 reached p1's collection c1 and item i1"):
            write(self.conn(), "p2", "c1", "i1", None, "p2-body", "batch", origin=True)
        self.assertEqual(self.count_item("i1", "c1", "e0"), 1)
        self.assertEqual(self.count_owned("p1", "c1", "i1"), 1)

    def test_collection_cannot_reach_item_outside_it(self):
        self.seed(OWNERSHIP_SEED)
        for principal, collection in (("p1", "c1b"), ("p2", "c2")):
            with self.subTest(principal=principal, collection=collection):
                with self.assertRaises((Unauthorized, Conflict),
                                       msg="SEMANTIC: write via another collection reached item i1 of c1"):
                    write(self.conn(), principal, collection, "i1", "e0", "via-" + collection, "batch", origin=False)
                self.assertEqual(self.count_item("i1", "c1", "e0"), 1)

    def test_foreign_lock_domain_cannot_change_item_while_owner_collection_locked(self):
        self.seed(OWNERSHIP_SEED)
        held, release, outcomes = threading.Event(), threading.Event(), {}

        def owner_writer():
            try:
                write(self.conn(), "p1", "c1", "i1", "e0", "eA", "transaction", origin=False,
                      hook=lambda: (held.set(), release.wait(10)))
                outcomes["A"] = "committed"
            except (Conflict, Unauthorized) as err:
                outcomes["A"] = type(err).__name__

        def foreign_writer():
            try:
                write(self.conn(), "p1", "c1b", "i1", "e0", "eB", "transaction", origin=False)
                outcomes["B"] = "committed"
            except (Conflict, Unauthorized) as err:
                outcomes["B"] = type(err).__name__

        errors, (ta, tb) = self.run_threads(owner_writer, foreign_writer)
        ta.start()
        self.assertTrue(held.wait(10))
        tb.start()
        tb.join(1.0)
        during = self.count_item("i1", "c1", "e0")
        release.set()
        ta.join(10)
        tb.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(outcomes), ["A", "B"])
        self.assertEqual(during, 1,
                         "SEMANTIC: i1 changed through collection c1b's lock domain while c1 was locked")
        self.assertLessEqual(sum(1 for v in outcomes.values() if v == "committed"), 1)
        self.assertEqual(self.count("SELECT COUNT(*) FROM item WHERE uid = ?", ("i1",)), 1)

    def test_same_owner_collection_item_progression(self):
        self.seed(OWNERSHIP_SEED)
        c = self.conn()
        write(c, "p1", "c1", "i1", "e0", "e1", "transaction", origin=False)
        write(c, "p1", "c1b", "i3", None, "n0", "batch", origin=False)
        write(c, "p1", "c1b", "i3", "n0", "n1", "transaction", origin=False)
        write(c, "p2", "c2", "i2", "f0", "f1", "transaction", origin=True)
        self.assertEqual(self.count_item("i1", "c1", "e1"), 1)
        self.assertEqual(self.count_item("i3", "c1b", "n1"), 1)
        self.assertEqual(self.count_item("i2", "c2", "f1"), 1)
        with self.assertRaises(Conflict):
            write(c, "p1", "c1", "i1", "e0", "stale", "transaction", origin=False)
        self.assertEqual(self.count_item("i1", "c1", "e1"), 1)

    def test_compound_uid_distinct_items_per_collection(self):
        self.seed(OWNERSHIP_SEED)
        try:
            self.seed([("INSERT INTO item (uid, collection_id, etag) VALUES (?, ?, ?)", ("i1", "c1b", "k0"))])
        except self.integrity_errors() as err:
            self.fail("SETUP-SCHEMA (not the ownership RED): fixture schema cannot represent "
                      "a collection-scoped uid: " + type(err).__name__)
        write(self.conn(), "p1", "c1", "i1", "e0", "e1", "transaction", origin=False)
        self.assertEqual(self.count_item("i1", "c1", "e1"), 1)
        self.assertEqual(self.count_item("i1", "c1b", "k0"), 1,
                         "SEMANTIC: write through c1 changed c1b's same-uid item")
        self.assertEqual(self.count("SELECT COUNT(*) FROM item WHERE uid = ?", ("i1",)), 2)


def read_fence_once(case):
    c = case.conn()
    value = c.x("SELECT web_fenced FROM principal WHERE id = ?", ("p1",)).fetchone()[0]
    c.rollback()
    return value


class SqliteEngine:
    name = "sqlite"

    def __init__(self):
        fd, self.path = tempfile.mkstemp(suffix=".sqlite3")
        os.close(fd)

    def connect(self):
        return sqlite3.connect(self.path, timeout=5, isolation_level=None, check_same_thread=False)

    def setup(self):
        c = self.connect()
        for sql in DDL:
            c.execute(sql)
        for sql, params in SEED:
            c.execute(sql, params)
        c.close()

    def teardown(self):
        os.unlink(self.path)


class PgEngine:
    name = "postgresql"

    def __init__(self):
        import psycopg2  # provided by the hash-locked server requirements in CI
        self.pg = psycopg2
        self.schema = "offline744_" + os.urandom(4).hex()

    def connect(self):
        c = self.pg.connect(PG_DSN)
        c.autocommit = False
        c.cursor().execute("SET search_path TO " + self.schema)
        c.commit()
        return c

    def setup(self):
        admin = self.pg.connect(PG_DSN)
        admin.autocommit = True
        cur = admin.cursor()
        cur.execute("CREATE SCHEMA " + self.schema)
        cur.execute("SET search_path TO " + self.schema)
        for sql in DDL:
            cur.execute(sql)
        for sql, params in SEED:
            cur.execute(sql.replace("?", "%s"), params)
        admin.close()

    def teardown(self):
        admin = self.pg.connect(PG_DSN)
        admin.autocommit = True
        admin.cursor().execute("DROP SCHEMA " + self.schema + " CASCADE")
        admin.close()


class EngineCase(unittest.TestCase):
    engine_cls = None

    def setUp(self):
        self.engine = self.engine_cls()
        self.engine.setup()
        self.conns = []

    def tearDown(self):
        for c in self.conns:
            try:
                c.rollback()
                c.raw.close()
            except Exception:
                pass
        self.engine.teardown()


class SqliteFence(FenceCases, EngineCase):
    engine_cls = SqliteEngine

    def test_sqlite_rejects_for_share_syntax(self):
        with self.assertRaises(sqlite3.OperationalError):
            self.conn().x("SELECT web_fenced FROM principal WHERE id = ? FOR SHARE", ("p1",))


@unittest.skipUnless(PG_DSN or REQUIRE_PG, "PostgreSQL fixture runs in CI only")
class PostgresFence(FenceCases, EngineCase):
    engine_cls = PgEngine

    def setUp(self):
        if not PG_DSN:
            self.fail("OFFLINE744_PG_DSN is required when OFFLINE744_REQUIRE_PG=1")
        super().setUp()

    def test_postgres_accepts_for_share(self):
        c = self.conn()
        self.assertFalse(read_fence(c, "p1"))
        c.rollback()


if __name__ == "__main__":
    unittest.main()
