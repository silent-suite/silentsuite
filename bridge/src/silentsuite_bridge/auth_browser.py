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
import html as html_mod
import http.server
import json
import logging
import os
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
        input[type="email"], input[type="password"], input[type="url"] {
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

            <details style="margin-bottom:16px;">
                <summary style="cursor:pointer;font-size:13px;color:#888;list-style:none;display:flex;align-items:center;gap:6px;">
                    <span style="font-size:10px;color:#666;">&#9654;</span> Advanced
                </summary>
                <div style="margin-top:10px;">
                    <label for="server_url">Server URL</label>
                    <input type="url" id="server_url" name="server_url"
                           value="SERVER_URL"
                           placeholder="https://server.silentsuite.io">
                </div>
            </details>

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
            padding: 40px 20px;
        }
        .container { max-width: 680px; margin: 0 auto; }
        .hero {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 40px;
            text-align: center;
            margin-bottom: 20px;
        }
        .check { font-size: 48px; margin-bottom: 16px; }
        h1 { font-size: 24px; margin-bottom: 8px; color: #4ade80; }
        .subtitle { color: #888; margin-bottom: 16px; font-size: 14px; }
        .url-box {
            background: #111;
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            padding: 12px 14px;
            margin: 12px 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            text-align: left;
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
            flex-shrink: 0;
        }
        .copy-btn:hover { background: #444; }
        .url-note {
            color: #666;
            font-size: 12px;
            margin-top: 8px;
            font-style: italic;
        }
        .bookmark-box {
            background: #0a2a1a;
            border: 1px solid #166534;
            border-radius: 8px;
            padding: 14px 16px;
            margin: 16px 0;
            font-size: 14px;
            color: #4ade80;
            text-align: left;
        }
        .bookmark-box a {
            color: #fff;
            text-decoration: underline;
        }
        .next-step {
            background: #111;
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            padding: 14px 16px;
            margin-top: 16px;
            font-size: 13px;
            color: #aaa;
            text-align: left;
        }
        .next-step strong { color: #ccc; }
        .next-step code {
            background: #0a0a0a;
            padding: 2px 6px;
            border-radius: 4px;
            color: #4ade80;
            font-size: 12px;
        }

        .card {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
        }
        .card h2 {
            font-size: 16px;
            color: #fff;
            margin-bottom: 16px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        details {
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            margin-bottom: 8px;
            overflow: hidden;
        }
        summary {
            padding: 12px 16px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            color: #ccc;
            background: #111;
            list-style: none;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        summary::-webkit-details-marker { display: none; }
        summary::before {
            content: "\\25B6";
            font-size: 10px;
            color: #666;
            transition: transform 0.2s;
        }
        details[open] summary::before { transform: rotate(90deg); }
        summary:hover { background: #1a1a1a; }
        .guide-content {
            padding: 16px;
            font-size: 13px;
            line-height: 1.7;
            color: #aaa;
            border-top: 1px solid #2a2a2a;
        }
        .guide-content ol {
            padding-left: 20px;
            margin: 8px 0;
        }
        .guide-content li { margin-bottom: 6px; }
        .guide-content code {
            background: #0a0a0a;
            padding: 2px 6px;
            border-radius: 4px;
            color: #4ade80;
            font-size: 12px;
        }
        .guide-content strong { color: #ccc; }
        .guide-content .doc-link {
            display: inline-block;
            margin-top: 10px;
            color: #4ade80;
            text-decoration: none;
            font-size: 12px;
        }
        .guide-content .doc-link:hover { text-decoration: underline; }

        .docs-link {
            text-align: center;
            padding: 16px;
            font-size: 13px;
            color: #888;
        }
        .docs-link a { color: #4ade80; text-decoration: none; }
        .docs-link a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="container">
        <div class="hero">
            <div class="check">&#10003;</div>
            <h1>Login successful</h1>
            <p class="subtitle">Signed in as <strong>USER_EMAIL</strong></p>
            <div class="url-box">
                <div>
                    <label>CalDAV / CardDAV URL</label>
                    <code id="bridgeUrl">BRIDGE_URL</code>
                </div>
                <button class="copy-btn" onclick="copyUrl(event, 'bridgeUrl')">Copy</button>
            </div>
            <p class="url-note">CalDAV and CardDAV share the same base URL &mdash; this is normal. Your app will discover calendars and contacts automatically.</p>
            <div class="bookmark-box">
                &#11088; Bookmark <a href="DASHBOARD_URL">DASHBOARD_URL</a> to find these details later
            </div>
            <div class="next-step">
                You're signed in. You can close this tab &mdash; the bridge is already running in the background and will keep syncing on its own.
            </div>
        </div>

        <div class="card">
            <h2>Connect Your Apps</h2>

            <details>
                <summary>Outlook (CalDav Synchronizer)</summary>
                <div class="guide-content">
                    <ol>
                        <li>Download and install the free <strong><a href="https://caldavsynchronizer.org/" target="_blank" rel="noopener" style="color:#4ade80;">CalDav Synchronizer</a></strong> plugin for Outlook.</li>
                        <li>Restart Outlook after installation.</li>
                        <li>Go to the <strong>CalDav Synchronizer</strong> tab in the ribbon and click <strong>Synchronization Profiles</strong>.</li>
                        <li>Click the <strong>+</strong> (Add) button to create a new profile.</li>
                        <li>Select <strong>Generic CalDAV/CardDAV</strong> as the profile type.</li>
                        <li>Set the <strong>DAV URL</strong> to: <code>BRIDGE_URL</code></li>
                        <li>Enter your <strong>SilentSuite email</strong> as the username and your <strong>SilentSuite password</strong>.</li>
                        <li>Choose the Outlook folder to sync with (e.g. your default Calendar).</li>
                        <li>Click <strong>Test or discover settings</strong> to verify the connection.</li>
                        <li>Click <strong>OK</strong> to save. For contacts, create a second profile with the same URL and select your Contacts folder.</li>
                    </ol>
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/windows" target="_blank" rel="noopener">Full Outlook guide &#8594;</a>
                </div>
            </details>

            <details>
                <summary>Thunderbird</summary>
                <div class="guide-content">
                    <ol>
                        <li>Open <strong>Thunderbird</strong> and switch to the <strong>Calendar</strong> tab (or press <code>Ctrl+Shift+C</code>).</li>
                        <li>Right-click in the calendar list on the left and select <strong>New Calendar...</strong></li>
                        <li>Choose <strong>On the Network</strong> and click <strong>Next</strong>.</li>
                        <li>Select <strong>CalDAV</strong> format and enter the URL: <code>BRIDGE_URL</code></li>
                        <li>When prompted, enter your <strong>SilentSuite email</strong> and <strong>password</strong>.</li>
                        <li>Thunderbird will discover your calendars. Select the ones you want and click <strong>Subscribe</strong>.</li>
                        <li>For contacts: open the <strong>Address Book</strong>, click <strong>New Address Book</strong> &gt; <strong>Add CardDAV Address Book</strong>.</li>
                        <li>Enter the same URL: <code>BRIDGE_URL</code> and your credentials.</li>
                    </ol>
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/thunderbird" target="_blank" rel="noopener">Full Thunderbird guide &#8594;</a>
                </div>
            </details>

            <details>
                <summary>Apple Calendar &amp; Contacts (macOS + iOS)</summary>
                <div class="guide-content">
                    <strong>macOS:</strong>
                    <ol>
                        <li>Open <strong>System Settings</strong> (or System Preferences on older macOS) and go to <strong>Internet Accounts</strong>.</li>
                        <li>Click <strong>Add Other Account...</strong> then select <strong>CalDAV Account</strong>.</li>
                        <li>Set the Account Type to <strong>Manual</strong>.</li>
                        <li>Enter your <strong>SilentSuite email</strong> as the username, your <strong>password</strong>, and the server address: <code>BRIDGE_URL</code></li>
                        <li>Click <strong>Sign In</strong>. macOS Calendar will discover your calendars automatically.</li>
                        <li>To add contacts: repeat steps 1-2 but choose <strong>CardDAV Account</strong> and enter the same server URL and credentials.</li>
                    </ol>
                    <strong>iOS / iPadOS:</strong>
                    <ol>
                        <li>Go to <strong>Settings &gt; Calendar &gt; Accounts &gt; Add Account &gt; Other</strong>.</li>
                        <li>Tap <strong>Add CalDAV Account</strong>.</li>
                        <li>Enter the server URL: <code>BRIDGE_URL</code>, your SilentSuite email, and password.</li>
                        <li>Tap <strong>Next</strong> to verify and save.</li>
                        <li>For contacts: go back to <strong>Other</strong> and tap <strong>Add CardDAV Account</strong> with the same details.</li>
                    </ol>
                    <p><em>Note: Your iOS device needs network access to your bridge host (e.g. via Tailscale or LAN).</em></p>
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/macos" target="_blank" rel="noopener">Full macOS guide &#8594;</a>
                    &nbsp;
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/ios" target="_blank" rel="noopener">Full iOS guide &#8594;</a>
                </div>
            </details>

            <details>
                <summary>GNOME Calendar &amp; Contacts</summary>
                <div class="guide-content">
                    <ol>
                        <li>Open <strong>GNOME Settings</strong> and go to <strong>Online Accounts</strong>.</li>
                        <li>Click <strong>Other</strong> (on GNOME 46+ you may see a dedicated <strong>CalDAV / CardDAV</strong> option).</li>
                        <li>Select <strong>CalDAV</strong> or <strong>GNOME Online Account (WebDAV)</strong>.</li>
                        <li>Enter the URL: <code>BRIDGE_URL</code></li>
                        <li>Enter your <strong>SilentSuite email</strong> as the username and your <strong>password</strong>.</li>
                        <li>Toggle on <strong>Calendar</strong> and <strong>Contacts</strong>.</li>
                        <li>GNOME Calendar and GNOME Contacts will both discover your data automatically.</li>
                    </ol>
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/gnome" target="_blank" rel="noopener">Full GNOME guide &#8594;</a>
                </div>
            </details>

            <details>
                <summary>DAVx&#8309; (Android)</summary>
                <div class="guide-content">
                    <ol>
                        <li>Install <strong>DAVx&#8309;</strong> from <a href="https://f-droid.org/packages/at.bitfire.davdroid/" target="_blank" rel="noopener" style="color:#4ade80;">F-Droid</a> or <a href="https://play.google.com/store/apps/details?id=at.bitfire.davdroid" target="_blank" rel="noopener" style="color:#4ade80;">Google Play</a>.</li>
                        <li>Open DAVx&#8309; and tap the <strong>+</strong> button to add a new account.</li>
                        <li>Select <strong>Login with URL and user name</strong>.</li>
                        <li>Enter the base URL: <code>BRIDGE_URL</code></li>
                        <li>Enter your <strong>SilentSuite email</strong> as the user name and your <strong>password</strong>.</li>
                        <li>Tap <strong>Login</strong>. DAVx&#8309; will discover your calendars, tasks, and address books.</li>
                        <li>Select the collections you want to sync and tap the sync icon.</li>
                        <li>Your data will now appear in your Android Calendar, Contacts, and Tasks apps.</li>
                    </ol>
                    <p><em>Note: Your Android device needs network access to your bridge host (e.g. via Tailscale or LAN).</em></p>
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/android" target="_blank" rel="noopener">Full Android guide &#8594;</a>
                </div>
            </details>

            <details>
                <summary>Evolution</summary>
                <div class="guide-content">
                    <ol>
                        <li>Open <strong>Evolution</strong> and go to <strong>Edit &gt; Accounts</strong> (or <strong>File &gt; New &gt; Calendar</strong>).</li>
                        <li>Click <strong>Add</strong> and choose <strong>CalDAV</strong> as the type.</li>
                        <li>Enter the URL: <code>BRIDGE_URL</code></li>
                        <li>Enter your <strong>SilentSuite email</strong> and <strong>password</strong>.</li>
                        <li>Click <strong>Find Calendars</strong> to discover available collections, then select the ones you want.</li>
                        <li>For contacts: go to <strong>File &gt; New &gt; Address Book</strong>, choose <strong>CardDAV</strong>, and enter the same URL and credentials.</li>
                    </ol>
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/evolution" target="_blank" rel="noopener">Full Evolution guide &#8594;</a>
                </div>
            </details>

            <details>
                <summary>Other CalDAV/CardDAV App</summary>
                <div class="guide-content">
                    <p>Any app that supports the <strong>CalDAV</strong> or <strong>CardDAV</strong> protocol can connect to SilentSuite Bridge. You will need:</p>
                    <ol>
                        <li><strong>Server URL:</strong> <code>BRIDGE_URL</code></li>
                        <li><strong>Username:</strong> your SilentSuite email address (<code>USER_EMAIL</code>)</li>
                        <li><strong>Password:</strong> your SilentSuite password</li>
                    </ol>
                    <p style="margin-top:8px;">Most apps have an <strong>"Add CalDAV account"</strong>, <strong>"Add internet calendar"</strong>, or <strong>"Add WebDAV account"</strong> option in their settings. Enter the details above and the app will auto-discover your calendars, contacts, and tasks.</p>
                    <p style="margin-top:8px;"><em>If the app asks for separate CalDAV and CardDAV URLs, use the same URL for both &mdash; the bridge handles discovery automatically.</em></p>
                    <a class="doc-link" href="https://docs.silentsuite.io/user-guide/apps/dav-bridge" target="_blank" rel="noopener">Full documentation &#8594;</a>
                </div>
            </details>
        </div>

        <div class="docs-link">
            <a href="https://docs.silentsuite.io/user-guide/apps/dav-bridge" target="_blank" rel="noopener">Full documentation at docs.silentsuite.io &#8594;</a>
        </div>
    </div>
    <script>
        function copyUrl(event, id) {
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


class AuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for the browser auth flow."""

    server_instance = None

    def log_message(self, format, *args):
        logger.debug("Auth server: %s", format % args)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/auth"):
            html = AUTH_PAGE_HTML.replace("SERVER_URL", html_mod.escape(config.ETEBASE_SERVER_URL))
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())
        elif self.path.startswith("/success"):
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            email = params.get("email", [""])[0]
            dashboard_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}/.web/"
            bridge_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}/{email}/"

            page = SUCCESS_PAGE_HTML
            page = page.replace("USER_EMAIL", html_mod.escape(email))
            page = page.replace("BRIDGE_URL", html_mod.escape(bridge_url))
            page = page.replace("DASHBOARD_URL", html_mod.escape(dashboard_url))

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(page.encode())

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
            server_url = params.get("server_url", [config.ETEBASE_SERVER_URL])[0].strip()
            if not server_url:
                server_url = config.ETEBASE_SERVER_URL

            if not email or not password:
                self._json_response(400, {
                    "success": False,
                    "error": "Email and password are required.",
                })
                return

            # Authenticate with Etebase
            try:
                client = Client("silentsuite-bridge", server_url)
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

            # Update runtime config if a custom server URL was provided
            if server_url != config.ETEBASE_SERVER_URL:
                config.ETEBASE_SERVER_URL = server_url

            # Store credentials — clear any existing users first
            # (bridge supports one account at a time)
            creds = Credentials()
            for old_user in creds.list_users():
                creds.delete(old_user)
            creds.set_etebase(
                email,
                etebase.save(None),
                server_url,
            )

            salt = os.urandom(32)
            password_hash = hashlib.pbkdf2_hmac(
                "sha256", password.encode(), salt, 600000,
            ).hex()
            creds.set_password_salt(email, salt.hex())
            creds.set_password_hash(email, password_hash)
            creds.save()

            logger.info("Authentication successful for %s", email)

            # Store the email and server URL for the success handler
            self.server.authenticated_email = email
            self.server.authenticated_server_url = server_url

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
    server.authenticated_server_url = config.ETEBASE_SERVER_URL

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
        used_server = server.authenticated_server_url
        dashboard_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}/.web/"
        base_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}/{email}/"
        print(f"\n  Login successful! Now start the bridge daemon:")
        print(f"    ./silentsuite-bridge")
        print()
        print(f"  Etebase server: {used_server}")
        print(f"  Dashboard will be available at: {dashboard_url}")
        print(f"  CalDAV/CardDAV URL for your apps: {base_url}")
        print(f"\n  Full setup guides: https://docs.silentsuite.io/user-guide/apps/dav-bridge\n")

    return email
