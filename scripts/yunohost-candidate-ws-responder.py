#!/usr/bin/env python3
"""Disposable WebSocket handshake responder for the YunoHost candidate CI (stdlib only).

Usage: yunohost-candidate-ws-responder.py PORT. Listens on 127.0.0.1:PORT until killed and
answers each handshake with 101, the computed Sec-WebSocket-Accept and X-CI-Responder: PORT.
"""

import base64
import hashlib
import socket
import sys

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(8)
    while True:
        connection, _ = server.accept()
        with connection:
            try:
                connection.settimeout(10)
                request = b""
                while b"\r\n\r\n" not in request and len(request) < 16384:
                    chunk = connection.recv(4096)
                    if not chunk:
                        break
                    request += chunk
                key = b""
                for line in request.split(b"\r\n")[1:]:
                    name, _, value = line.partition(b":")
                    if name.strip().lower() == b"sec-websocket-key":
                        key = value.strip()
                accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
                connection.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                                   b"Sec-WebSocket-Accept: " + accept + b"\r\nX-CI-Responder: " + str(port).encode() + b"\r\n\r\n")
            except OSError:
                pass  # a stalled or dropped client must not stop the responder
