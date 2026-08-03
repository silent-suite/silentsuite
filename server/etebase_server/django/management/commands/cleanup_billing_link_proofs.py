from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import Q
from django.utils import timezone

from etebase_server.django.models import BillingLinkProof

BILLING_LINK_PROOF_RETENTION = timedelta(minutes=5)


class Command(BaseCommand):
    help = "Delete consumed and expired Billing link-proof metadata after its five-minute retention window."

    def handle(self, *args, **options):
        cutoff = timezone.now() - BILLING_LINK_PROOF_RETENTION
        deleted, _ = BillingLinkProof.objects.filter(
            Q(consumed_at__lte=cutoff) | Q(expires_at__lte=cutoff)
        ).delete()
        self.stdout.write(f"Deleted {deleted} Billing link proof(s).")
