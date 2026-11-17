"""Client-selected collection paths and broad property discovery."""

import xml.etree.ElementTree as ET
from urllib.parse import unquote

import pytest

from silentsuite_bridge import local_cache
from silentsuite_bridge.local_cache import models
from tests.dav_fixtures import dav_world  # noqa: F401
from tests.test_carddav_remote_delete_convergence import SYNC_REPORT, _vcard
from tests.test_macos_dav_discovery import ALLPROP_BODY, DAV, PROPNAME_BODY, USERNAME

PROPS = b'<d:propfind xmlns:d="DAV:"><d:prop><d:displayname /></d:prop></d:propfind>'
PATCH = b'''<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>
<d:displayname>Renamed</d:displayname></d:prop></d:set></d:propertyupdate>'''
ADDRESSBOOK = b'''<d:mkcol xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav">
<d:set><d:prop><d:resourcetype><d:collection/><cr:addressbook/></d:resourcetype>
<d:displayname>Address Book</d:displayname></d:prop></d:set></d:mkcol>'''


def create(world, path="chosen", method="MKCOL"):
    body = ADDRESSBOOK if method == "MKCOL" else b""
    return world.request(method, f"/{USERNAME}/{path}/", body)


def hrefs(response):
    assert response.status == 207, response.body
    return [unquote(element.text or "") for element in ET.fromstring(response.body).iter(DAV + "href")]


@pytest.mark.parametrize("method", ["MKCOL", "MKCALENDAR"])
def test_created_collection_keeps_requested_path(dav_world, method):
    world = dav_world
    assert create(world, method=method).status == 201
    (row,) = list(models.CollectionEntity.select())
    assert row.uid != "chosen", "fixture must use an independently generated UID"
    path = f"/{USERNAME}/chosen/"
    response = world.request("PROPFIND", path, PROPS)
    assert response.status == 207, "the created URL must remain discoverable"
    assert world.request("PROPPATCH", path, PATCH).status == 207
    listing = hrefs(world.request("PROPFIND", f"/{USERNAME}/", PROPS, {"HTTP_DEPTH": "1"}))
    assert listing.count(path) == 1
    assert f"/{USERNAME}/{row.uid}/" not in listing
    # Reopen the database and restore a new independent account session.
    world.database.close()
    world.database.connect()
    assert world.request("PROPFIND", path, PROPS).status == 207
    if method == "MKCOL":
        assert world.request("PUT", path + "one.vcf", _vcard("one", "One")).status == 201
        assert b"FN:One" in world.request("GET", path + "one.vcf").body
        report = world.request("REPORT", path, SYNC_REPORT.replace(b"{token}", b""))
        assert report.status == 207
        assert path + "one.vcf" in hrefs(report)
        multiget = f'''<cr:addressbook-multiget xmlns:d="DAV:"
        xmlns:cr="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/>
        <cr:address-data/></d:prop><d:href>{path}one.vcf</d:href></cr:addressbook-multiget>'''
        response = world.request("REPORT", path, multiget)
        assert response.status == 207 and b"FN:One" in response.body
    else:
        from tests.conftest import SAMPLE_VCALENDAR_VEVENT
        put = world.request("PUT", path + "one.ics", SAMPLE_VCALENDAR_VEVENT,
                            content_type="text/calendar")
        assert put.status == 201
        assert world.request("GET", path + "one.ics").status == 200
    assert world.request("DELETE", path).status == 200
    assert world.request("PROPFIND", path, PROPS).status == 404


@pytest.mark.parametrize("method, expected", [("MKCOL", 405), ("MKCALENDAR", 409)])
def test_repeated_collection_create_does_not_create_again(dav_world, method, expected):
    assert create(dav_world, method=method).status == 201
    assert create(dav_world, method=method).status == expected
    assert len(dav_world.created_collections) == 1
    assert models.CollectionEntity.select().count() == 1


def test_collection_delete_frees_requested_path(dav_world):
    world = dav_world
    assert create(world).status == 201
    path = f"/{USERNAME}/chosen/"
    first_report = world.request("REPORT", path, SYNC_REPORT.replace(b"{token}", b""))
    assert first_report.status == 207
    old_token = ET.fromstring(first_report.body).findtext(DAV + "sync-token")
    old = models.CollectionEntity.get()
    assert world.request("DELETE", path).status == 200
    assert create(world).status == 201
    old = models.CollectionEntity.get_by_id(old.id)
    assert old.deleted and old.dirty
    assert getattr(old, "dav_href", None) is None
    live = models.CollectionEntity.get(models.CollectionEntity.deleted == False)  # noqa: E712
    assert live.id != old.id and live.uid != old.uid
    assert world.request("PROPFIND", path, PROPS).status == 207
    old_report = world.request("REPORT", path, SYNC_REPORT.replace(b"{token}", old_token.encode()))
    assert old_report.status == 403 and b"valid-sync-token" in old_report.body


