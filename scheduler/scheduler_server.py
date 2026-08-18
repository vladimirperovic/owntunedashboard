#!/usr/bin/env python3
"""Tiny persistent scheduler API for OwnTone Dashboard.

No third-party Python packages are required. The service stores schedules in
/var/lib/owntone-dashboard/schedules.json and talks to OwnTone on localhost.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

HOST = os.environ.get("OWNTONE_SCHEDULER_HOST", "127.0.0.1")
PORT = int(os.environ.get("OWNTONE_SCHEDULER_PORT", "3691"))
OWNTONE_BASE = os.environ.get("OWNTONE_BASE", "http://127.0.0.1:3689/api").rstrip("/")
DATA_DIR = Path(os.environ.get("OWNTONE_SCHEDULER_DATA", "/var/lib/owntone-dashboard"))
SCHEDULES_FILE = DATA_DIR / "schedules.json"
STATE_FILE = DATA_DIR / "scheduler-state.json"
LOCK = threading.RLock()
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def _read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def _atomic_write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def load_schedules():
    with LOCK:
        data = _read_json(SCHEDULES_FILE, [])
        return data if isinstance(data, list) else []


def save_schedules(items) -> None:
    with LOCK:
        _atomic_write(SCHEDULES_FILE, items)


def load_runtime_state():
    with LOCK:
        data = _read_json(STATE_FILE, {"runs": {}, "stops": {}, "last_error": None})
        return data if isinstance(data, dict) else {"runs": {}, "stops": {}, "last_error": None}


def save_runtime_state(state) -> None:
    with LOCK:
        _atomic_write(STATE_FILE, state)


def clean_schedule(raw: dict, existing_id: str | None = None) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Schedule must be an object")

    schedule_id = existing_id or str(raw.get("id") or uuid.uuid4())
    time_value = str(raw.get("time") or "09:00")
    if not TIME_RE.match(time_value):
        raise ValueError("Invalid time; expected HH:MM")

    stop_time = str(raw.get("stop_time") or "").strip()
    if stop_time and not TIME_RE.match(stop_time):
        raise ValueError("Invalid stop_time; expected HH:MM")

    days = raw.get("days") or []
    if not isinstance(days, list):
        raise ValueError("days must be an array")
    days = [day for day in DAYS if day in {str(x).lower() for x in days}]
    if not days:
        raise ValueError("Select at least one day")

    kind = str(raw.get("kind") or "playlist").lower()
    if kind not in ("playlist", "radio"):
        raise ValueError("kind must be playlist or radio")

    source_uri = str(raw.get("source_uri") or "").strip()
    source_name = str(raw.get("source_name") or "").strip()
    if not source_uri or not source_name:
        raise ValueError("source_uri and source_name are required")

    output_id = str(raw.get("output_id") or "").strip()
    output_name = str(raw.get("output_name") or "").strip()
    if not output_id:
        raise ValueError("output_id is required")

    try:
        volume = max(0, min(100, int(raw.get("volume", 10))))
    except (TypeError, ValueError):
        raise ValueError("volume must be 0-100")

    name = str(raw.get("name") or "").strip() or f"{source_name} · {time_value}"
    return {
        "id": schedule_id,
        "name": name[:120],
        "enabled": bool(raw.get("enabled", True)),
        "time": time_value,
        "days": days,
        "kind": kind,
        "source_name": source_name[:160],
        "source_uri": source_uri,
        "output_id": output_id,
        "output_name": output_name[:160] or output_id,
        "volume": volume,
        "shuffle": bool(raw.get("shuffle", kind == "playlist")),
        "stop_time": stop_time,
    }


def owntone_request(path: str, method: str = "GET", body=None, timeout: int = 8):
    url = f"{OWNTONE_BASE}{path if path.startswith('/') else '/' + path}"
    payload = None
    headers = {"Accept": "application/json"}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=payload, headers=headers, method=method)
    with urlopen(req, timeout=timeout) as response:
        raw = response.read()
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return raw.decode("utf-8", errors="replace")


def execute_schedule(item: dict) -> dict:
    output_id = str(item["output_id"])
    owntone_request("/outputs/set", "PUT", {"outputs": [output_id]})
    volume_query = urlencode({"volume": int(item["volume"]), "output_id": output_id})
    owntone_request(f"/player/volume?{volume_query}", "PUT")
    play_query = urlencode({
        "uris": item["source_uri"],
        "clear": "true",
        "playback": "start",
        "shuffle": "true" if item.get("shuffle") else "false",
    })
    owntone_request(f"/queue/items/add?{play_query}", "POST")
    return {"ok": True, "message": f"Playing {item['source_name']} on {item['output_name']}"}


def stop_playback(item: dict) -> dict:
    output_id = str(item.get("output_id") or "")
    if output_id:
        # Keep the intended output selected so stop cannot accidentally affect an unrelated stale selection.
        owntone_request("/outputs/set", "PUT", {"outputs": [output_id]})
    owntone_request("/player/stop", "PUT")
    return {"ok": True, "message": f"Stopped {item['name']}"}


def find_schedule(schedule_id: str):
    items = load_schedules()
    for index, item in enumerate(items):
        if str(item.get("id")) == schedule_id:
            return items, index, item
    return items, -1, None


def next_run(item: dict, now: datetime | None = None):
    if not item.get("enabled"):
        return None
    now = now or datetime.now().astimezone()
    hour, minute = [int(x) for x in item["time"].split(":", 1)]
    for add_days in range(0, 8):
        day = now + timedelta(days=add_days)
        if DAYS[day.weekday()] not in item.get("days", []):
            continue
        candidate = day.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate >= now:
            return candidate
    return None


def scheduler_loop():
    while True:
        try:
            now = datetime.now().astimezone()
            minute_key = now.strftime("%Y-%m-%dT%H:%M")
            day_key = DAYS[now.weekday()]
            hhmm = now.strftime("%H:%M")
            schedules = load_schedules()
            runtime = load_runtime_state()
            runs = runtime.setdefault("runs", {})
            stops = runtime.setdefault("stops", {})
            dirty = False

            for item in schedules:
                if not item.get("enabled") or day_key not in item.get("days", []):
                    continue
                schedule_id = str(item.get("id"))
                if item.get("time") == hhmm and runs.get(schedule_id) != minute_key:
                    try:
                        execute_schedule(item)
                        runs[schedule_id] = minute_key
                        runtime["last_error"] = None
                    except Exception as exc:  # scheduler must never die on an OwnTone failure
                        runs[schedule_id] = minute_key
                        runtime["last_error"] = {
                            "at": datetime.now().astimezone().isoformat(),
                            "schedule": schedule_id,
                            "message": str(exc),
                        }
                    dirty = True

                stop_time = item.get("stop_time") or ""
                if stop_time == hhmm and stops.get(schedule_id) != minute_key:
                    try:
                        stop_playback(item)
                        stops[schedule_id] = minute_key
                        runtime["last_error"] = None
                    except Exception as exc:
                        stops[schedule_id] = minute_key
                        runtime["last_error"] = {
                            "at": datetime.now().astimezone().isoformat(),
                            "schedule": schedule_id,
                            "message": str(exc),
                        }
                    dirty = True

            if dirty:
                save_runtime_state(runtime)
        except Exception as exc:
            state = load_runtime_state()
            state["last_error"] = {"at": datetime.now().astimezone().isoformat(), "message": str(exc)}
            save_runtime_state(state)
        time.sleep(15)


class Handler(BaseHTTPRequestHandler):
    server_version = "OwnToneDashboardScheduler/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def _send(self, status: int, value=None):
        payload = b"" if value is None else json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 256 * 1024:
            raise ValueError("Request body too large")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _id_from_path(self):
        parts = [x for x in urlparse(self.path).path.split("/") if x]
        if len(parts) >= 2 and parts[0] == "schedules":
            return parts[1]
        return None

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            state = load_runtime_state()
            self._send(200, {
                "ok": True,
                "service": "owntone-dashboard-scheduler",
                "time": datetime.now().astimezone().isoformat(),
                "timezone": str(datetime.now().astimezone().tzinfo),
                "owntone": OWNTONE_BASE,
                "last_error": state.get("last_error"),
            })
            return
        if path == "/schedules":
            now = datetime.now().astimezone()
            items = []
            for item in load_schedules():
                enriched = dict(item)
                nxt = next_run(item, now)
                enriched["next_run"] = nxt.isoformat() if nxt else None
                items.append(enriched)
            self._send(200, {"items": items, "time": now.isoformat()})
            return
        self._send(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/schedules":
                item = clean_schedule(self._body())
                items = load_schedules()
                items.append(item)
                save_schedules(items)
                self._send(201, item)
                return

            if path.endswith("/run"):
                schedule_id = self._id_from_path()
                _, _, item = find_schedule(schedule_id or "")
                if not item:
                    self._send(404, {"error": "Schedule not found"})
                    return
                result = execute_schedule(item)
                self._send(200, result)
                return
        except Exception as exc:
            self._send(400, {"error": str(exc)})
            return
        self._send(404, {"error": "Not found"})

    def do_PUT(self):
        schedule_id = self._id_from_path()
        if not schedule_id:
            self._send(404, {"error": "Not found"})
            return
        try:
            items, index, old = find_schedule(schedule_id)
            if not old:
                self._send(404, {"error": "Schedule not found"})
                return
            merged = dict(old)
            merged.update(self._body())
            items[index] = clean_schedule(merged, existing_id=schedule_id)
            save_schedules(items)
            self._send(200, items[index])
        except Exception as exc:
            self._send(400, {"error": str(exc)})

    def do_DELETE(self):
        schedule_id = self._id_from_path()
        if not schedule_id:
            self._send(404, {"error": "Not found"})
            return
        items, index, item = find_schedule(schedule_id)
        if not item:
            self._send(404, {"error": "Schedule not found"})
            return
        del items[index]
        save_schedules(items)
        self._send(200, {"ok": True})


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SCHEDULES_FILE.exists():
        _atomic_write(SCHEDULES_FILE, [])
    thread = threading.Thread(target=scheduler_loop, name="scheduler", daemon=True)
    thread.start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"OwnTone dashboard scheduler listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
