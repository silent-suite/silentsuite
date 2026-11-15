"""Synthetic, disposable data for the isolated HTTP authorization check."""

import hashlib
import secrets
from dataclasses import dataclass
from pathlib import Path

from django.apps import apps
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from nacl.signing import SigningKey

from etebase_server.django import models


def uid():
    return secrets.token_urlsafe(24)


@dataclass
class Account:
    user: object
    signing_key: SigningKey
    collection: object
    member: object
    items: list
    chunks: list
    markers: list


def seed():
    """Exactly two accounts; each owns a root, two items and private chunks."""
    User = get_user_model()
    if User.objects.exists() or models.Collection.objects.exists():
        raise RuntimeError("fixture-not-empty")
    accounts = []
    for name in ("a", "b"):
        key = SigningKey.generate()
        user = User.objects.create_user(username=f"http-{name}", email=f"{name}@example.invalid", password=None)
        models.UserInfo.objects.create(
            owner=user, loginPubkey=bytes(key.verify_key), pubkey=secrets.token_bytes(32),
            encryptedContent=secrets.token_bytes(64), salt=secrets.token_bytes(32),
        )
        collection = models.Collection.objects.create(uid=uid(), owner=user)
        collection_type = models.CollectionType.objects.create(owner=user, uid=secrets.token_bytes(32))
        member = models.CollectionMember.objects.create(
            collection=collection, user=user, stoken=models.Stoken.objects.create(),
            accessLevel=models.AccessLevels.ADMIN, encryptionKey=secrets.token_bytes(32),
            collectionType=collection_type,
        )
        items, chunks, markers = [], [], [bytes(member.encryptionKey)]
        for index in range(3):
            item = models.CollectionItem.objects.create(
                collection=collection, uid=collection.uid if index == 0 else uid(), version=1,
            )
            metadata, content = secrets.token_bytes(48), secrets.token_bytes(64)
            revision = models.CollectionItemRevision.objects.create(
                item=item, uid=uid(), meta=metadata, stoken=models.Stoken.objects.create(),
            )
            chunk = models.CollectionItemChunk(collection=collection, uid=uid())
            chunk.chunkFile.save("IGNORED", ContentFile(content))
            models.RevisionChunkRelation.objects.create(revision=revision, chunk=chunk)
            items.append(item)
            chunks.append(chunk)
            markers.extend((metadata, content))
        collection.main_item = items[0]
        collection.save(update_fields=["main_item"])
        accounts.append(Account(user, key, collection, member, items, chunks, markers))
    if User.objects.count() != 2:
        raise RuntimeError("fixture-user-count")
    return accounts


def batch(account):
    """Valid updates for the root, an ordinary item and an ordinary tombstone."""
    return {"items": [
        {"uid": item.uid, "version": 1, "etag": item.etag,
         "content": {"uid": uid(), "meta": secrets.token_bytes(48), "deleted": index == 2,
                     "chunks": [[uid(), secrets.token_bytes(64)]]}}
        for index, item in enumerate(account.items)
    ]}


def invitation(sender, recipient):
    return models.CollectionInvitation.objects.create(
        uid=uid(), fromMember=sender.member, user=recipient.user,
        signedEncryptionKey=secrets.token_bytes(64), accessLevel=models.AccessLevels.READ_WRITE,
    )


def snapshot():
    """All sync rows (including stokens) and every media path/content digest.

    Authentication tokens are outside this snapshot: the real auth dependency
    may renew their expiry on reads. No sync model or user row is excluded.
    """
    model_list = [*apps.get_app_config("django_etebase").get_models(), get_user_model()]
    rows = {
        model._meta.label: list(model.objects.order_by("pk").values_list())
        for model in model_list
    }
    root = Path(settings.MEDIA_ROOT)
    files = {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).digest()
        for path in sorted(root.rglob("*")) if path.is_file()
    }
    return rows, files
