#!/usr/bin/env python3
"""Tiny local API that queues dashboard updates for the root path unit."""

from __future__ import annotations

import contextlib
import json
import os
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

HOST = os.environ.get("OWNTONE_UPDATE_HOST", "127.0.0.1")
PORT = int(os.environ.get("OWNTONE_UPDATE_PORT", "3692"))
TARGET = Path(os.environ.get("OWNTONE_DASHBOARD_TARGET", "/opt/owntone-dashboard"))
STATE_DIR = Path(os.environ.get("OWNTONE_DASHBOARD_STATE", "/var/lib/owntone-dashboard"))
REQUEST_FILE = STATE_DIR / "update.request"
RUNNING_FILE = STATE_DIR / "update-running.json"
RESULT_FILE = STATE_DIR / "update-result.json"
CHECK_FILE = STATE_DIR / "update-check.json"
LATEST_MAIN_URL = os.environ.get(
    "OWNTONE_UPDATE_LATEST_URL",
    "https://api.github.com/repos/vladimirperovic/owntunedashboard/commits/main",
)
CHECK_INTERVAL_SECONDS = int(os.environ.get("OWNTONE_UPDATE_CHECK_SECONDS", str(12 * 60 * 60)))


def now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    path.chmod(0o644)


def same_commit(left: str, right: str) -> bool:
    left = str(left or "").strip()
    right = str(right or "").strip()
    if not left or not right:
        return False
    return left == right or (len(left) >= 7 and len(right) >= 7 and (left.startswith(right) or right.startswith(left)))


def status() -> dict:
    current = read_json(TARGET / "version.json", {})
    return {
        "ok": True,
        "current": current if isinstance(current, dict) else {},
        "pending": REQUEST_FILE.exists(),
        "running": RUNNING_FILE.exists(),
        "result": read_json(RESULT_FILE, None),
    }


def fetch_latest_main() -> dict:
    request = Request(
        LATEST_MAIN_URL,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "OwnToneDashboardUpdater/1.1",
        },
    )
    with urlopen(request, timeout=15) as response:
        payload = json.load(response)
    commit = str(payload.get("sha", "")).strip()
    if len(commit) < 7:
        raise ValueError("GitHub main did not return a valid commit")
    return {"commit": commit, "checked_at": now().isoformat()}


def cached_latest_is_fresh(value) -> bool:
    if not isinstance(value, dict) or not value.get("commit") or not value.get("checked_at"):
        return False
    try:
        checked = datetime.fromisoformat(str(value["checked_at"]))
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return now() - checked.astimezone() < timedelta(seconds=max(60, CHECK_INTERVAL_SECONDS))


def check_latest(*, force: bool = False) -> dict:
    latest = read_json(CHECK_FILE, None)
    if force or not cached_latest_is_fresh(latest):
        latest = fetch_latest_main()
        write_json(CHECK_FILE, latest)

    current = read_json(TARGET / "version.json", {})
    current = current if isinstance(current, dict) else {}
    current_commit = str(current.get("commit", ""))
    latest_commit = str(latest.get("commit", ""))
    return {
        "ok": True,
        "current": current,
        "latest": latest,
        "update_available": bool(current_commit and latest_commit and not same_commit(current_commit, latest_commit)),
        "check_interval_seconds": CHECK_INTERVAL_SECONDS,
    }


def request_update() -> dict:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if REQUEST_FILE.exists() or RUNNING_FILE.exists():
        return {"ok": True, "queued": True, "already_running": True}
    payload = {
        "requested_at": now().isoformat(),
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
    server_version = "OwnToneDashboardUpdaterAPI/1.1"
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
        parsed = urlparse(self.path)
        if parsed.path in ("/status", "/health", "/"):
            self.send_json(200, status())
            return
        if parsed.path == "/check":
            force = parse_qs(parsed.query).get("force", ["0"])[0] == "1"
            try:
                self.send_json(200, check_latest(force=force))
            except Exception as exc:
                self.send_json(503, {"error": f"Update check failed: {exc}"})
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
