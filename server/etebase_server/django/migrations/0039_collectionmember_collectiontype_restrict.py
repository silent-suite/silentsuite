import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """Let a user's deletion cascade through their own memberships' collection types.

    on_delete is enforced by Django, not the database, so this changes no schema.
    """

    dependencies = [("django_etebase", "0038_billing_link_proof")]

    operations = [
        migrations.AlterField(
            model_name="collectionmember",
            name="collectionType",
            field=models.ForeignKey(
                null=True, on_delete=django.db.models.deletion.RESTRICT, to="django_etebase.collectiontype"
            ),
        ),
    ]
