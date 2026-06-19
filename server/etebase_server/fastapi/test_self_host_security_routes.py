"""Focused tests for self-host security route exposure toggles."""

from __future__ import annotations

import importlib

from fastapi.testclient import TestClient


def test_fastapi_docs_routes_disabled_outside_debug(settings, tmp_path):
    settings.DEBUG = False
    settings.ALLOWED_HOSTS = ["testserver"]
    settings.STATIC_ROOT = str(tmp_path / "static")
    (tmp_path / "static").mkdir()

    from etebase_server.fastapi.main import create_application

    app = create_application()
    route_paths = {getattr(route, "path", "") for route in app.routes}
    client = TestClient(app)

    for path in ("/openapi.json", "/docs", "/redoc"):
        assert path not in route_paths
        assert client.get(path).status_code == 404


def test_fastapi_docs_routes_preserved_in_debug(settings, tmp_path):
    settings.DEBUG = True
    settings.ALLOWED_HOSTS = ["testserver"]
    settings.STATIC_ROOT = str(tmp_path / "static")
    (tmp_path / "static").mkdir()

    from etebase_server.fastapi.main import create_application

    app = create_application()
    route_paths = {getattr(route, "path", "") for route in app.routes}
    client = TestClient(app)

    for path in ("/openapi.json", "/docs", "/redoc"):
        assert path in route_paths
        assert client.get(path).status_code == 200


def _reload_urlpatterns_with_admin_disabled(settings, disabled: bool):
    settings.ETEBASE_DISABLE_DJANGO_ADMIN = disabled

    import etebase_server.urls as urls

    return importlib.reload(urls).urlpatterns


def test_django_admin_route_removed_when_disabled(settings):
    urlpatterns = _reload_urlpatterns_with_admin_disabled(settings, True)

    assert "admin/" not in {str(getattr(pattern, "pattern", "")) for pattern in urlpatterns}


def test_django_admin_route_present_by_default(settings):
    urlpatterns = _reload_urlpatterns_with_admin_disabled(settings, False)

    assert "admin/" in {str(getattr(pattern, "pattern", "")) for pattern in urlpatterns}
