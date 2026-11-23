"""A DAV client may delete a whole collection only when this account administers it.

The sync server refuses a collection delete from a member who is not an admin.
Bridge used to mark the collection deleted and dirty first, so the refused push
would fail on every sync while the collection stayed hidden from DAV. Bridge
now refuses the DELETE itself and leaves the collection as it was.
"""

from etebase import CollectionAccessLevel

from silentsuite_bridge.local_cache import models
from silentsuite_bridge.radicale import application
from tests.dav_fixtures import SdkCollection, dav_world  # noqa: F401
from tests.test_macos_dav_discovery import USERNAME

PROPS = b'<d:propfind xmlns:d="DAV:"><d:prop><d:displayname /></d:prop></d:propfind>'


def _seed(world, uid, access_level):
    obj = SdkCollection(uid, "etebase.vcard", {"name": "Contacts " + uid})
    obj.access_level = access_level
    return models.CollectionEntity.create(local_user=world.user, uid=uid, eb_col=world.remote.store.save(obj))


def test_shared_read_write_collection_delete_is_refused_and_nothing_changes(dav_world):
    row = _seed(dav_world, "shared-contacts", CollectionAccessLevel.ReadWrite)
    path = f"/{USERNAME}/shared-contacts/"

    response = dav_world.request("DELETE", path)

    assert response.status == 403
    row = models.CollectionEntity.get_by_id(row.id)
    assert not row.deleted
    assert not row.dirty
    assert dav_world.request("PROPFIND", path, PROPS).status == 207


def test_administered_collection_delete_still_works(dav_world):
    row = _seed(dav_world, "own-contacts", CollectionAccessLevel.Admin)
    path = f"/{USERNAME}/own-contacts/"

    assert dav_world.request("DELETE", path).status == 200

    row = models.CollectionEntity.get_by_id(row.id)
    assert row.deleted and row.dirty
    assert dav_world.request("PROPFIND", path, PROPS).status == 404


def test_role_change_learned_during_the_request_still_answers_403(dav_world, monkeypatch):
    # The early check saw a cached admin role; the sync inside the request found
    # the account is now read/write, so the storage guard refuses the delete.
    row = _seed(dav_world, "demoted-contacts", CollectionAccessLevel.ReadWrite)
    monkeypatch.setattr(application, "_collection_delete_denied", lambda *_: False)

    response = dav_world.request("DELETE", f"/{USERNAME}/demoted-contacts/")

    assert response.status == 403
    row = models.CollectionEntity.get_by_id(row.id)
    assert not row.deleted
    assert not row.dirty
