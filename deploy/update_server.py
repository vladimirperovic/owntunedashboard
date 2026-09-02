#!/usr/bin/env python3
"""Tiny local API that queues dashboard updates for the root path unit."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOST = os.environ.get("OWNTONE_UPDATE_HOST", "127.0.0.1")
PORT = int(os.environ.get("OWNTONE_UPDATE_PORT", "3692"))
TARGET = Path(os.environ.get("OWNTONE_DASHBOARD_TARGET", "/opt/owntone-dashboard"))
STATE_DIR = Path(os.environ.get("OWNTONE_DASHBOARD_STATE", "/var/lib/owntone-dashboard"))
REQUEST_FILE = STATE_DIR / "update.request"
RUNNING_FILE = STATE_DIR / "update-running.json"
RESULT_FILE = STATE_DIR / "update-result.json"


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def status() -> dict:
    current = read_json(TARGET / "version.json", {})
    return {
        "ok": True,
        "current": current if isinstance(current, dict) else {},
        "pending": REQUEST_FILE.exists(),
        "running": RUNNING_FILE.exists(),
        "result": read_json(RESULT_FILE, None),
    }


def request_update() -> dict:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if REQUEST_FILE.exists() or RUNNING_FILE.exists():
        return {"ok": True, "queued": True, "already_running": True}
    payload = {
        "requested_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "source": "github-main",
    }
    fd = os.open(REQUEST_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.write("\n")
    except Exception:
        with contextlib.suppress(OSError):
            REQUEST_FILE.unlink()
        raise
    return {"ok": True, "queued": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "OwnToneDashboardUpdaterAPI/1.0"
    protocol_version = "HTTP/1.1"
    timeout = 10

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def send_json(self, code: int, value) -> None:
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if urlparse(self.path).path in ("/status", "/health", "/"):
            self.send_json(200, status())
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/request":
            self.send_json(404, {"error": "Not found"})
            return
        if self.headers.get("X-OwnTone-Update") != "1":
            self.send_json(403, {"error": "Update confirmation header required"})
            return
        try:
            self.send_json(202, request_update())
        except FileExistsError:
            self.send_json(202, {"ok": True, "queued": True, "already_running": True})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})


def main() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"OwnTone dashboard update API listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
