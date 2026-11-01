"""T3 (#171): default server URL in the dashboard settings API.

Contract (implementation-plan-v2 §6, server URL):
- ``GET /.web/api/settings`` keeps ``syncInterval`` as a number and adds
  ``serverUrl: {"value", "source", "editable"}``. ``source`` is one of
  ``"cli"`` (--server), ``"env"`` (SILENTSUITE_SERVER_URL), ``"saved"``
  (settings.json ``serverUrl``) or ``"default"`` (built-in), in that
  precedence order. Only ``saved`` and ``default`` are editable.
- ``POST {"serverUrl": ...}`` saves the default for new sign-ins through the
  canonical settings writer: other saved keys are preserved, the lock and
  error paths are the existing ones. A non-editable source returns 409. A
  value that is not a string with an http/https scheme and a non-empty host
  returns 400. Neither touches settings.json.
- Existing accounts keep the server URL stored in their credentials.

Requests go through the real ``Web`` route with trusted loopback evidence,
the real Host check and the real CSRF token. Data lives in ``tmp_path``. No
account, network or service is used.
"""

import io
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

import silentsuite_bridge.auth_browser as auth_browser
import silentsuite_bridge.web as web_module
from silentsuite_bridge import config
from silentsuite_bridge.radicale.creds import Credentials
from silentsuite_bridge.radicale.server import _ListenerEvidence
from tests.settings_lock_holder import hold_settings_lock

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
SERVER_ENV = "SILENTSUITE_SERVER_URL"
BUILT_IN_SERVER_URL = "https://server.silentsuite.io"
SAVED_URL = "https://saved.example.invalid"
ENV_URL = "https://env.example.invalid"
CLI_URL = "https://cli.example.invalid"
ACCOUNT_URL = "https://account.example.invalid"

NETWORK_ENV = tuple(config.NETWORK_PROFILE_ENV.values())
OTHER_ENV = (
    "SILENTSUITE_DATA_DIR",
    "SILENTSUITE_BRIDGE_SSL",
    "SILENTSUITE_SSL",
    "SILENTSUITE_BRIDGE_SSL_CERT",
    "SILENTSUITE_SSL_CERT",
    "SILENTSUITE_BRIDGE_SSL_KEY",
    "SILENTSUITE_SSL_KEY",
    SERVER_ENV,
)
RESOLVED_GLOBALS = (
    "LISTEN_ADDRESS",
    "LISTEN_PORT",
    "DEFAULT_SERVER_HOSTS",
    "SERVER_HOSTS",
    "ALLOW_REMOTE",
    "NETWORK_PROFILE_ERROR",
    "SSL_ENABLED",
    "SSL_CERT_FILE",
    "SSL_KEY_FILE",
    "SYNC_INTERVAL",
    "ETEBASE_SERVER_URL",
)


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    """Isolated data dir and settings.json; process started without env or --server."""
    for variable in NETWORK_ENV + OTHER_ENV:
        monkeypatch.delenv(variable, raising=False)
    for name in RESOLVED_GLOBALS:
        monkeypatch.setattr(config, name, getattr(config, name))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", str(path))
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "credentials.json"))
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(config, "ETEBASE_SERVER_URL", BUILT_IN_SERVER_URL)
    return path


def _write(path, payload):
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _environ(body=None, csrf_token=None):
    evidence = _ListenerEvidence(
        listener=("127.0.0.1", 37358),
        accepted_local=("127.0.0.1", 37358),
        peer="127.0.0.1",
        ssl=False,
    )
    environ = {
        "HTTP_HOST": "127.0.0.1:37358",
        "REMOTE_ADDR": "127.0.0.1",
        "silentsuite_bridge.evidence": evidence,
    }
    if body is not None:
        environ["CONTENT_LENGTH"] = str(len(body))
        environ["wsgi.input"] = io.BytesIO(body)
    if csrf_token is not None:
        environ["HTTP_X_SILENTSUITE_CSRF"] = csrf_token
    return environ


def _get_settings():
    status, headers, body = web_module.Web.__new__(web_module.Web).get(
        _environ(), "", "/.web/api/settings", None
    )
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    return json.loads(body)


