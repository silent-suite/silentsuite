# Copyright © 2017 Tom Hacohen
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, version 3.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <http://www.gnu.org/licenses/>.

import hashlib
import typing as t
import uuid
from pathlib import Path

from django.conf import settings
from django.core.validators import RegexValidator
from django.db import models, transaction
from django.db.models import Max, Value as Val
from django.db.models.functions import Coalesce, Greatest
from django.utils import timezone
from django.utils.crypto import get_random_string
from django.utils.functional import cached_property

from . import app_settings

UidValidator = RegexValidator(regex=r"^[a-zA-Z0-9\-_]{20,}$", message="Not a valid UID")


def stoken_annotation_builder(stoken_id_fields: t.List[str]):
    aggr_fields = [Coalesce(Max(field), Val(0)) for field in stoken_id_fields]
    return Greatest(*aggr_fields) if len(aggr_fields) > 1 else aggr_fields[0]


class CollectionType(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    uid = models.BinaryField(editable=True, blank=False, null=False, db_index=True, unique=True, max_length=1024)

    objects: models.manager.BaseManager["CollectionType"]


class Collection(models.Model):
    main_item = models.OneToOneField("CollectionItem", related_name="parent", null=True, on_delete=models.SET_NULL)
    # The same as main_item.uid, we just also save it here so we have DB constraints for uniqueness (and efficiency)
    uid = models.CharField(db_index=True, unique=True, blank=False, max_length=43, validators=[UidValidator])
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)

    stoken_annotation = stoken_annotation_builder(["items__revisions__stoken", "members__stoken"])

    objects: models.manager.BaseManager["Collection"]

    def __str__(self):
        return self.uid

    @property
    def content(self) -> "CollectionItemRevision":
        assert self.main_item is not None
        return self.main_item.content

    @property
    def etag(self) -> str:
        return self.content.uid

    @cached_property
    def stoken(self) -> str:
        stoken_id = (
            self.__class__.objects.filter(main_item=self.main_item, items__revisions__current=True)
            .annotate(max_stoken=self.stoken_annotation)
            .values("max_stoken")
            .first()["max_stoken"]
        )

        if stoken_id == 0:
            raise Exception("stoken is None. Should never happen")

        return Stoken.objects.get(id=stoken_id).uid


class CollectionItem(models.Model):
    uid = models.CharField(db_index=True, blank=False, max_length=43, validators=[UidValidator])
    collection = models.ForeignKey(Collection, related_name="items", on_delete=models.CASCADE)
    version = models.PositiveSmallIntegerField()
    encryptionKey = models.BinaryField(editable=True, blank=False, null=True)

    stoken_annotation = stoken_annotation_builder(["revisions__stoken"])

    objects: models.manager.BaseManager["CollectionItem"]

    class Meta:
        unique_together = ("uid", "collection")

    def __str__(self):
        return "{} {}".format(self.uid, self.collection.uid)

    @cached_property
    def content(self) -> "CollectionItemRevision":
        prefetched = getattr(self, "_prefetched_current_revisions", None)
        if prefetched is not None:
            return prefetched[0]
        return self.revisions.filter(current=True)[0]

    @property
    def etag(self) -> str:
        return self.content.uid


def chunk_directory_path(instance: "CollectionItemChunk", filename: str) -> Path:
    custom_func = app_settings.CHUNK_PATH_FUNC
    if custom_func is not None:
        return custom_func(instance, filename)

    col: Collection = instance.collection
    user_id: int = col.owner.id
    uid_prefix: str = instance.uid[:2]
    uid_rest: str = instance.uid[2:]
    return Path("user_{}".format(user_id), col.uid, uid_prefix, uid_rest)


class CollectionItemChunk(models.Model):
    uid = models.CharField(db_index=True, blank=False, null=False, max_length=60, validators=[UidValidator])
    collection = models.ForeignKey(Collection, related_name="chunks", on_delete=models.CASCADE)
    chunkFile = models.FileField(upload_to=chunk_directory_path, max_length=150, unique=True)

    objects: models.manager.BaseManager["CollectionItemChunk"]

    def __str__(self):
        return self.uid

    class Meta:
        unique_together = ("collection", "uid")


