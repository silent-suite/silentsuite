from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from etebase_server.django.models import HeldUsername
from etebase_server.fastapi.utils import claim_names, normalize_login_name
from etebase_server.myauth.models import get_typed_user_model

User = get_typed_user_model()
CONFIRM_FLAG = "--confirm-old-devices-retired"


class Command(BaseCommand):
    help = (
        "Operator only: release the hold on one renamed-away login name so anyone may sign up with or "
        "rename to it again. Refuses a name that is some user's current username, and any hold unless "
        f"{CONFIRM_FLAG} is passed (a deleted account's devices and Bridge cache may still use the name)."
    )

    def add_arguments(self, parser):
        parser.add_argument("name", help="The held login name (compared in its normalized form).")
        parser.add_argument(
            CONFIRM_FLAG,
            action="store_true",
            dest="confirm_old_devices_retired",
            help="Every device or Bridge cache that may still use the old name is retired; release it.",
        )

    def handle(self, *args, **options):
        name = normalize_login_name(options["name"])
        with transaction.atomic():
            claim_names([name])
            if User.objects.filter(username__iexact=name).exists():
                raise CommandError(f"Refused: {name} is the current username of an account.")
            hold = HeldUsername.objects.select_for_update().filter(name=name).first()
            if hold is not None and not options["confirm_old_devices_retired"]:
                raise CommandError(f"Refused: {name} is held; pass {CONFIRM_FLAG} once its old devices are retired.")
            if hold is not None:
                hold.delete()
        if hold is not None:
            self.stdout.write(f"Released held name {name}.")
        else:
            self.stdout.write(f"No hold for {name}; nothing changed.")