def _post_settings(payload):
    body = json.dumps(payload).encode()
    status, headers, response = web_module.Web.__new__(web_module.Web).post(
        _environ(body, web_module._dashboard_csrf_token), "", "/.web/api/settings", None
    )
    return status, headers, json.loads(response) if response else None


def test_settings_get_reports_saved_server_url_as_editable_default(settings_file):
    _write(settings_file, {"serverUrl": SAVED_URL, "syncInterval": 120})
    config.load_settings()

    settings = _get_settings()

    assert settings.get("serverUrl") == {"value": SAVED_URL, "source": "saved", "editable": True}
    assert settings["syncInterval"] == 120


def test_settings_get_reports_built_in_server_url_when_nothing_is_configured(settings_file):
    config.load_settings()

    settings = _get_settings()

    assert settings.get("serverUrl") == {"value": BUILT_IN_SERVER_URL, "source": "default", "editable": True}


def test_settings_get_keeps_sync_interval_a_plain_number(settings_file):
    # Control: existing consumers read syncInterval directly.
    _write(settings_file, {"syncInterval": 300})
    config.load_settings()

    settings = _get_settings()

    assert settings["syncInterval"] == 300
    assert isinstance(settings["syncInterval"], int)


def test_environment_server_url_overrides_saved_and_is_not_editable(settings_file, monkeypatch):
    _write(settings_file, {"serverUrl": SAVED_URL, "customKey": "keep-me"})
    original = settings_file.read_bytes()
    monkeypatch.setenv(SERVER_ENV, ENV_URL)
    config.load_settings()

    settings = _get_settings()
    assert settings.get("serverUrl") == {"value": ENV_URL, "source": "env", "editable": False}

    status, headers, response = _post_settings({"serverUrl": "https://other.example.invalid"})
    assert status == 409
    assert headers["Content-Type"] == "application/json"
    assert "error" in response
    assert settings_file.read_bytes() == original
    assert _get_settings()["serverUrl"]["value"] == ENV_URL


# The --server flag is only visible through a real start, so this case runs
# main() in a fresh child process (no state leaks into this pytest process).
# Only the stages after the instance lock are replaced; inside the replaced
# serving stage the child calls the real settings route.
CLI_CHILD = """
import io
import json
import sys

from silentsuite_bridge import __main__ as bridge_main
import silentsuite_bridge.web as web_module
from silentsuite_bridge.radicale.server import _ListenerEvidence

cli_url = sys.argv[1]
result = {}


def environ(body=None, csrf=None):
    evidence = _ListenerEvidence(
        listener=("127.0.0.1", 37358), accepted_local=("127.0.0.1", 37358), peer="127.0.0.1", ssl=False,
    )
    env = {"HTTP_HOST": "127.0.0.1:37358", "REMOTE_ADDR": "127.0.0.1", "silentsuite_bridge.evidence": evidence}
    if body is not None:
        env["CONTENT_LENGTH"] = str(len(body))
        env["wsgi.input"] = io.BytesIO(body)
    if csrf is not None:
        env["HTTP_X_SILENTSUITE_CSRF"] = csrf
    return env


def decode(body):
    try:
        return json.loads(body)
    except ValueError:
        return {"raw": body.decode("utf-8", "replace")}


def serve():
    web = web_module.Web.__new__(web_module.Web)
    status, _, body = web.get(environ(), "", "/.web/api/settings", None)
    result["get"] = [status, decode(body)]
    payload = json.dumps({"serverUrl": "https://dashboard.example.invalid"}).encode()
    status, _, body = web.post(environ(payload, web_module._dashboard_csrf_token), "", "/.web/api/settings", None)
    result["post"] = [status, decode(body)]


bridge_main.configure_logging = lambda: None
bridge_main._prepare_server_start = lambda open_browser=True: True
bridge_main.run_server = serve
sys.argv = ["silentsuite-bridge", "--server", cli_url, "--no-tray"]
bridge_main.main()
print("RESULT " + json.dumps(result), flush=True)
"""