def generate_stoken_uid():
    return get_random_string(32, allowed_chars="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


class Stoken(models.Model):
    id: int
    uid = models.CharField(
        db_index=True,
        unique=True,
        blank=False,
        null=False,
        default=generate_stoken_uid,
        max_length=43,
        validators=[UidValidator],
    )

    objects: models.manager.BaseManager["Stoken"]


class BillingLinkProof(models.Model):
    """One-time, opaque link from an authenticated Etebase account to Billing.

    The bearer value is deliberately never stored.  A SHA-256 digest is enough
    for lookup because the value has 256 bits of entropy.
    """

    proof_hash = models.CharField(max_length=64, unique=True, db_index=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    audience = models.CharField(max_length=32, default="billing")
    expires_at = models.DateTimeField(db_index=True)
    consumed_at = models.DateTimeField(null=True, blank=True)

    @staticmethod
    def digest(proof: str) -> str:
        return hashlib.sha256(proof.encode("utf-8")).hexdigest()

    def is_usable(self) -> bool:
        return self.audience == "billing" and self.consumed_at is None and self.expires_at > timezone.now()


class CollectionItemRevision(models.Model):
    stoken = models.OneToOneField(Stoken, on_delete=models.PROTECT)
    uid = models.CharField(
        db_index=True, unique=True, blank=False, null=False, max_length=43, validators=[UidValidator]
    )
    item = models.ForeignKey(CollectionItem, related_name="revisions", on_delete=models.CASCADE)
    meta = models.BinaryField(editable=True, blank=False, null=False)
    current = models.BooleanField(db_index=True, default=True, null=True)
    deleted = models.BooleanField(default=False)

    objects: models.manager.BaseManager["CollectionItemRevision"]

    class Meta:
        unique_together = ("item", "current")

    def __str__(self):
        return "{} {} current={}".format(self.uid, self.item.uid, self.current)


class RevisionChunkRelation(models.Model):
    chunk = models.ForeignKey(CollectionItemChunk, related_name="revisions_relation", on_delete=models.CASCADE)
    revision = models.ForeignKey(CollectionItemRevision, related_name="chunks_relation", on_delete=models.CASCADE)

    objects: models.manager.BaseManager["RevisionChunkRelation"]

    class Meta:
        ordering = ("id",)


class AccessLevels(models.IntegerChoices):
    READ_ONLY = 0
    ADMIN = 1
    READ_WRITE = 2


class CollectionMember(models.Model):
    stoken = models.OneToOneField(Stoken, on_delete=models.PROTECT, null=True)
    collection = models.ForeignKey(Collection, related_name="members", on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    encryptionKey = models.BinaryField(editable=True, blank=False, null=False)
    # RESTRICT, not PROTECT: deleting a user cascades to their own collection
    # types and to the memberships that point at them, so the cascade may
    # remove both. Deleting a type that another member still uses stays blocked.
    collectionType = models.ForeignKey(CollectionType, on_delete=models.RESTRICT, null=True)
    accessLevel = models.IntegerField(
        choices=AccessLevels.choices,
        default=AccessLevels.READ_ONLY,
    )

    stoken_annotation = stoken_annotation_builder(["stoken"])

    objects: models.manager.BaseManager["CollectionMember"]

    class Meta:
        unique_together = ("user", "collection")

    def __str__(self):
        return "{} {}".format(self.collection.uid, self.user)

    def revoke(self):
        with transaction.atomic():
            Collection.objects.select_for_update().get(pk=self.collection_id)
            CollectionInvitation.objects.filter(user=self.user, fromMember__collection_id=self.collection_id).delete()
            CollectionMemberRemoved.objects.update_or_create(
                collection=self.collection,
                user=self.user,
                defaults={
                    "stoken": Stoken.objects.create(),
                },
            )

            self.delete()


class CollectionMemberRemoved(models.Model):
    stoken = models.OneToOneField(Stoken, on_delete=models.PROTECT, null=True)
    collection = models.ForeignKey(Collection, related_name="removed_members", on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)

    objects: models.manager.BaseManager["CollectionMemberRemoved"]

    class Meta:
        unique_together = ("user", "collection")

    def __str__(self):
        return "{} {}".format(self.collection.uid, self.user)


class CollectionInvitation(models.Model):
    uid = models.CharField(db_index=True, blank=False, null=False, max_length=43, validators=[UidValidator])
    version = models.PositiveSmallIntegerField(default=1)
    fromMember = models.ForeignKey(CollectionMember, on_delete=models.CASCADE)
    # Make sure to not allow invitations if already a member

    user = models.ForeignKey(settings.AUTH_USER_MODEL, related_name="incoming_invitations", on_delete=models.CASCADE)
    signedEncryptionKey = models.BinaryField(editable=False, blank=False, null=False)
    accessLevel = models.IntegerField(
        choices=AccessLevels.choices,
        default=AccessLevels.READ_ONLY,
    )

    objects: models.manager.BaseManager["CollectionInvitation"]

    class Meta:
        unique_together = ("user", "fromMember")

    def __str__(self):
        return "{} {}".format(self.fromMember.collection.uid, self.user)

    @cached_property
    def collection(self) -> Collection:
        return self.fromMember.collection


class UserInfo(models.Model):
    owner = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True)
    version = models.PositiveSmallIntegerField(default=1)
    loginPubkey = models.BinaryField(editable=True, blank=False, null=False)
    pubkey = models.BinaryField(editable=True, blank=False, null=False)
    encryptedContent = models.BinaryField(editable=True, blank=False, null=False)
    salt = models.BinaryField(editable=True, blank=False, null=False)
    # Bumped by every committed login rename, in the same transaction as the username, so an
    # identity snapshot (username, login_version) read in one query is never mixed.
    login_version = models.PositiveIntegerField(default=0)

    objects: models.manager.BaseManager["UserInfo"]

    def __str__(self):
        return "UserInfo<{}>".format(self.owner)


def sha256_hex(value: t.Union[str, bytes]) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


class LoginEmailChange(models.Model):
    """One hosted request to rename an account's login (username and email) to a new address.

    Bearer values (challenge, handoff, grant) are stored only as SHA-256 digests.
    pending -> accepted -> committed, or an end state: superseded, expired, cancelled, refused.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    COMMITTED = "committed"
    SUPERSEDED = "superseded"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    REFUSED = "refused"
    OPEN_STATUSES = (PENDING, ACCEPTED)
    STATUS_CHOICES = [
        (x, x) for x in (PENDING, ACCEPTED, COMMITTED, SUPERSEDED, EXPIRED, CANCELLED, REFUSED)
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    old_username = models.CharField(max_length=150)
    new_username = models.CharField(max_length=150)
    from_version = models.PositiveIntegerField()
    login_pubkey_hash = models.CharField(max_length=64)
    challenge_hash = models.CharField(max_length=64, unique=True)
    handoff_hash = models.CharField(max_length=64, unique=True, null=True, blank=True)
    grant_hash = models.CharField(max_length=64, unique=True, null=True, blank=True)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=PENDING, db_index=True)
    refusal = models.CharField(max_length=32, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    expires_at = models.DateTimeField(db_index=True)
    ended_at = models.DateTimeField(null=True, blank=True, db_index=True)
    committed_version = models.PositiveIntegerField(null=True, blank=True)
    committed_at = models.DateTimeField(null=True, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)

    objects: models.manager.BaseManager["LoginEmailChange"]


class HeldUsername(models.Model):
    """A login name a user renamed away from, reserved for good.

    Nobody else can sign up with, rename to or be found by a held name. Renaming back to your own
    held name ends the hold; a later departure from the same name reuses (upserts) the one row.
    Deleting the user keeps the hold with user null: then the name is held for everyone. Only an
    operator can release a hold (`manage.py release_held_username`).
    """

    name = models.CharField(max_length=150, unique=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)

    objects: models.manager.BaseManager["HeldUsername"]
