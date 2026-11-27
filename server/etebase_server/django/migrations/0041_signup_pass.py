import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("django_etebase", "0040_login_email_change"),
    ]

    operations = [
        migrations.CreateModel(
            name="SignupPass",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("pass_hash", models.CharField(max_length=64, unique=True)),
                ("email", models.CharField(max_length=150)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
            ],
        ),
    ]
