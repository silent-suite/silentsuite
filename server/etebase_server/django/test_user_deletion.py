"""Deleting a user must remove their data, also through the Django admin.

The self-hosting docs tell operators to delete users in the Django admin.
A user's own membership rows point at their own collection types, so the
membership's foreign key must not block the cascade from the user.
"""

import itertools

import pytest
from django.db.models import RestrictedError
from django.test import Client

from etebase_server.django import models
from etebase_server.myauth.models import get_typed_user_model

User = get_typed_user_model()
_COUNTER = itertools.count(1)


def _uid(prefix: str) -> str:
    return f"{prefix}{next(_COUNTER):04d}" + "a" * 24


def _collection_with_member(owner, member_user=None):
    """Create a collection the way the create route does: owner membership with the owner's type."""
    collection = models.Collection.objects.create(uid=_uid("col"), owner=owner)
    item = models.CollectionItem.objects.create(uid=collection.uid, collection=collection, version=1)
    collection.main_item = item
    collection.save(update_fields=("main_item",))
    models.CollectionItemRevision.objects.create(
        uid=_uid("rev"), stoken=models.Stoken.objects.create(), item=item, meta=b"{}", current=True
    )
    for user in filter(None, (owner, member_user)):
        collection_type, _ = models.CollectionType.objects.get_or_create(
            uid=_uid("type").encode("ascii"), owner=user
        )
        models.CollectionMember.objects.create(
            collection=collection,
            stoken=models.Stoken.objects.create(),
            user=user,
            accessLevel=models.AccessLevels.ADMIN,
            encryptionKey=b"synthetic-key",
            collectionType=collection_type,
        )
    return collection


def _assert_user_data_gone(user_id):
    assert not User.objects.filter(pk=user_id).exists()
    assert not models.Collection.objects.filter(owner_id=user_id).exists()
    assert not models.CollectionType.objects.filter(owner_id=user_id).exists()
    assert not models.CollectionMember.objects.filter(user_id=user_id).exists()


@pytest.mark.django_db
def test_user_with_own_collection_can_be_deleted():
    user = User.objects.create_user(username="test_user_delete_owner", password=None)
    _collection_with_member(user)
    user_id = user.pk

    user.delete()

    _assert_user_data_gone(user_id)


@pytest.mark.django_db
def test_deleting_a_sharer_keeps_the_other_members_own_data():
    sharer = User.objects.create_user(username="test_user_delete_sharer", password=None)
    other = User.objects.create_user(username="test_user_delete_other", password=None)
    shared = _collection_with_member(sharer, member_user=other)
    own = _collection_with_member(other)
    sharer_id = sharer.pk

    sharer.delete()

    _assert_user_data_gone(sharer_id)
    assert not models.Collection.objects.filter(pk=shared.pk).exists()
    assert models.Collection.objects.filter(pk=own.pk).exists()
    assert models.CollectionMember.objects.filter(user=other, collection=own).exists()


@pytest.mark.django_db
def test_deleting_a_member_keeps_the_owners_collection():
    owner = User.objects.create_user(username="test_user_delete_keep_owner", password=None)
    member = User.objects.create_user(username="test_user_delete_member", password=None)
    shared = _collection_with_member(owner, member_user=member)
    member_id = member.pk

    member.delete()

    _assert_user_data_gone(member_id)
    assert models.Collection.objects.filter(pk=shared.pk).exists()
    assert models.CollectionMember.objects.filter(user=owner, collection=shared).exists()


@pytest.mark.django_db
def test_deletion_stays_blocked_while_another_users_membership_uses_the_type():
    """Invitation accept reuses a type by UID, so a surviving membership can point at it."""
    departing = User.objects.create_user(username="test_user_delete_type_owner", password=None)
    owner = User.objects.create_user(username="test_user_delete_other_owner", password=None)
    member = User.objects.create_user(username="test_user_delete_type_reuser", password=None)
    _collection_with_member(departing)
    departing_type = models.CollectionType.objects.get(owner=departing)
    surviving = _collection_with_member(owner)
    models.CollectionMember.objects.create(
        collection=surviving,
        stoken=models.Stoken.objects.create(),
        user=member,
        accessLevel=models.AccessLevels.READ_ONLY,
        encryptionKey=b"synthetic-key",
        collectionType=departing_type,
    )

    with pytest.raises(RestrictedError):
        departing.delete()

    assert User.objects.filter(pk=departing.pk).exists()
    assert models.Collection.objects.filter(owner=departing).exists()
    assert models.CollectionMember.objects.filter(collection=surviving, user=member).exists()


@pytest.mark.django_db
def test_admin_delete_view_removes_user_with_collections(settings):
    settings.ALLOWED_HOSTS = ["testserver"]
    settings.SECURE_SSL_REDIRECT = False
    admin = User.objects.create_superuser(username="test_user_delete_admin", email="", password=None)
    user = User.objects.create_user(username="test_user_delete_via_admin", password=None)
    _collection_with_member(user)
    client = Client()
    client.force_login(admin)

    response = client.post(f"/admin/myauth/user/{user.pk}/delete/", {"post": "yes"})

    assert response.status_code == 302, response.content[:2000]
    _assert_user_data_gone(user.pk)
