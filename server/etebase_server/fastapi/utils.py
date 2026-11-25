import base64
import dataclasses
import typing as t
import unicodedata

import msgpack
from django.contrib.auth.validators import UnicodeUsernameValidator
from django.core.exceptions import ObjectDoesNotExist, ValidationError
from django.core.validators import validate_email
from django.db import connection, transaction
from django.db.models import Model, QuerySet
from fastapi import Depends, Query, status
from pydantic import BaseModel as PyBaseModel
from typing_extensions import Literal

from etebase_server.django import app_settings
from etebase_server.django.models import AccessLevels, HeldUsername
from etebase_server.myauth.models import UserType, get_typed_user_model

from .exceptions import HttpError, HttpErrorOut

User = get_typed_user_model()

Prefetch = Literal["auto", "medium"]
PrefetchQuery = Query(default="auto")

# Repeated references may inline this many additional bytes per response.
# Distinct stored chunks are not limited by this amplification guard.
MAX_REPEATED_CHUNK_BYTES = 64 * 1024 * 1024


T = t.TypeVar("T", bound=Model, covariant=True)


class BaseModel(PyBaseModel):
    pass


@dataclasses.dataclass
class Context:
    user: t.Optional[UserType]
    prefetch: t.Optional[Prefetch]
    repeated_chunk_bytes_left: int = dataclasses.field(default_factory=lambda: MAX_REPEATED_CHUNK_BYTES)
    # chunk pk -> (first revision pk, header-duplicate exemption used)
    prefetched_chunks: t.Dict[int, t.Tuple[int, bool]] = dataclasses.field(default_factory=dict)
    chunk_budget_omitted: bool = False


def get_object_or_404(queryset: QuerySet[T], **kwargs) -> T:
    try:
        return queryset.get(**kwargs)
    except ObjectDoesNotExist as e:
        raise HttpError("does_not_exist", str(e), status_code=status.HTTP_404_NOT_FOUND)


def is_collection_admin(collection, user):
    member = collection.members.filter(user=user).first()
    return (member is not None) and (member.accessLevel == AccessLevels.ADMIN)


def msgpack_encode(content) -> bytes:
    ret = msgpack.packb(content, use_bin_type=True)
    assert ret is not None
    return ret


def msgpack_decode(content: bytes):
    return msgpack.unpackb(content, raw=False)


def b64encode(value: bytes):
    return base64.urlsafe_b64encode(value).decode("ascii").strip("=")


def b64decode(data: str):
    data += "=" * ((4 - len(data) % 4) % 4)
    return base64.urlsafe_b64decode(data)


# Largest page a list endpoint returns. Clients page on `done` and the
# stoken/iterator, so a clamped page only means another request. Clients ask for
# 100 at most (default 50).
MAX_LIST_LIMIT = 500


def clamp_list_limit(limit: int) -> int:
    """Clamp a requested list `limit` to 1..MAX_LIST_LIMIT.

    The upper bound keeps one request from loading every row. The lower bound
    keeps zero from returning an empty page that is not done (the stoken would
    not advance) and negative values from reaching queryset slicing.
    """
    return max(1, min(limit, MAX_LIST_LIMIT))


def get_user_by_username_or_email(queryset: QuerySet[UserType], username: str) -> UserType:
    """Find the one user a login or invitation name refers to.

    A name containing '@' may be a username (SilentSuite clients use the email as
    the username) or an email. An exact username match always wins. Email is not
    unique, so when only emails match and more than one user has that email, this
    raises User.DoesNotExist, the same as no match, instead of letting
    MultipleObjectsReturned surface as a server error.
    """
    if name_is_held(username):
        # A name its owner renamed away from stays unreachable, so old clients and invitations
        # can't resolve it to anyone (including the owner's new login).
        raise User.DoesNotExist("User matching query does not exist.")
    try:
        try:
            return queryset.get(**{User.USERNAME_FIELD + "__iexact": username.lower()})
        except User.DoesNotExist:
            if "@" not in username:
                raise
            return queryset.get(**{User.EMAIL_FIELD + "__iexact": username.lower()})
    except User.MultipleObjectsReturned:
        raise User.DoesNotExist("User matching query does not exist.")


def normalize_login_name(name: str) -> str:
    """The form login names are stored and compared in: NFKC, lower case (as usernames are stored)."""
    return User.normalize_username(name)


def name_is_held(name: str, exclude_user: t.Optional[UserType] = None) -> bool:
    """Whether a renamed-away name is held (holds never expire), optionally ignoring one user's holds."""
    held = HeldUsername.objects.filter(name=normalize_login_name(name))
    if exclude_user is not None:
        held = held.exclude(user=exclude_user)
    return held.exists()


def claim_names(names: t.Iterable[str]) -> None:
    """Serialize every transaction that may take one of these login names until it ends.

    PostgreSQL: transaction-scoped advisory locks on the normalized names, taken in sorted order
    so two claimers never deadlock. SQLite (the default self-host backend) allows one writer at a
    time and a transaction that read before another's commit fails to upgrade (database is
    locked) instead of writing stale data, so this is a no-op there. Call inside an atomic block,
    before the collision checks.
    """
    if connection.vendor != "postgresql":
        return
    keys = sorted({normalize_login_name(name) for name in names if name})
    with connection.cursor() as cursor:
        for key in keys:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ["etebase-login-name:" + key])


MAX_LOGIN_NAME_LENGTH = 150
_username_validator = UnicodeUsernameValidator()


def canonical_login_email(raw: t.Any) -> t.Optional[str]:
    """The canonical login form of an email address, or None if it can't be a login email.

    Trimmed, NFKC, lower case; at most 150 characters; a valid Etebase username that is already in
    its normalized form; and shaped like an email address.
    """
    if not isinstance(raw, str):
        return None
    candidate = unicodedata.normalize("NFKC", raw.strip()).lower()
    if not candidate or len(candidate) > MAX_LOGIN_NAME_LENGTH or normalize_login_name(candidate) != candidate:
        return None
    if candidate.count("@") != 1:
        return None
    try:
        _username_validator(candidate)
        validate_email(candidate)
    except ValidationError:
        return None
    return candidate


def identity_user(user_id: int) -> UserType:
    """The user and its UserInfo read in one query, so username and login_version come from one snapshot."""
    with transaction.atomic():
        return User.objects.select_related("userinfo").get(pk=user_id)


def identity_of(user: UserType) -> t.Dict[str, t.Any]:
    info = getattr(user, "userinfo", None)
    return {"id": user.pk, "username": user.username, "loginVersion": info.login_version if info else 0}


def identity_snapshot(user_id: int) -> t.Dict[str, t.Any]:
    """`{id, username, loginVersion}` of one consistent read (see identity_user)."""
    return identity_of(identity_user(user_id))


PERMISSIONS_READ = [Depends(x) for x in app_settings.API_PERMISSIONS_READ]
PERMISSIONS_READWRITE = PERMISSIONS_READ + [Depends(x) for x in app_settings.API_PERMISSIONS_WRITE]


response_model_dict = {"model": HttpErrorOut}
permission_responses: t.Dict[t.Union[int, str], t.Dict[str, t.Any]] = {
    401: response_model_dict,
    403: response_model_dict,
}
