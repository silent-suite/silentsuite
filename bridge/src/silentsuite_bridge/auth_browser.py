"""Browser-based authentication for SilentSuite Bridge.

Implements an OAuth-style flow:
1. Bridge starts a temporary HTTP server on a random localhost port
2. Opens the user's default browser to the auth page
3. User enters SilentSuite credentials in the browser
4. Bridge authenticates with Etebase server
5. On success, stores session token + password hash
6. Redirects browser to the bridge dashboard

For MVP, the auth page is served by the bridge itself.
In the future, this will redirect to app.silentsuite.io/bridge-auth.
"""

import hashlib
import http.server
import json
import logging
import socket
import threading
import urllib.parse
import webbrowser

from etebase import Account, Client

from . import config
from .radicale.creds import Credentials

logger = logging.getLogger("silentsuite-bridge.auth")

# Simple HTML auth page
AUTH_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SilentSuite Bridge — Login</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        .container {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 40px;
            max-width: 420px;
            width: 100%;
        }
        h1 {
            font-size: 24px;
            margin-bottom: 8px;
            color: #fff;
        }
        .subtitle {
            color: #888;
            margin-bottom: 32px;
            font-size: 14px;
        }
        .server-info {
            background: #111;
            border: 1px solid #2a2a2a;
            border-radius: 6px;
            padding: 10px 14px;
            margin-bottom: 24px;
            font-size: 13px;
            color: #888;
        }
        .server-info code {
            color: #aaa;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-size: 14px;
            color: #ccc;
        }
        input[type="email"], input[type="password"] {
            width: 100%;
            padding: 12px 14px;
            background: #111;
            border: 1px solid #333;
            border-radius: 8px;
            color: #fff;
            font-size: 16px;
            margin-bottom: 16px;
            outline: none;
            transition: border-color 0.2s;
        }
        input:focus {
            border-color: #555;
        }
        button {
            width: 100%;
            padding: 14px;
            background: #fff;
            color: #000;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
        }
        button:hover { opacity: 0.9; }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .error {
            background: #2a1010;
            border: 1px solid #5a2020;
            color: #ff6b6b;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 16px;
            font-size: 14px;
            display: none;
        }
        .spinner {
            display: none;
            text-align: center;
            padding: 20px;
            color: #888;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>SilentSuite Bridge</h1>
        <p class="subtitle">Sign in to connect your calendar and contacts apps</p>
        <div class="server-info">
            Connecting to <code>SERVER_URL</code>
        </div>
        <div class="error" id="error"></div>
        <form id="loginForm" method="POST" action="/auth">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autofocus
                   placeholder="you@example.com">

            <label for="password">Password</label>
            <input type="password" id="password" name="password" required
                   placeholder="Your SilentSuite password">

            <button type="submit" id="submitBtn">Sign In</button>
        </form>
        <div class="spinner" id="spinner">Authenticating...</div>
    </div>
    <script>
        const form = document.getElementById('loginForm');
        const btn = document.getElementById('submitBtn');
        const spinner = document.getElementById('spinner');
        const errorDiv = document.getElementById('error');

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            errorDiv.style.display = 'none';
            btn.disabled = true;
            spinner.style.display = 'block';

            const data = new URLSearchParams(new FormData(form));
            try {
                const resp = await fetch('/auth', {
                    method: 'POST',
                    body: data
                });
                const result = await resp.json();
                if (result.success) {
                    window.location.href = result.redirect;
                } else {
                    errorDiv.textContent = result.error;
                    errorDiv.style.display = 'block';
                    btn.disabled = false;
                    spinner.style.display = 'none';
                }
            } catch (err) {
                errorDiv.textContent = 'Connection error: ' + err.message;
                errorDiv.style.display = 'block';
                btn.disabled = false;
                spinner.style.display = 'none';
            }
        });
    </script>
