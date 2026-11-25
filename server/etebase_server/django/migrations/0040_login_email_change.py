import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("django_etebase", "0039_collectionmember_collectiontype_restrict"),
    ]

    operations = [
        migrations.AddField(
            model_name="userinfo",
            name="login_version",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.CreateModel(
            name="LoginEmailChange",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("old_username", models.CharField(max_length=150)),
                ("new_username", models.CharField(max_length=150)),
                ("from_version", models.PositiveIntegerField()),
                ("login_pubkey_hash", models.CharField(max_length=64)),
                ("challenge_hash", models.CharField(max_length=64, unique=True)),
                ("handoff_hash", models.CharField(blank=True, max_length=64, null=True, unique=True)),
                ("grant_hash", models.CharField(blank=True, max_length=64, null=True, unique=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "pending"),
                            ("accepted", "accepted"),
                            ("committed", "committed"),
                            ("superseded", "superseded"),
                            ("expired", "expired"),
                            ("cancelled", "cancelled"),
                            ("refused", "refused"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("refusal", models.CharField(blank=True, default="", max_length=32)),
                ("created_at", models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("ended_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("committed_version", models.PositiveIntegerField(blank=True, null=True)),
                ("committed_at", models.DateTimeField(blank=True, null=True)),
                ("acknowledged_at", models.DateTimeField(blank=True, null=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="HeldUsername",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=150, unique=True)),
                ("held_until", models.DateTimeField(db_index=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL
                    ),
                ),
            ],
        ),
    ]
