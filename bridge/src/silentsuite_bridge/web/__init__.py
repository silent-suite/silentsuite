"""SilentSuite Bridge dashboard — Radicale web module.

Serves a status dashboard at the bridge root URL showing:
- Connection status (connected/disconnected/error)
- Account info
- CalDAV/CardDAV URLs with copy buttons
- Recent sync log
- Links to per-app setup guides

Integrates with Radicale's web module system.
"""

import html
import hmac
import json
import logging
import secrets
import threading
import time
from collections import deque

from radicale.web import BaseWeb

from .. import config
from ..radicale.creds import Credentials

logger = logging.getLogger("silentsuite-bridge.web")

# Global sync log (thread-safe deque)
_sync_log = deque(maxlen=50)
_bridge_status = {
    "state": "starting",  # starting, connected, error, disconnected
    "last_sync": None,
    "error": None,
    "collections": {"calendars": 0, "contacts": 0, "tasks": 0},
    "collections_by_account": {},
    "collections_scope": "all configured accounts",
}
_bridge_status_lock = threading.RLock()
# Process-local token protects localhost dashboard POSTs from cross-site form/script submissions.
_dashboard_csrf_token = secrets.token_urlsafe(32)


def _json_response(status, payload):
    return (
        status,
        {"Content-Type": "application/json"},
        json.dumps(payload).encode(),
    )


def _has_valid_csrf(environ):
    token = environ.get("HTTP_X_SILENTSUITE_CSRF", "")
    return bool(token) and hmac.compare_digest(token, _dashboard_csrf_token)


def _csrf_error():
    return _json_response(403, {"error": "Invalid dashboard CSRF token"})


def log_sync_event(event_type, message):
    """Add an entry to the sync log."""
    _sync_log.appendleft({
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "type": event_type,
        "message": message,
    })


def update_status(state, error=None, collections=None, account=None, scope=None):
    """Update the bridge status."""
    with _bridge_status_lock:
        _bridge_status["state"] = state
        if state == "connected":
            _bridge_status["last_sync"] = time.strftime("%Y-%m-%d %H:%M:%S")
            _bridge_status["error"] = None
        if error:
            _bridge_status["error"] = str(error)
        if collections:
            if account:
                _bridge_status.setdefault("collections_by_account", {})[account] = collections
                _bridge_status["collections"] = _aggregate_collections(
                    _bridge_status["collections_by_account"].values()
                )
                _bridge_status["collections_scope"] = "all configured accounts"
            elif scope:
                _bridge_status["collections"] = collections
                _bridge_status["collections_scope"] = scope
            else:
                _bridge_status["collections"] = collections


def forget_account_status(account):
    """Remove one account's in-memory dashboard status."""
    with _bridge_status_lock:
        account_collections = _bridge_status.setdefault("collections_by_account", {})
        account_collections.pop(account, None)
        _bridge_status["collections"] = _aggregate_collections(account_collections.values())


def _aggregate_collections(collections_iterable):
    totals = {"calendars": 0, "contacts": 0, "tasks": 0}
    for collections in collections_iterable:
        for key in totals:
            totals[key] += collections.get(key, 0)
    return totals


DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SilentSuite Bridge</title>
    <meta http-equiv="refresh" content="30">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            padding: 40px 20px;
        }
        .container { max-width: 680px; margin: 0 auto; }
        h1 { font-size: 28px; color: #fff; margin-bottom: 4px; }
        .version { color: #666; font-size: 13px; margin-bottom: 32px; }

        .status-card {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
        }
        .status-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
        }
        .status-dot {
            width: 12px; height: 12px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .status-dot.connected { background: #4ade80; box-shadow: 0 0 8px #4ade8066; }
        .status-dot.error { background: #ef4444; box-shadow: 0 0 8px #ef444466; }
        .status-dot.starting { background: #fbbf24; box-shadow: 0 0 8px #fbbf2466; }
        .status-dot.disconnected { background: #666; }
        .status-text { font-size: 16px; font-weight: 500; }

        .info-grid {
            display: grid;
            grid-template-columns: 120px 1fr;
            gap: 8px 16px;
            font-size: 14px;
        }
        .info-label { color: #888; }
        .info-value { color: #ccc; }
        .info-value code {
            background: #111;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 13px;
        }

        .url-section { margin-top: 20px; }
        .url-section h3 {
            font-size: 14px;
            color: #888;
            margin-bottom: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .url-box {
            background: #111;
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            padding: 12px 14px;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .url-box label {
            font-size: 12px;
            color: #666;
            display: block;
            margin-bottom: 2px;
        }
        .url-box code { color: #fff; font-size: 13px; }
        .copy-btn {
            background: #333;
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 11px;
        }
        .copy-btn:hover { background: #444; }
        .account-card {
            background: #111;
            border: 1px solid #2a2a2a;
            border-radius: 10px;
            padding: 14px;
            margin-bottom: 12px;
        }
        .account-card h4 {
            font-size: 15px;
            color: #fff;
            margin-bottom: 8px;
            overflow-wrap: anywhere;
        }
        .account-meta {
            color: #888;
            font-size: 12px;
            margin-bottom: 10px;
            overflow-wrap: anywhere;
        }

        .log-section { margin-top: 8px; }
        .log-section h3 {
            font-size: 14px;
            color: #888;
            margin-bottom: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .log-entry {
            font-size: 12px;
            font-family: monospace;
            padding: 6px 12px;
            border-bottom: 1px solid #1a1a1a;
            color: #888;
        }
        .log-entry .time { color: #555; margin-right: 8px; }
        .log-entry .type-sync { color: #4ade80; }
        .log-entry .type-error { color: #ef4444; }
        .log-entry .type-info { color: #60a5fa; }
        .log-empty {
            text-align: center;
            padding: 20px;
            color: #555;
            font-size: 13px;
        }

        .error-banner {
            background: #2a1010;
            border: 1px solid #5a2020;
            color: #ff6b6b;
            padding: 14px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <script>window.SILENTSUITE_DASHBOARD_CSRF = '{{CSRF_TOKEN}}';</script>
    <div class="container">
        <h1>SilentSuite Bridge</h1>
        <div class="version">v{{VERSION}}</div>
        <div style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:13px;color:#888;">
            Tip: Bookmark this page to easily find your connection details.
        </div>

        {{ERROR_BANNER}}

        <div class="status-card">
            <div class="status-header">
                <div class="status-dot {{STATUS_STATE}}"></div>
                <span class="status-text">{{STATUS_TEXT}}</span>
            </div>
            <div class="info-grid">
                <span class="info-label">Last sync</span>
                <span class="info-value">{{LAST_SYNC}}</span>
                <span class="info-label">{{COLLECTIONS_LABEL}}</span>
                <span class="info-value">{{COLLECTIONS}}</span>
                <span class="info-label">Sync interval</span>
                <span class="info-value">{{SYNC_INTERVAL_DISPLAY}}</span>
            </div>

            <div class="url-section">
                <h3>Configured Accounts</h3>
                {{ACCOUNT_LIST}}
            </div>
        </div>

        <div class="status-card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <button id="syncNowBtn" class="copy-btn" style="padding:8px 18px;font-size:13px;background:#1a7f37;color:#fff;" onclick="triggerSync()">Sync Now</button>
            <label style="font-size:13px;color:#888;">Sync every</label>
            <select id="syncInterval" onchange="updateInterval()" style="background:#111;color:#ccc;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:13px;">
                <option value="60">1 min</option>
                <option value="300">5 min</option>
                <option value="900">15 min</option>
                <option value="1800">30 min</option>
                <option value="3600">1 hr</option>
            </select>
            <span id="syncIntervalStatus" style="font-size:12px;color:#555;"></span>
            <span id="syncProgress" style="font-size:12px;color:#888;margin-left:auto;"></span>
        </div>
        <script>
            (function() {
                var sel = document.getElementById('syncInterval');
                sel.value = '{{SYNC_INTERVAL}}';
                // fallback if value doesn't match any option
                if (sel.selectedIndex === -1) sel.value = '900';
            })();
            function triggerSync() {
                var btn = document.getElementById('syncNowBtn');
                btn.textContent = 'Syncing...';
                btn.disabled = true;
                fetch('/.web/api/sync', {method:'POST', headers:{'X-SilentSuite-CSRF': window.SILENTSUITE_DASHBOARD_CSRF}})
                    .then(function(r) { return r.json(); })
                    .then(function() { btn.textContent = 'Done!'; setTimeout(function() { location.reload(); }, 1000); })
                    .catch(function() { btn.textContent = 'Error'; })
                    .finally(function() { setTimeout(function() { btn.disabled = false; btn.textContent = 'Sync Now'; }, 3000); });
            }
            function updateInterval() {
                var val = document.getElementById('syncInterval').value;
                var st = document.getElementById('syncIntervalStatus');
                fetch('/.web/api/settings', {method:'POST', headers:{'Content-Type':'application/json','X-SilentSuite-CSRF': window.SILENTSUITE_DASHBOARD_CSRF}, body: JSON.stringify({syncInterval: parseInt(val)})})
                    .then(function(r) { return r.json(); })
                    .then(function() { st.textContent = 'Saved'; setTimeout(function() { st.textContent = ''; }, 2000); })
                    .catch(function() { st.textContent = 'Error'; });
            }
            // Live sync-status pill. Polls /api/progress every 2s so users see
            // a running sync without waiting for the 30s full-page refresh.
            function pollProgress() {
                fetch('/.web/api/progress').then(function(r) { return r.json(); }).then(function(p) {
                    var el = document.getElementById('syncProgress');
                    if (!el) return;
                    if (p.is_syncing) {
                        var elapsed = p.sync_started_at ? Math.max(0, Math.round(Date.now() / 1000 - p.sync_started_at)) : null;
                        el.textContent = 'Syncing\u2026' + (elapsed != null ? ' (' + elapsed + 's)' : '');
                        el.style.color = '#4ade80';
                    } else if (p.last_sync_duration != null) {
                        el.textContent = 'Last sync: ' + p.last_sync_duration.toFixed(1) + 's';
                        el.style.color = '#888';
                    } else {
                        el.textContent = '';
                    }
                }).catch(function() { /* ignore — next poll retries */ });
            }
            pollProgress();
            setInterval(pollProgress, 2000);
        </script>

        <div class="status-card log-section">
            <h3>Sync Log</h3>
            {{SYNC_LOG}}
        </div>

        <div class="status-card">
            <h3 style="font-size:14px;color:#888;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">Setup Guides</h3>
            <div style="font-size:14px;line-height:2;color:#ccc;">
                <a href="https://docs.silentsuite.io/user-guide/apps/windows" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">Outlook</a> &middot;
                <a href="https://docs.silentsuite.io/user-guide/apps/thunderbird" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">Thunderbird</a> &middot;
                <a href="https://docs.silentsuite.io/user-guide/apps/macos" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">Apple (macOS/iOS)</a> &middot;
                <a href="https://docs.silentsuite.io/user-guide/apps/gnome" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">GNOME Calendar/Contacts</a> &middot;
                <a href="https://docs.silentsuite.io/user-guide/apps/android" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">DAVx5 (Android)</a> &middot;
                <a href="https://docs.silentsuite.io/user-guide/apps/evolution" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">Evolution</a> &middot;
                <a href="https://docs.silentsuite.io/user-guide/apps/kde" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">KDE</a>
            </div>
            <div style="margin-top:12px;font-size:13px;">
                <a href="https://docs.silentsuite.io/user-guide/apps/dav-bridge" target="_blank" rel="noopener" style="color:#4ade80;text-decoration:none;">Full documentation at docs.silentsuite.io &rarr;</a>
            </div>
        </div>
    </div>
    <script>
        function copy(event, id) {
            var text = document.getElementById(id).textContent;
            var btn = event.currentTarget;
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(function() {
                    btn.textContent = 'Copied!';
                    setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
                }).catch(function() {
                    fallbackCopy(text, btn);
                });
            } else {
                fallbackCopy(text, btn);
            }
        }
        function fallbackCopy(text, btn) {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); btn.textContent = 'Copied!'; }
            catch(e) { btn.textContent = 'Failed'; }
            document.body.removeChild(ta);
            setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
        }
    </script>
</body>
</html>"""


def _render_dashboard():
    """Render the dashboard HTML with current status."""
    from .. import __version__

    def esc(value):
        return html.escape(str(value))

    creds = Credentials()
    users = creds.list_users()

    base_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}"

    with _bridge_status_lock:
        state = _bridge_status["state"]
        last_sync = _bridge_status.get("last_sync", "Never")
        cols = dict(_bridge_status.get("collections", {}))
        account_cols = dict(_bridge_status.get("collections_by_account", {}))
        collections_scope = _bridge_status.get("collections_scope") or "all configured accounts"
        status_error = _bridge_status.get("error")

    status_map = {
        "starting": "Starting...",
        "connected": "Connected",
        "error": "Error",
        "disconnected": "Disconnected",
    }
    status_text = status_map.get(state, state)

    filtered_account_cols = [account_cols[user] for user in users if user in account_cols]
    if filtered_account_cols:
        cols = _aggregate_collections(filtered_account_cols)
    col_text = f"{cols.get('calendars', 0)} calendars, {cols.get('contacts', 0)} contacts, {cols.get('tasks', 0)} tasks"
    collections_label = f"Collections ({collections_scope})"

    error_banner = ""
    if status_error:
        error_banner = f'<div class="error-banner">{esc(status_error)}</div>'

    # Build sync log HTML
    if _sync_log:
        log_html = ""
        for entry in list(_sync_log)[:20]:
            entry_type = esc(entry['type'])
            type_class = f"type-{entry_type}"
            log_html += (
                f'<div class="log-entry">'
                f'<span class="time">{esc(entry["time"])}</span>'
                f'<span class="{type_class}">[{entry_type}]</span> '
                f'{esc(entry["message"])}'
                f'</div>'
            )
    else:
        log_html = '<div class="log-empty">No sync activity yet</div>'

    if users:
        account_html = ""
        for index, user in enumerate(users):
            dav_url = f"{base_url}/{user}/"
            server_url = creds.get_server_url(user)
            url_id = f"davUrl{index}"
            account_html += (
                '<div class="account-card">'
                f'<h4>{esc(user)}</h4>'
                f'<div class="account-meta">Server: <code>{esc(server_url)}</code></div>'
                '<div class="url-box">'
                '<div>'
                '<label>CalDAV/CardDAV URL</label>'
                f'<code id="{url_id}">{esc(dav_url)}</code>'
                '</div>'
                f'<button class="copy-btn" onclick="copy(event, \'{url_id}\')">Copy</button>'
                '</div>'
                '</div>'
            )
    else:
        account_html = '<div class="log-empty">No accounts configured</div>'

    page = DASHBOARD_HTML
    page = page.replace("{{VERSION}}", esc(__version__))
    page = page.replace("{{ERROR_BANNER}}", error_banner)
    page = page.replace("{{STATUS_STATE}}", esc(state))
    page = page.replace("{{STATUS_TEXT}}", esc(status_text))
    page = page.replace("{{LAST_SYNC}}", esc(last_sync or "Never"))
    page = page.replace("{{COLLECTIONS_LABEL}}", esc(collections_label))
    page = page.replace("{{COLLECTIONS}}", esc(col_text))
    page = page.replace("{{ACCOUNT_LIST}}", account_html)
    page = page.replace("{{SYNC_LOG}}", log_html)
    page = page.replace("{{CSRF_TOKEN}}", esc(_dashboard_csrf_token))

    # Sync interval display
    interval = config.SYNC_INTERVAL
    if interval >= 3600:
        interval_display = f"{interval // 3600} hr"
    elif interval >= 60:
        interval_display = f"{interval // 60} min"
    else:
        interval_display = f"{interval} sec"
    page = page.replace("{{SYNC_INTERVAL}}", str(interval))
    page = page.replace("{{SYNC_INTERVAL_DISPLAY}}", esc(interval_display))

    return page


class Web(BaseWeb):
    """SilentSuite Bridge dashboard web module for Radicale."""

    def __init__(self, configuration):
        super().__init__(configuration)

    def get(self, environ, base_prefix, path, user):
        """Serve the dashboard for GET requests to the root."""
        if path == "/.web/" or path == "/.web":
            html = _render_dashboard()
            return (
                200,
                {"Content-Type": "text/html; charset=utf-8"},
                html.encode(),
            )

        # API endpoint for JSON status
        if path == "/.web/api/status":
            with _bridge_status_lock:
                status = dict(_bridge_status)
                status["collections"] = dict(_bridge_status.get("collections", {}))
                status["collections_by_account"] = dict(
                    _bridge_status.get("collections_by_account", {})
                )
            data = {
                "status": status,
                "log": list(_sync_log)[:20],
            }
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps(data).encode(),
            )

        # Live sync progress — polled by the dashboard while a sync is running.
        if path == "/.web/api/progress":
            from ..radicale.storage import _sync_threads
            is_syncing = False
            sync_started_at = None
            last_sync_duration = None
            latest_completed_sync = None
            for thread in _sync_threads.values():
                if getattr(thread, "is_syncing", False):
                    is_syncing = True
                    started_at = getattr(thread, "sync_started_at", None)
                    if started_at is not None:
                        if sync_started_at is None or started_at < sync_started_at:
                            sync_started_at = started_at

                completed_at = getattr(thread, "last_sync", None)
                if (
                    getattr(thread, "last_sync_duration", None) is not None
                    and completed_at is not None
                    and (latest_completed_sync is None or completed_at > latest_completed_sync)
                ):
                    latest_completed_sync = completed_at
                    last_sync_duration = thread.last_sync_duration
            data = {
                "is_syncing": is_syncing,
                "sync_started_at": sync_started_at,
                "last_sync_duration": last_sync_duration,
            }
            with _bridge_status_lock:
                data["collections"] = dict(_bridge_status.get("collections", {}))
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps(data).encode(),
            )

        # Diagnostic: dump all cached items
        if path == "/.web/api/dump":
            if not config.DASHBOARD_DUMP_ENABLED:
                return (404, {}, b"Not found")
            from ..local_cache import models, db
            try:
                with db.database_proxy:
                    result = {"collections": []}
                    for col in models.CollectionEntity.select():
                        items = []
                        for item in col.items:
                            items.append({
                                "uid": item.uid,
                                "dirty": item.dirty,
                                "new": item.new,
                                "deleted": item.deleted,
                            })
                        result["collections"].append({
                            "uid": col.uid,
                            "stoken": col.stoken[:20] if col.stoken else None,
                            "local_stoken": col.local_stoken[:20] if col.local_stoken else None,
                            "dirty": col.dirty,
                            "new": col.new,
                            "deleted": col.deleted,
                            "item_count": len(items),
                            "items": items,
                        })
                return (
                    200,
                    {"Content-Type": "application/json"},
                    json.dumps(result, indent=2).encode(),
                )
            except Exception as e:
                return (
                    500,
                    {"Content-Type": "application/json"},
                    json.dumps({"error": str(e)}).encode(),
                )

        # API endpoint for current settings
        if path == "/.web/api/settings":
            data = {"syncInterval": config.SYNC_INTERVAL}
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps(data).encode(),
            )

        return (404, {}, b"Not found")

    def post(self, environ, base_prefix, path, user):
        """Handle POST requests for API endpoints."""
        from ..radicale.storage import get_sync_thread, _sync_threads

        content_length = int(environ.get("CONTENT_LENGTH", 0) or 0)
        body = environ["wsgi.input"].read(content_length) if content_length else b""

        # Trigger immediate sync
        if path == "/.web/api/sync":
            if not _has_valid_csrf(environ):
                return _csrf_error()
            for thread in _sync_threads.values():
                if thread.is_alive():
                    thread.force_sync()
                    thread.wait_for_sync(30)
            log_sync_event("info", "Manual sync triggered from dashboard")
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps({"ok": True}).encode(),
            )

        # Update settings
        if path == "/.web/api/settings":
            if not _has_valid_csrf(environ):
                return _csrf_error()
            try:
                data = json.loads(body)
            except (json.JSONDecodeError, ValueError):
                return (
                    400,
                    {"Content-Type": "application/json"},
                    json.dumps({"error": "Invalid JSON"}).encode(),
                )

            if "syncInterval" in data:
                new_interval = int(data["syncInterval"])
                if new_interval < 30:
                    new_interval = 30  # enforce minimum

                # Save to settings.json
                settings = config.get_settings()
                settings["syncInterval"] = new_interval
                config.save_settings(settings)

                # Update running config
                config.SYNC_INTERVAL = new_interval

                # Update all running SyncThreads
                for thread in _sync_threads.values():
                    if thread.is_alive():
                        thread.set_interval(new_interval)

                log_sync_event("info", f"Sync interval changed to {new_interval}s")

            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps({"ok": True, "syncInterval": config.SYNC_INTERVAL}).encode(),
            )

        return (404, {}, b"Not found")