</body>
</html>"""

SUCCESS_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SilentSuite Bridge — Connected</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        .container {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 40px;
            max-width: 520px;
            width: 100%;
        }
        h1 { font-size: 24px; margin-bottom: 8px; color: #4ade80; }
        .subtitle { color: #888; margin-bottom: 24px; font-size: 14px; }
        .url-box {
            background: #111;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 14px;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .url-box label {
            font-size: 12px;
            color: #888;
            display: block;
            margin-bottom: 4px;
        }
        .url-box code {
            color: #fff;
            font-size: 14px;
        }
        .copy-btn {
            background: #333;
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 8px 14px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
        }
        .copy-btn:hover { background: #444; }
        .info {
            background: #0a1a15;
            border: 1px solid #1a3a2a;
            border-radius: 8px;
            padding: 14px;
            margin-top: 20px;
            font-size: 13px;
            color: #aaa;
        }
        .info strong { color: #ccc; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Bridge Connected</h1>
        <p class="subtitle">Signed in as <strong>USER_EMAIL</strong></p>

        <div class="url-box">
            <div>
                <label>CalDAV URL (Calendars + Tasks)</label>
                <code id="caldavUrl">CALDAV_URL</code>
            </div>
            <button class="copy-btn" onclick="copy('caldavUrl')">Copy</button>
        </div>

        <div class="url-box">
            <div>
                <label>CardDAV URL (Contacts)</label>
                <code id="carddavUrl">CARDDAV_URL</code>
            </div>
            <button class="copy-btn" onclick="copy('carddavUrl')">Copy</button>
        </div>

        <div class="info">
            <strong>Next steps:</strong> Add these URLs to your calendar/contacts app
            (Thunderbird, Apple Calendar, GNOME Calendar, etc.).
            Use your SilentSuite email and password when prompted.<br><br>
            <strong>Username:</strong> USER_EMAIL<br>
            <strong>Password:</strong> Your SilentSuite password<br><br>
            You can close this tab. The bridge is running in the background.
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


class AuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for the browser auth flow."""

    server_instance = None

    def log_message(self, format, *args):
        logger.debug("Auth server: %s", format % args)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/auth"):
            html = AUTH_PAGE_HTML.replace("SERVER_URL", config.ETEBASE_SERVER_URL)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())
        elif self.path.startswith("/success"):
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            email = params.get("email", [""])[0]
            base_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}"
            caldav_url = f"{base_url}/{email}/"
            carddav_url = f"{base_url}/{email}/"

            html = SUCCESS_PAGE_HTML
            html = html.replace("USER_EMAIL", email)
            html = html.replace("CALDAV_URL", caldav_url)
            html = html.replace("CARDDAV_URL", carddav_url)

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())

            # Signal auth complete after a short delay to ensure page renders
            threading.Timer(1.0, self._signal_complete).start()
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/auth":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode()
            params = urllib.parse.parse_qs(body)
            email = params.get("email", [""])[0]
            password = params.get("password", [""])[0]

            if not email or not password:
                self._json_response(400, {
                    "success": False,
                    "error": "Email and password are required.",
                })
                return

            # Authenticate with Etebase
            try:
                client = Client("silentsuite-bridge", config.ETEBASE_SERVER_URL)
                etebase = Account.login(client, email, password)
            except Exception as e:
                error_msg = str(e)
                if "401" in error_msg or "Unauthorized" in error_msg:
                    error_msg = "Invalid email or password."
                elif "404" in error_msg:
                    error_msg = "Account not found."
                else:
                    error_msg = f"Authentication failed: {error_msg}"

                logger.warning("Auth failed for %s: %s", email, error_msg)
                self._json_response(401, {
                    "success": False,
                    "error": error_msg,
                })
                return

            # Store credentials
            creds = Credentials()
            creds.set_etebase(
                email,
                etebase.save(None),
                config.ETEBASE_SERVER_URL,
            )

            password_hash = hashlib.sha256(password.encode()).hexdigest()
            creds.set_password_hash(email, password_hash)
            creds.save()

            logger.info("Authentication successful for %s", email)

            # Store the email for the success handler
            self.server.authenticated_email = email

            redirect_url = f"/success?email={urllib.parse.quote(email)}"
            self._json_response(200, {
                "success": True,
                "redirect": redirect_url,
            })
        else:
            self.send_error(404)

    def _json_response(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _signal_complete(self):
        if hasattr(self.server, "auth_complete"):
            self.server.auth_complete.set()


def _find_free_port():
    """Find a random free port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def browser_login():
    """Run the browser-based login flow.

    Starts a temporary HTTP server, opens the browser to the login page,
    and waits for the user to authenticate.

    Returns the authenticated email, or None if cancelled.
    """
    config.ensure_data_dir()

    port = _find_free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), AuthCallbackHandler)
    server.auth_complete = threading.Event()
    server.authenticated_email = None

    auth_url = f"http://127.0.0.1:{port}/"

    logger.info("Starting auth server on port %d", port)
    print(f"\nOpening browser for authentication...")
    print(f"If the browser doesn't open, visit: {auth_url}\n")

    # Start server in background thread
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    # Open browser
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass  # Browser might not be available (headless), URL is printed

    # Wait for auth to complete (or timeout after 5 minutes)
    try:
        completed = server.auth_complete.wait(timeout=300)
        if not completed:
            logger.warning("Auth timed out after 5 minutes")
            print("Authentication timed out. Please try again.")
            return None
    except KeyboardInterrupt:
        print("\nAuthentication cancelled.")
        return None
    finally:
        server.shutdown()

    email = server.authenticated_email
    if email:
        print(f"Authenticated as {email}")
        print(f"CalDAV/CardDAV URL: http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}/{email}/")
        print(f"\nStart the bridge with: silentsuite-bridge\n")

    return email