@pytest.mark.parametrize("retire", ["local", "remote", "membership"])
def test_logical_collection_deletion_releases_alias(dav_world, retire):
    world = dav_world
    assert create(world).status == 201
    row = models.CollectionEntity.get()
    assert getattr(row, "dav_href", None) == "chosen"
    models.CollectionEntity.update(new=False, dirty=False).where(
        models.CollectionEntity.id == row.id
    ).execute()
    if retire == "local":
        world.service().get(row.uid).delete()
    else:
        obj = world.remote.store.load(row.eb_col)
        obj.deleted = retire == "remote"
        from types import SimpleNamespace
        page = SimpleNamespace(data=[obj] if retire == "remote" else [],
                               removed_memberships=[row.uid] if retire == "membership" else [])
        world.service()._apply_collection_list_page(world.remote.col_mgr, page)
    retired = models.CollectionEntity.get_by_id(row.id)
    assert retired.deleted and retired.dav_href is None
    assert create(world).status == 201


@pytest.mark.parametrize("segment", ["unsafe:name", "unsafe name", "a" * 256])
def test_collection_create_refuses_unsafe_segment(dav_world, segment):
    result = create(dav_world, path=segment)
    assert result.status in {400, 403, 409}
    assert dav_world.created_collections == []
    assert models.CollectionEntity.select().count() == 0


def test_collection_alias_keeps_read_only_rights(dav_world):
    assert create(dav_world).status == 201
    row = models.CollectionEntity.get()
    obj = dav_world.remote.store.load(row.eb_col)
    obj.access_level = 1
    row.eb_col = dav_world.remote.store.save(obj)
    row.new = False
    row.save()
    path = f"/{USERNAME}/chosen/"
    assert dav_world.request("PROPFIND", path, PROPS).status == 207
    assert dav_world.request("PUT", path + "one.vcf", _vcard("one", "One")).status == 403
    assert dav_world.request("DELETE", path).status == 403


def test_existing_collection_uid_is_not_a_new_alias(dav_world):
    dav_world.add_collection(uid="chosen")
    assert create(dav_world).status == 405
    assert dav_world.created_collections == []


def test_generated_collection_uid_cannot_take_another_alias(dav_world):
    assert create(dav_world, path="sdk-collection-1").status == 201
    response = create(dav_world, path="second")
    assert response.status == 400
    assert models.CollectionEntity.select().count() == 1
    dav_world.remote.col_mgr.upload.assert_not_called()


def test_managed_birthdays_remains_read_only_through_alias(dav_world):
    from silentsuite_bridge.birthdays import marker_content

    assert create(dav_world, method="MKCALENDAR").status == 201
    row = models.CollectionEntity.get()
    sdk = dav_world.remote.store.load(row.eb_col)
    sdk.content = marker_content("active")
    row.eb_col = dav_world.remote.store.save(sdk)
    row.save()
    assert dav_world.request("PROPFIND", f"/{USERNAME}/chosen/", PROPS).status == 207
    assert dav_world.request("DELETE", f"/{USERNAME}/chosen/").status == 403


def test_collection_alias_is_not_accessible_through_another_account(dav_world):
    assert create(dav_world).status == 201
    response = dav_world.request("PROPFIND", "/other@example.test/chosen/", PROPS)
    assert response.status in {403, 404}


@pytest.mark.parametrize("kind", ["etebase.vcard", "etebase.vevent", "etebase.vtodo"])
@pytest.mark.parametrize("body", [b"", ALLPROP_BODY, PROPNAME_BODY], ids=["empty", "allprop", "propname"])
@pytest.mark.parametrize("home", [False, True], ids=["collection", "home"])
def test_propfind_forms_on_real_collections(dav_world, kind, body, home):
    dav_world.add_collection(kind=kind, description="Description", color="#123456", mtime=42)
    path = f"/{USERNAME}/" + ("" if home else "contacts/")
    response = dav_world.request("PROPFIND", path, body, {"HTTP_DEPTH": "1" if home else "0"})
    assert response.status == 207, response.body
    root = ET.fromstring(response.body)
    assert root.find(".//" + DAV + "displayname") is not None
    assert root.find(".//mtime") is None
    if body != PROPNAME_BODY:
        assert root.findtext(".//" + DAV + "displayname") == "Contacts"


def test_collection_cache_upgrade_keeps_legacy_columns(dav_world):
    row = dav_world.add_collection()
    old_columns = ["id", "local_user_id", "uid", "eb_col", "new", "dirty", "deleted",
                   "stoken", "local_stoken", "dav_revision"]
    old_values = dav_world.database.execute_sql(
        "SELECT " + ",".join(old_columns) + " FROM collectionentity WHERE id=?", (row.id,)
    ).fetchone()
    local_cache._ensure_cache_tables(dav_world.database)
    assert dav_world.database.execute_sql(
        "SELECT " + ",".join(old_columns) + " FROM collectionentity WHERE id=?", (row.id,)
    ).fetchone() == old_values
    assert models.Config.get().db_version == 1