def test_cli_server_flag_overrides_environment_and_saved_in_a_real_start(tmp_path):
    data_dir = tmp_path / "cli-data"
    data_dir.mkdir()
    settings_path = data_dir / "settings.json"
    _write(settings_path, {"serverUrl": SAVED_URL, "customKey": "keep-me"})
    original = settings_path.read_bytes()

    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data_dir),
        SERVER_ENV: ENV_URL,
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    completed = subprocess.run(
        [sys.executable, "-c", CLI_CHILD, CLI_URL],
        capture_output=True, text=True, timeout=60, env=env,
    )
    lines = [line for line in completed.stdout.splitlines() if line.startswith("RESULT ")]
    assert completed.returncode == 0 and lines, (
        f"CLI start fixture failed (not RED): rc={completed.returncode}\n{completed.stdout}\n{completed.stderr}"
    )
    result = json.loads(lines[-1][len("RESULT "):])

    get_status, settings = result["get"]
    assert get_status == 200
    assert settings.get("serverUrl") == {"value": CLI_URL, "source": "cli", "editable": False}

    post_status, response = result["post"]
    assert post_status == 409
    assert "error" in response
    assert settings_path.read_bytes() == original


def test_saving_a_server_url_preserves_other_settings_and_becomes_the_new_sign_in_default(settings_file):
    _write(settings_file, {"syncInterval": 120, "network": {"listenPort": 45123}, "customKey": "keep-me"})
    config.load_settings()

    status, _, response = _post_settings({"serverUrl": SAVED_URL})

    assert status == 200
    assert response["ok"] is True
    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "syncInterval": 120,
        "network": {"listenPort": 45123},
        "customKey": "keep-me",
        "serverUrl": SAVED_URL,
    }
    assert _get_settings()["serverUrl"] == {"value": SAVED_URL, "source": "saved", "editable": True}
    # New sign-ins: the dashboard login form offers the saved default.
    html = web_module._render_dashboard()
    assert f'id="dashboardServerUrl" name="serverUrl" value="{SAVED_URL}"' in html


def test_saving_a_server_url_leaves_existing_account_server_urls_untouched(settings_file, tmp_path):
    # Control for the "new sign-ins only" rule.
    creds = Credentials(str(tmp_path / "credentials.json"))
    creds.set_etebase("alice@example.invalid", "synthetic-session", ACCOUNT_URL)
    creds.save()
    creds_bytes = (tmp_path / "credentials.json").read_bytes()
    config.load_settings()

    status, _, _ = _post_settings({"serverUrl": SAVED_URL})

    assert status == 200
    assert (tmp_path / "credentials.json").read_bytes() == creds_bytes
    assert Credentials(str(tmp_path / "credentials.json")).get_server_url("alice@example.invalid") == ACCOUNT_URL


def test_saving_a_server_url_keeps_a_legacy_account_without_stored_server_url_on_its_destination(
    settings_file, tmp_path
):
    # A legacy credential entry has a stored session but no serverUrl, so
    # Credentials.get_server_url falls back to a process-wide default
    # (creds.py:75-81). Saving a new-sign-in default must not move it.
    creds_path = tmp_path / "credentials.json"
    creds_path.write_text(
        json.dumps({"users": {"legacy@example.invalid": {"storedSession": "synthetic-session"}}}),
        encoding="utf-8",
    )
    creds_bytes = creds_path.read_bytes()
    config.load_settings()
    destination_before = Credentials(str(creds_path)).get_server_url("legacy@example.invalid")

    status, _, _ = _post_settings({"serverUrl": SAVED_URL})

    # Existing-account control. These assertions pass on current source,
    # where the POST ignores serverUrl.
    assert status == 200
    assert creds_path.read_bytes() == creds_bytes
    assert Credentials(str(creds_path)).get_server_url("legacy@example.invalid") == destination_before
    config.load_settings()
    assert Credentials(str(creds_path)).get_server_url("legacy@example.invalid") == destination_before

    # New-feature RED: new sign-ins get the saved default.
    assert _get_settings().get("serverUrl") == {"value": SAVED_URL, "source": "saved", "editable": True}
    html = web_module._render_dashboard()
    assert f'id="dashboardServerUrl" name="serverUrl" value="{SAVED_URL}"' in html


