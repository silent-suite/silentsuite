"""SilentSuite Bridge dashboard — Radicale web module.

Serves a status dashboard at the bridge root URL showing:
- Connection status (connected/disconnected/error)
- Account info
- CalDAV/CardDAV URLs with copy buttons
- Recent sync log
- Links to per-app setup guides

Integrates with Radicale's web module system.
"""

import json
import logging
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
}


def log_sync_event(event_type, message):
    """Add an entry to the sync log."""
    _sync_log.appendleft({
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "type": event_type,
        "message": message,
    })


def update_status(state, error=None, collections=None):
    """Update the bridge status."""
    _bridge_status["state"] = state
    if state == "connected":
        _bridge_status["last_sync"] = time.strftime("%Y-%m-%d %H:%M:%S")
        _bridge_status["error"] = None
    if error:
        _bridge_status["error"] = str(error)
    if collections:
        _bridge_status["collections"] = collections


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
    <div class="container">
        <h1>SilentSuite Bridge</h1>
        <div class="version">v{{VERSION}}</div>

        {{ERROR_BANNER}}

        <div class="status-card">
            <div class="status-header">
                <div class="status-dot {{STATUS_STATE}}"></div>
                <span class="status-text">{{STATUS_TEXT}}</span>
            </div>
            <div class="info-grid">
                <span class="info-label">Account</span>
                <span class="info-value">{{USER_EMAIL}}</span>
                <span class="info-label">Server</span>
                <span class="info-value"><code>{{SERVER_URL}}</code></span>
                <span class="info-label">Last sync</span>
                <span class="info-value">{{LAST_SYNC}}</span>
                <span class="info-label">Collections</span>
                <span class="info-value">{{COLLECTIONS}}</span>
            </div>

            <div class="url-section">
                <h3>Connection URLs</h3>
                <div class="url-box">
                    <div>
                        <label>CalDAV (Calendars + Tasks)</label>
                        <code id="caldavUrl">{{CALDAV_URL}}</code>
                    </div>
                    <button class="copy-btn" onclick="copy('caldavUrl')">Copy</button>
                </div>
                <div class="url-box">
                    <div>
                        <label>CardDAV (Contacts)</label>
                        <code id="carddavUrl">{{CARDDAV_URL}}</code>
                    </div>
                    <button class="copy-btn" onclick="copy('carddavUrl')">Copy</button>
                </div>
            </div>
        </div>

        <div class="status-card log-section">
            <h3>Sync Log</h3>
            {{SYNC_LOG}}
        </div>
    </div>
    <script>
        function copy(id) {
            const text = document.getElementById(id).textContent;
            navigator.clipboard.writeText(text).then(() => {
                const btn = event.target;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = 'Copy', 2000);
            });
        }
    </script>
</body>
</html>"""


def _render_dashboard():
    """Render the dashboard HTML with current status."""
    from .. import __version__

    creds = Credentials()
    users = creds.list_users()
    email = users[0] if users else "Not configured"

    base_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}"
    caldav_url = f"{base_url}/{email}/" if users else "N/A"
    carddav_url = caldav_url

    state = _bridge_status["state"]
    status_map = {
        "starting": "Starting...",
        "connected": "Connected",
        "error": "Error",
        "disconnected": "Disconnected",
    }
    status_text = status_map.get(state, state)

    last_sync = _bridge_status.get("last_sync", "Never")
    cols = _bridge_status.get("collections", {})
    col_text = f"{cols.get('calendars', 0)} calendars, {cols.get('contacts', 0)} contacts, {cols.get('tasks', 0)} tasks"

    error_banner = ""
    if _bridge_status.get("error"):
        error_banner = f'<div class="error-banner">{_bridge_status["error"]}</div>'

    # Build sync log HTML
    if _sync_log:
        log_html = ""
        for entry in list(_sync_log)[:20]:
            type_class = f"type-{entry['type']}"
            log_html += (
                f'<div class="log-entry">'
                f'<span class="time">{entry["time"]}</span>'
                f'<span class="{type_class}">[{entry["type"]}]</span> '
                f'{entry["message"]}'
                f'</div>'
            )
    else:
        log_html = '<div class="log-empty">No sync activity yet</div>'

    html = DASHBOARD_HTML
    html = html.replace("{{VERSION}}", __version__)
    html = html.replace("{{ERROR_BANNER}}", error_banner)
    html = html.replace("{{STATUS_STATE}}", state)
    html = html.replace("{{STATUS_TEXT}}", status_text)
    html = html.replace("{{USER_EMAIL}}", email)
    html = html.replace("{{SERVER_URL}}", config.ETEBASE_SERVER_URL)
    html = html.replace("{{LAST_SYNC}}", last_sync or "Never")
    html = html.replace("{{COLLECTIONS}}", col_text)
    html = html.replace("{{CALDAV_URL}}", caldav_url)
    html = html.replace("{{CARDDAV_URL}}", carddav_url)
    html = html.replace("{{SYNC_LOG}}", log_html)

    return html


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
            data = {
                "status": _bridge_status,
                "log": list(_sync_log)[:20],
            }
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps(data).encode(),
            )

        return (404, {}, b"Not found")
