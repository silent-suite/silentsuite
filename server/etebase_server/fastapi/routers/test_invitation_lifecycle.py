from __future__ import annotations

import itertools

import pytest
from django.core.files.base import ContentFile
from fastapi import status

from etebase_server.django import models
from etebase_server.fastapi.exceptions import HttpError
from etebase_server.fastapi.routers.collection import collection_list_common
from etebase_server.fastapi.routers.invitation import (
    CollectionInvitationAcceptIn,
    CollectionInvitationIn,
    incoming_accept,
    outgoing_create,
)

_COUNTER = itertools.count(1)


def _invite(member, recipient):
    return models.CollectionInvitation.objects.create(
        uid=_uid("invite"), fromMember=member, user=recipient,
        signedEncryptionKey=b"synthetic-signed-key", accessLevel=models.AccessLevels.READ_WRITE,
    )


def _uid(prefix: str) -> str:
    nonce = next(_COUNTER)
    return f"{prefix}{nonce:04d}" + "a" * 24


def _bytes(prefix: str) -> bytes:
    return _uid(prefix).encode("ascii")


def _make_collection(owner):
    collection = models.Collection.objects.create(uid=_uid("col"), owner=owner)
    item = models.CollectionItem.objects.create(uid=collection.uid, collection=collection, version=1)
    collection.main_item = item
    collection.save(update_fields=("main_item",))
    revision = models.CollectionItemRevision.objects.create(
        uid=_uid("rev"),
        stoken=models.Stoken.objects.create(),
        item=item,
        meta=b"{}",
        current=True,
    )
    chunk = models.CollectionItemChunk(uid=_uid("chunk"), collection=collection)
    chunk.chunkFile.save("IGNORED", ContentFile(b"\x00"))
    chunk.save()
    models.RevisionChunkRelation.objects.create(chunk=chunk, revision=revision)
    return collection


def _add_member(user, collection, *, access_level=models.AccessLevels.ADMIN, collection_type: bytes | None = None):
    collection_type_obj, _ = models.CollectionType.objects.get_or_create(
        uid=collection_type if collection_type is not None else _bytes("type"),
        defaults={"owner": user},
    )
    return models.CollectionMember.objects.create(
        collection=collection,
        stoken=models.Stoken.objects.create(),
        user=user,
        accessLevel=access_level,
        encryptionKey=_bytes("key"),
        collectionType=collection_type_obj,
    )


