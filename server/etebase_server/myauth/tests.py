"""Basic smoke tests for the SilentSuite Etebase server."""

import os
import sys

import django
from django.test import TestCase, override_settings

# Ensure Django is configured before any imports that need it
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "etebase_server.settings")


class DjangoAppLoadTest(TestCase):
    """Verify the Django application loads without errors."""

    def test_django_setup(self):
        """Django should initialize successfully."""
        # If we got here, django.setup() already succeeded via the test runner
        self.assertTrue(django.conf.settings.configured)

    def test_installed_apps(self):
        """All installed apps should load."""
        from django.apps import apps

        installed = [app.name for app in apps.get_app_configs()]
        self.assertIn("django.contrib.auth", installed)
        self.assertIn("django.contrib.contenttypes", installed)

    def test_auth_user_model(self):
        """Custom auth user model should be set."""
        from django.conf import settings

        self.assertEqual(settings.AUTH_USER_MODEL, "myauth.User")


@override_settings(ALLOWED_HOSTS=["*"], DEBUG=True)
class URLRoutingTest(TestCase):
    """Verify basic URL routing is configured."""

    def test_root_url_resolves(self):
        """Root URL should resolve (template may not exist in CI, just check routing)."""
        from django.urls import resolve, Resolver404

        try:
            match = resolve("/")
            self.assertIsNotNone(match)
        except Resolver404:
            self.fail("Root URL '/' does not resolve to any view")

    def test_admin_url_resolves(self):
        """Admin URL should resolve."""
        from django.urls import resolve, Resolver404

        try:
            match = resolve("/admin/login/")
            self.assertIsNotNone(match)
        except Resolver404:
            self.fail("Admin URL '/admin/login/' does not resolve")

    def test_admin_responds(self):
        """Admin login page should return a response."""
        response = self.client.get("/admin/login/")
        self.assertIn(response.status_code, [200, 301, 302])
