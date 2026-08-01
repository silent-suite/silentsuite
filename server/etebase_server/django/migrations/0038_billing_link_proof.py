from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("django_etebase", "0037_auto_20210127_1237")]

    operations = [
        migrations.CreateModel(
            name="BillingLinkProof",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("proof_hash", models.CharField(db_index=True, max_length=64, unique=True)),
                ("audience", models.CharField(default="billing", max_length=32)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
                ("user", models.ForeignKey(on_delete=models.deletion.CASCADE, to=settings.AUTH_USER_MODEL)),
            ],
        ),
    ]
