#!/usr/bin/env python3
"""CI-only logging canary using the already-loaded native candidate images."""

import argparse
import http.client
from pathlib import Path
import re
import secrets
import subprocess
import time

SAFE_WARNING = "privacy fixture warning retained"
ASGI_FIXTURE = '''
import logging

async def app(scope, receive, send):
    if scope["type"] == "http":
        if scope["path"] == "/api/diagnostic":
            logging.getLogger("uvicorn.error").warning("privacy fixture warning retained")
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ready"})
        return
    assert scope["type"] == "websocket"
    assert (await receive())["type"] == "websocket.connect"
    if "/reject/" in scope["path"]:
        await send({"type": "websocket.close", "code": 1008})
        return
    await send({"type": "websocket.accept"})
    await send({"type": "websocket.close", "code": 1000})
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*arguments, check=True):
    result = subprocess.run(
        ["docker", *arguments], capture_output=True, text=True, timeout=40,
        check=False,
    )
    require(not check or result.returncode == 0, "privacy fixture Docker operation failed")
    return result.stdout + result.stderr


def port(container, internal):
    value = docker("port", container, f"{internal}/tcp").strip()
    require(re.fullmatch(r"127\.0\.0\.1:[0-9]+", value), "fixture port is not loopback-only")
    return int(value.rsplit(":", 1)[1])


def request(listener, path, websocket=False):
    headers = {}
    if websocket:
        headers = {
            "Connection": "Upgrade",
            "Upgrade": "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
        }
    connection = http.client.HTTPConnection("127.0.0.1", listener, timeout=5)
    try:
        connection.request("GET", path, headers=headers)
        return connection.getresponse().status
    finally:
        connection.close()


def wait_ready(listener):
    for _ in range(60):
        try:
            if request(listener, "/api/ready") == 200:
                return
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.2)
    raise RuntimeError("privacy fixture did not become ready")


def configured_level(startup):
    code = "\n".join(line for line in startup.splitlines() if not line.lstrip().startswith("#"))
    require("--no-access-log" in code, "packaged HTTP access logging must remain disabled")
    match = re.search(r"--log-level\s+([a-z]+)\b", code)
    return match.group(1) if match else "info"


def check_logs(baseline, backend, proxy, markers):
    require(SAFE_WARNING in backend, "safe Uvicorn warning was lost")
    if baseline:
        require(all(marker in backend for marker in markers[:2]), "WebSocket baseline witness missing")
        require(markers[2] in proxy, "proxy-error baseline witness missing")
    else:
        require(
            all(marker not in backend + proxy for marker in markers),
            "request canary entered packaged container logs",
        )


def exercise(args, baseline):
    directory = args.work_dir / ("baseline" if baseline else "packaged")
    directory.mkdir(mode=0o755)
    fixture = directory / "fixture.py"
    fixture.write_text(ASGI_FIXTURE, encoding="utf-8")
    fixture.chmod(0o644)
    config_dir = directory / "nginx"
    config_dir.mkdir(mode=0o755)
    config = args.router_config.read_text(encoding="utf-8")
    if baseline:
        config = config.replace("    error_log /dev/null;\n", "")
    # Bound the intentional upstream outage without changing routing.
    config = config.replace("proxy_read_timeout 3600s;", "proxy_read_timeout 1s;")
    config = config.replace("proxy_send_timeout 3600s;", "proxy_send_timeout 1s;")
    config = config.replace("    client_max_body_size 64m;", "    proxy_connect_timeout 1s;\n    client_max_body_size 64m;")
    config_file = config_dir / "default.conf"
    config_file.write_text(config, encoding="utf-8")
    config_file.chmod(0o644)
    level = "info" if baseline else configured_level(args.startup.read_text(encoding="utf-8"))
    prefix = "silentsuite-privacy-" + secrets.token_hex(6)
    network, backend, proxy = prefix + "-net", prefix + "-server", prefix + "-router"
    marker = "privacy-canary-" + secrets.token_hex(16)
    markers = [marker + suffix for suffix in ("-accept", "-reject", "-failure")]
    created_network = False
    try:
        docker("network", "create", network)
        created_network = True
        docker(
            "run", "-d", "--pull=never", "--name", backend, "--network", network,
            "--network-alias", "silentsuite_server_1",
            "--network-alias", "silentsuite_web_1",
            "-p", "127.0.0.1::3735", "-v", f"{directory}:/privacy:ro",
            "--entrypoint", "uvicorn", args.server_image, "fixture:app",
            "--app-dir", "/privacy", "--host", "0.0.0.0", "--port", "3735",
            "--lifespan", "off", "--no-access-log", "--log-level", level,
        )
        wait_ready(port(backend, 3735))
        docker(
            "run", "-d", "--pull=never", "--name", proxy, "--network", network,
            "-p", "127.0.0.1::8080", "-v", f"{config_dir}:/etc/nginx/conf.d:ro",
            "--entrypoint", "nginx", args.router_image, "-g", "daemon off;",
        )
        listener = port(proxy, 8080)
        wait_ready(listener)
        require(request(listener, f"/api/v1/ws/accept/{markers[0]}/", True) == 101, "WebSocket acceptance branch failed")
        require(request(listener, f"/api/v1/ws/reject/{markers[1]}/", True) == 403, "WebSocket rejection branch failed")
        require(request(listener, "/api/diagnostic") == 200, "safe diagnostic branch failed")
        docker("stop", "--time", "2", backend)
        failure = request(listener, f"/api/v1/ws/{markers[2]}/", True)
        require(failure in (502, 504), "proxy upstream failure branch was not reached")
        docker("stop", "--time", "2", proxy)
        check_logs(baseline, docker("logs", backend), docker("logs", proxy), markers)
        print("PASS logging baseline witness" if baseline else f"PASS packaged WebSocket privacy and proxy failure (HTTP {failure})")
    finally:
        docker("rm", "-f", proxy, backend, check=False)
        if created_network:
            docker("network", "rm", network, check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-image", required=True)
    parser.add_argument("--router-image", required=True)
    parser.add_argument("--startup", required=True, type=Path)
    parser.add_argument("--router-config", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args()
    require(
        all(re.fullmatch(r"sha256:[0-9a-f]{64}", image) for image in (args.server_image, args.router_image)),
        "privacy fixture requires the already-inspected image IDs",
    )
    args.work_dir.mkdir(mode=0o755)
    exercise(args, baseline=True)
    exercise(args, baseline=False)


if __name__ == "__main__":
    main()