@pytest.mark.django_db(transaction=True)
class TestInvitationLifecycle:
    def test_accept_clears_other_admin_invites_before_later_removal(self, user_factory):
        owner = user_factory(username="test_user_multi_owner")
        admin = user_factory(username="test_user_multi_admin")
        recipient = user_factory(username="test_user_multi_recipient")
        other = user_factory(username="test_user_multi_other")
        col = _make_collection(owner)
        owner_member = _add_member(owner, col)
        admin_member = _add_member(admin, col)
        first, second = _invite(owner_member, recipient), _invite(admin_member, recipient)
        unrelated_user = _invite(owner_member, other)
        other_col = _make_collection(owner)
        unrelated_col = _invite(_add_member(owner, other_col), recipient)
        data = CollectionInvitationAcceptIn(collectionType=b"etebase.vtodo", encryptionKey=b"accepted-key")
        incoming_accept(first.uid, data, queryset=models.CollectionInvitation.objects.filter(user=recipient))
        assert not models.CollectionInvitation.objects.filter(user=recipient, fromMember__collection=col).exists()
        models.CollectionMember.objects.get(user=recipient, collection=col).revoke()
        with pytest.raises(HttpError) as rejected:
            incoming_accept(second.uid, data, queryset=models.CollectionInvitation.objects.filter(user=recipient))
        assert rejected.value.status_code == 404
        assert not models.CollectionMember.objects.filter(user=recipient, collection=col).exists()
        assert set(models.CollectionInvitation.objects.values_list("pk", flat=True)) == {unrelated_user.pk, unrelated_col.pk}

    @pytest.mark.parametrize("removal", ["revoke", "member_delete", "member_leave"])
    def test_removal_clears_old_invites_only_for_affected_recipient_and_collection(self, user_factory, removal):
        from etebase_server.fastapi.routers.member import member_delete, member_leave

        owner = user_factory(username="test_user_remove_owner")
        admin = user_factory(username="test_user_remove_admin")
        recipient = user_factory(username="test_user_remove_recipient")
        other = user_factory(username="test_user_remove_other")
        col = _make_collection(owner)
        owner_member, admin_member = _add_member(owner, col), _add_member(admin, col)
        member = _add_member(recipient, col, access_level=models.AccessLevels.READ_WRITE)
        _invite(owner_member, recipient)
        stale = _invite(admin_member, recipient)
        unrelated_user = _invite(owner_member, other)
        other_col = _make_collection(owner)
        unrelated_col = _invite(_add_member(owner, other_col), recipient)
        if removal == "revoke":
            member.revoke()
        elif removal == "member_delete":
            member_delete(obj=member)
        else:
            member_leave(user=recipient, collection=col)
        assert not models.CollectionMember.objects.filter(user=recipient, collection=col).exists()
        assert models.CollectionMemberRemoved.objects.filter(user=recipient, collection=col).exists()
        assert set(models.CollectionInvitation.objects.values_list("pk", flat=True)) == {unrelated_user.pk, unrelated_col.pk}
        with pytest.raises(HttpError) as rejected:
            incoming_accept(stale.uid, CollectionInvitationAcceptIn(collectionType=b"etebase.vtodo", encryptionKey=b"key"),
                            queryset=models.CollectionInvitation.objects.filter(user=recipient))
        assert rejected.value.status_code == 404

    def test_accept_rechecks_invitation_loaded_before_removal(self, user_factory, monkeypatch):
        from etebase_server.fastapi.routers import invitation as router

        owner = user_factory(username="test_user_stale_lookup_owner")
        recipient = user_factory(username="test_user_stale_lookup_recipient")
        col = _make_collection(owner)
        invitation = _invite(_add_member(owner, col), recipient)
        original = router.get_object_or_404
        calls = []

        def removed_between_lookup_and_lock(*args, **kwargs):
            value = original(*args, **kwargs)
            calls.append(value.pk)
            if len(calls) == 1:
                models.CollectionInvitation.objects.filter(pk=value.pk).delete()
            return value

        monkeypatch.setattr(router, "get_object_or_404", removed_between_lookup_and_lock)
        with pytest.raises(HttpError) as rejected:
            incoming_accept(invitation.uid,
                            CollectionInvitationAcceptIn(collectionType=b"etebase.vtodo", encryptionKey=b"key"),
                            queryset=models.CollectionInvitation.objects.filter(user=recipient))
        assert rejected.value.status_code == 404
        assert not models.CollectionMember.objects.filter(user=recipient, collection=col).exists()

    def test_accept_creates_member_clears_removed_membership_and_lists_collection(self, user_factory):
        owner = user_factory(username="test_user_share_owner", email="owner@example.com")
        invited = user_factory(username="test_user_share_invited", email="invited@example.com")
        collection = _make_collection(owner)
        owner_member = _add_member(owner, collection)
        invitation = models.CollectionInvitation.objects.create(
            uid=_uid("invite"),
            fromMember=owner_member,
            user=invited,
            signedEncryptionKey=b"signed-key",
            accessLevel=models.AccessLevels.READ_WRITE,
        )
        removed = models.CollectionMemberRemoved.objects.create(
            collection=collection,
            user=invited,
            stoken=models.Stoken.objects.create(),
        )

        incoming_accept(
            invitation.uid,
            CollectionInvitationAcceptIn(collectionType=b"etebase.vtodo", encryptionKey=b"accepted-key"),
            queryset=models.CollectionInvitation.objects.filter(user=invited),
        )

        member = models.CollectionMember.objects.get(collection=collection, user=invited)
        assert member.accessLevel == models.AccessLevels.READ_WRITE
        assert bytes(member.encryptionKey) == b"accepted-key"
        assert bytes(member.collectionType.uid) == b"etebase.vtodo"
        assert not models.CollectionInvitation.objects.filter(pk=invitation.pk).exists()
        assert not models.CollectionMemberRemoved.objects.filter(pk=removed.pk).exists()

        response = collection_list_common(
            models.Collection.objects.filter(members__user=invited),
            invited,
            stoken=None,
            limit=50,
            prefetch="medium",
        )
        assert [item.item.uid for item in response.data] == [collection.uid]
        assert response.data[0].collectionKey == b"accepted-key"
        assert response.data[0].accessLevel == models.AccessLevels.READ_WRITE

    def test_accept_reuses_existing_collection_type_uid(self, user_factory):
        owner = user_factory(username="test_user_type_owner", email="type-owner@example.com")
        invited = user_factory(username="test_user_type_invited", email="type-invited@example.com")
        collection = _make_collection(owner)
        owner_member = _add_member(owner, collection, collection_type=b"etebase.vevent")
        invitation = models.CollectionInvitation.objects.create(
            uid=_uid("invite"),
            fromMember=owner_member,
            user=invited,
            signedEncryptionKey=b"signed-key",
            accessLevel=models.AccessLevels.READ_ONLY,
        )

        incoming_accept(
            invitation.uid,
            CollectionInvitationAcceptIn(collectionType=b"etebase.vevent", encryptionKey=b"accepted-key"),
            queryset=models.CollectionInvitation.objects.filter(user=invited),
        )

        member = models.CollectionMember.objects.get(collection=collection, user=invited)
        assert member.collectionType_id == owner_member.collectionType_id

    def test_outgoing_invite_rejects_already_member_target(self, user_factory):
        owner = user_factory(username="test_user_invite_owner", email="invite-owner@example.com")
        already_member = user_factory(username="test_user_already_member", email="already@example.com")
        collection = _make_collection(owner)
        _add_member(owner, collection)
        _add_member(already_member, collection, access_level=models.AccessLevels.READ_ONLY)

        with pytest.raises(HttpError) as excinfo:
            outgoing_create(
                CollectionInvitationIn(
                    uid=_uid("invite"),
                    version=1,
                    accessLevel=models.AccessLevels.READ_ONLY,
                    username=already_member.username,
                    collection=collection.uid,
                    signedEncryptionKey=b"signed-key",
                ),
                request=type("Request", (), {"path_params": {}})(),
                user=owner,
            )

        assert excinfo.value.status_code == status.HTTP_409_CONFLICT
        assert excinfo.value.code == "already_member"
        assert not models.CollectionInvitation.objects.filter(user=already_member, fromMember__collection=collection).exists()

    def test_incoming_accept_rejects_stale_invite_for_existing_member(self, user_factory):
        owner = user_factory(username="test_user_stale_owner", email="stale-owner@example.com")
        invited = user_factory(username="test_user_stale_invited", email="stale-invited@example.com")
        collection = _make_collection(owner)
        owner_member = _add_member(owner, collection)
        invitation = models.CollectionInvitation.objects.create(
            uid=_uid("invite"),
            fromMember=owner_member,
            user=invited,
            signedEncryptionKey=b"signed-key",
            accessLevel=models.AccessLevels.READ_WRITE,
        )
        _add_member(invited, collection, access_level=models.AccessLevels.READ_ONLY)

        with pytest.raises(HttpError) as excinfo:
            incoming_accept(
                invitation.uid,
                CollectionInvitationAcceptIn(collectionType=b"etebase.vevent", encryptionKey=b"accepted-key"),
                queryset=models.CollectionInvitation.objects.filter(user=invited),
            )

        assert excinfo.value.status_code == status.HTTP_409_CONFLICT
        assert excinfo.value.code == "already_member"
        assert models.CollectionInvitation.objects.filter(pk=invitation.pk).exists()
        assert models.CollectionMember.objects.filter(collection=collection, user=invited).count() == 1