@pytest.mark.parametrize("configured_source", ["saved", "env"])
def test_new_sign_in_default_is_reported_correctly_after_an_account_signs_in_elsewhere(
    settings_file, monkeypatch, configured_source
):
    # Existing behaviour (auth_browser.py:74-76): a successful sign-in to an
    # explicit server rewrites config.ETEBASE_SERVER_URL to that account's
    # host. The new-sign-in default and its source must still follow the
    # precedence contract (env > saved), not the last account's host.
    account_host = "https://account-host.example.invalid"
    _write(settings_file, {"serverUrl": SAVED_URL})
    if configured_source == "env":
        monkeypatch.setenv(SERVER_ENV, ENV_URL)
    config.load_settings()
    expected = (
        {"value": ENV_URL, "source": "env", "editable": False}
        if configured_source == "env"
        else {"value": SAVED_URL, "source": "saved", "editable": True}
    )

    # Run the genuine authenticate_and_store_account. Only the etebase client
    # and the credential write are stubbed, as in existing account tests; no
    # network, no provider traffic, no account file is written.
    clients = []

    def fake_client(name, server_url):
        clients.append(server_url)
        return object()

    fake_account = types.SimpleNamespace(save=lambda _key: "synthetic-session")
    monkeypatch.setattr(auth_browser, "Client", fake_client)
    monkeypatch.setattr(
        auth_browser,
        "Account",
        types.SimpleNamespace(login=lambda client, email, password: fake_account),
    )
    monkeypatch.setattr(
        auth_browser,
        "store_authenticated_account",
        lambda email, password, session, server_url: types.SimpleNamespace(username=email),
    )

    result = auth_browser.authenticate_and_store_account("bob@example.invalid", "synthetic", account_host)

    # Witness that the sign-in really used the account's explicit host.
    assert clients == [account_host]
    assert result.server_url == account_host

    # New-feature RED: the reported default for new sign-ins is unchanged by it.
    assert _get_settings().get("serverUrl") == expected
    if configured_source == "saved":
        html = web_module._render_dashboard()
        assert f'id="dashboardServerUrl" name="serverUrl" value="{SAVED_URL}"' in html


@pytest.mark.parametrize(
    "value",
    [
        "ftp://server.example.invalid",
        "https://",
        "http://:8080",
        "server.example.invalid",
        "javascript:alert(1)",
        42,
    ],
)
def test_invalid_server_url_is_rejected_without_changing_settings(settings_file, value):
    _write(settings_file, {"serverUrl": SAVED_URL, "customKey": "keep-me"})
    original = settings_file.read_bytes()
    config.load_settings()

    status, headers, response = _post_settings({"serverUrl": value})

    assert status == 400
    assert headers["Content-Type"] == "application/json"
    assert "error" in response
    assert settings_file.read_bytes() == original
    assert _get_settings()["serverUrl"]["value"] == SAVED_URL


def test_invalid_server_url_in_a_combined_post_changes_nothing(settings_file):
    _write(settings_file, {"syncInterval": 900})
    original = settings_file.read_bytes()
    config.load_settings()

    status, _, _ = _post_settings({"syncInterval": 60, "serverUrl": "ftp://server.example.invalid"})

    assert status == 400
    assert settings_file.read_bytes() == original
    assert config.SYNC_INTERVAL == 900


def test_server_url_save_reports_lock_contention_without_writing(settings_file, tmp_path, monkeypatch):
    _write(settings_file, {"syncInterval": 900})
    original = settings_file.read_bytes()
    config.load_settings()
    monkeypatch.setattr(config, "SETTINGS_LOCK_TIMEOUT", 0.2)

    with hold_settings_lock(tmp_path, {"network": {"listenPort": 45123}}) as installer:
        status, headers, response = _post_settings({"serverUrl": SAVED_URL})

        assert status == 503
        assert headers["Content-Type"] == "application/json"
        assert "error" in response
        assert settings_file.read_bytes() == original

        assert installer.written == {"syncInterval": 900, "network": {"listenPort": 45123}}

    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "syncInterval": 900,
        "network": {"listenPort": 45123},
    }
