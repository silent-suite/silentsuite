import dataclasses

from django.db.models import Prefetch, QuerySet
from django.utils import timezone
from fastapi import Depends, Path
from fastapi.security import APIKeyHeader

from etebase_server.django import models
from etebase_server.django.token_auth.models import AuthToken, get_default_expiry
from etebase_server.myauth.models import UserType, get_typed_user_model

from .db_hack import django_db_cleanup_decorator
from .exceptions import AuthenticationFailed
from .utils import get_object_or_404

User = get_typed_user_model()
token_scheme = APIKeyHeader(name="Authorization")
AUTO_REFRESH = True
MIN_REFRESH_INTERVAL = 60


@dataclasses.dataclass(frozen=True)
class AuthData:
    user: UserType
    token: AuthToken


def __renew_token(auth_token: AuthToken):
    current_expiry = auth_token.expiry
    new_expiry = get_default_expiry()
    # Throttle refreshing of token to avoid db writes
    delta = (new_expiry - current_expiry).total_seconds()
    if delta > MIN_REFRESH_INTERVAL:
        auth_token.expiry = new_expiry
        auth_token.save(update_fields=("expiry",))


def __get_authenticated_user(api_token: str):
    parts = api_token.split()
    if len(parts) != 2:
        raise AuthenticationFailed(detail="Malformed Authorization header.")
    api_token = parts[1]
    try:
        token: AuthToken = AuthToken.objects.select_related("user").get(key=api_token)
    except AuthToken.DoesNotExist:
        raise AuthenticationFailed(detail="Invalid token.")
    if not token.user.is_active:
        raise AuthenticationFailed(detail="User inactive or deleted.")

    if token.expiry is not None:
        if token.expiry < timezone.now():
            token.delete()
            raise AuthenticationFailed(detail="Invalid token.")

        if AUTO_REFRESH:
            __renew_token(token)

    return token.user, token


@django_db_cleanup_decorator
def get_auth_data(api_token: str = Depends(token_scheme)) -> AuthData:
    user, token = __get_authenticated_user(api_token)
    return AuthData(user, token)


@django_db_cleanup_decorator
def get_authenticated_user(api_token: str = Depends(token_scheme)) -> UserType:
    user, _ = __get_authenticated_user(api_token)
    return user


@django_db_cleanup_decorator
def get_collection_queryset(user: UserType = Depends(get_authenticated_user)) -> QuerySet:
    default_queryset: QuerySet = models.Collection.objects.all()
    return default_queryset.filter(members__user=user)


@django_db_cleanup_decorator
def get_collection(
    collection_uid: str = Path(...),
    queryset: QuerySet = Depends(get_collection_queryset),
) -> models.Collection:
    return get_object_or_404(queryset, uid=collection_uid)


def build_item_queryset(collection: models.Collection) -> QuerySet:
    """Queryset for items in a collection, with the per-item revision +
    chunk graph prefetched.

    Serializing this queryset is the hot read path for sync polls and import
    refresh. Per-item access to `obj.content` (current revision) and the
    chunk graph below it must avoid an N+1 — see `test_item_list_queryset.py`
    and the 2026-03-25 revert (commit 4d7893f3) for why we are deliberate
    about the relation names.

    `to_attr` puts the filtered current revisions on `_prefetched_current_revisions`
    so `CollectionItem.content` can read it without a separate filter query.
    """
    current_revisions = models.CollectionItemRevision.objects.filter(current=True).prefetch_related(
        Prefetch(
            "chunks_relation",
            queryset=models.RevisionChunkRelation.objects.select_related("chunk"),
        )
    )
    return models.CollectionItem.objects.filter(
        collection__pk=collection.pk, revisions__current=True
    ).prefetch_related(
        Prefetch(
            "revisions",
            queryset=current_revisions,
            to_attr="_prefetched_current_revisions",
        )
    )


@django_db_cleanup_decorator
def get_item_queryset(collection: models.Collection = Depends(get_collection)) -> QuerySet:
    return build_item_queryset(collection)
