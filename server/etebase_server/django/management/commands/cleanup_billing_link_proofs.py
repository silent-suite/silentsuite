from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import Q
from django.utils import timezone

from etebase_server.django.models import BillingLinkProof, HeldUsername, LoginEmailChange

BILLING_LINK_PROOF_RETENTION = timedelta(minutes=5)
# Login change rows stay this long after their end state. A committed one also stays until Billing
# has acknowledged it, so a lost commit reply can always be retried for the stored result.
LOGIN_EMAIL_CHANGE_RETENTION = timedelta(days=30)


class Command(BaseCommand):
    help = (
        "Delete consumed and expired Billing link-proof metadata after its five-minute retention window; "
        "expire open login email changes, release ended name holds and prune ended login email changes."
    )

    def handle(self, *args, **options):
        now = timezone.now()
        cutoff = now - BILLING_LINK_PROOF_RETENTION
        deleted, _ = BillingLinkProof.objects.filter(
            Q(consumed_at__lte=cutoff) | Q(expires_at__lte=cutoff)
        ).delete()
        self.stdout.write(f"Deleted {deleted} Billing link proof(s).")

        expired = LoginEmailChange.objects.filter(
            status__in=LoginEmailChange.OPEN_STATUSES, expires_at__lte=now
        ).update(status=LoginEmailChange.EXPIRED, ended_at=now)
        released, _ = HeldUsername.objects.filter(held_until__lte=now).delete()
        change_cutoff = now - LOGIN_EMAIL_CHANGE_RETENTION
        pruned, _ = (
            LoginEmailChange.objects.filter(ended_at__lte=change_cutoff)
            .exclude(status__in=LoginEmailChange.OPEN_STATUSES)
            .exclude(status=LoginEmailChange.COMMITTED, acknowledged_at__isnull=True)
            .delete()
        )
        if expired or released or pruned:
            self.stdout.write(
                f"Expired {expired} login email change(s), released {released} held name(s), "
                f"deleted {pruned} login email change(s)."
            )
