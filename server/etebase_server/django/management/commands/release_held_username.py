from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from etebase_server.django.models import HeldUsername
from etebase_server.fastapi.utils import claim_names, normalize_login_name
from etebase_server.myauth.models import get_typed_user_model

User = get_typed_user_model()


class Command(BaseCommand):
    help = (
        "Operator only: release the hold on one renamed-away login name so anyone may sign up with or "
        "rename to it again. Refuses a name that is some user's current username."
    )

    def add_arguments(self, parser):
        parser.add_argument("name", help="The held login name (compared in its normalized form).")

    def handle(self, *args, **options):
        name = normalize_login_name(options["name"])
        with transaction.atomic():
            claim_names([name])
            if User.objects.filter(username__iexact=name).exists():
                raise CommandError(f"Refused: {name} is the current username of an account.")
            deleted, _ = HeldUsername.objects.filter(name=name).delete()
        if deleted:
            self.stdout.write(f"Released held name {name}.")
        else:
            self.stdout.write(f"No hold for {name}; nothing changed.")
