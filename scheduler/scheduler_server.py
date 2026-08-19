#!/usr/bin/env python3
"""Tiny persistent companion service for OwnTone Dashboard.

No third-party Python packages are required. Besides scheduled playback, this
service keeps a small now-playing history and performs server-side radio stream
health probes so browser CORS rules never get in the way.
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
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

HOST = os.environ.get("OWNTONE_SCHEDULER_HOST", "127.0.0.1")
PORT = int(os.environ.get("OWNTONE_SCHEDULER_PORT", "3691"))
OWNTONE_BASE = os.environ.get("OWNTONE_BASE", "http://127.0.0.1:3689/api").rstrip("/")
DATA_DIR = Path(os.environ.get("OWNTONE_SCHEDULER_DATA", "/var/lib/owntone-dashboard"))
SCHEDULES_FILE = DATA_DIR / "schedules.json"
STATE_FILE = DATA_DIR / "scheduler-state.json"
HISTORY_FILE = DATA_DIR / "history.json"
LOCK = threading.RLock()
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
HISTORY_LIMIT = 50
RADIO_HEALTH_TTL = 90
RADIO_MAP_TTL = 600
RADIO_HEALTH_CACHE: dict[str, dict] = {}
RADIO_MAP_CACHE = {"expires": 0.0, "by_path": {}}


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


def load_history():
    with LOCK:
        data = _read_json(HISTORY_FILE, [])
        return data if isinstance(data, list) else []


def save_history(items) -> None:
    with LOCK:
        _atomic_write(HISTORY_FILE, list(items)[:HISTORY_LIMIT])


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
        volume = max(0, min(100, int(raw.get("volume", 55))))
    except (TypeError, ValueError):
        raise ValueError("volume must be 0-100")

    try:
        ramp_minutes = max(0, min(1440, int(raw.get("ramp_minutes", 0))))
    except (TypeError, ValueError):
        raise ValueError("ramp_minutes must be 0-1440")

    try:
        ramp_volume = max(0, min(100, int(raw.get("ramp_volume", 0))))
    except (TypeError, ValueError):
        raise ValueError("ramp_volume must be 0-100")

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
        "ramp_minutes": ramp_minutes,
        "ramp_volume": ramp_volume,
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


def schedule_volume_bump(item: dict, runtime: dict) -> None:
    ramp_minutes = int(item.get("ramp_minutes") or 0)
    ramp_volume = int(item.get("ramp_volume") or 0)
    if ramp_minutes <= 0 or ramp_volume <= 0:
        return
    run_key = str((runtime.get("runs") or {}).get(str(item.get("id")), ""))
    if not run_key:
        return
    bumps = runtime.setdefault("bumps", {})
    if bumps.get(str(item.get("id"))) == run_key:
        return
    try:
        ran_at = datetime.strptime(run_key, "%Y-%m-%dT%H:%M").astimezone()
    except ValueError:
        return
    if datetime.now().astimezone() < ran_at + timedelta(minutes=ramp_minutes):
        return
    output_id = str(item.get("output_id") or "")
    volume_query = urlencode({"volume": ramp_volume, "output_id": output_id})
    owntone_request(f"/player/volume?{volume_query}", "PUT")
    bumps[str(item.get("id"))] = run_key


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


def _is_radio_playlist(item: dict) -> bool:
    path = str(item.get("path") or "").lower()
    name = str(item.get("name") or "").lower()
    return "/radio/" in path or "radio" in name or "naxi" in name or name in {"202", "s1"}


def _refresh_radio_map() -> dict:
    now = time.monotonic()
    with LOCK:
        if RADIO_MAP_CACHE["expires"] > now:
            return dict(RADIO_MAP_CACHE["by_path"])
    by_path = {}
    try:
        playlists = owntone_request("/library/playlists?limit=500") or {}
        for playlist in playlists.get("items", []):
            if playlist.get("folder") or not _is_radio_playlist(playlist):
                continue
            pid = playlist.get("id")
            if pid is None:
                continue
            try:
                tracks = owntone_request(f"/library/playlists/{pid}/tracks?limit=1", timeout=4) or {}
                track = (tracks.get("items") or [None])[0]
                stream = str((track or {}).get("path") or "")
                if stream.startswith(("http://", "https://")):
                    by_path[stream] = {
                        "name": playlist.get("name") or "Radio",
                        "uri": playlist.get("uri") or "",
                        "id": str(pid),
                    }
            except Exception:
                continue
    finally:
        with LOCK:
            RADIO_MAP_CACHE["by_path"] = by_path
            RADIO_MAP_CACHE["expires"] = time.monotonic() + RADIO_MAP_TTL
    return dict(by_path)


def _quality_from_track(track: dict, headers=None) -> str:
    kind = str(track.get("type") or "").upper()
    bitrate = str(track.get("bitrate") or "").strip()
    headers = headers or {}
    icy_br = str(headers.get("icy-br") or "").strip()
    content_type = str(headers.get("content-type") or "").lower()
    if not kind:
        if "flac" in content_type:
            kind = "FLAC"
        elif "aac" in content_type:
            kind = "AAC"
        elif "mpeg" in content_type or "mp3" in content_type:
            kind = "MP3"
    if kind in {"FLAC", "ALAC"}:
        return kind
    rate = bitrate or icy_br
    if rate:
        rate = re.sub(r"[^0-9]", "", rate)
        if rate:
            return f"{kind or 'STREAM'} {rate}k"
    return kind or "STREAM"


def playlist_stream_info(playlist_id: str) -> dict:
    tracks = owntone_request(f"/library/playlists/{playlist_id}/tracks?limit=1", timeout=5) or {}
    track = (tracks.get("items") or [None])[0]
    if not isinstance(track, dict):
        raise ValueError("Radio playlist has no stream track")
    url = str(track.get("path") or "")
    if not url.startswith(("http://", "https://")):
        raise ValueError("Playlist item is not an HTTP radio stream")
    return {"url": url, "track": track, "quality": _quality_from_track(track)}


def probe_radio(playlist_id: str, force: bool = False) -> dict:
    key = str(playlist_id)
    now = time.monotonic()
    with LOCK:
        cached = RADIO_HEALTH_CACHE.get(key)
        if cached and not force and now - float(cached.get("_mono", 0)) < RADIO_HEALTH_TTL:
            return {k: v for k, v in cached.items() if k != "_mono"}

    checked = datetime.now().astimezone().isoformat()
    started = time.monotonic()
    try:
        info = playlist_stream_info(key)
        req = Request(info["url"], headers={
            "User-Agent": "OwnToneDashboard/1.0",
            "Accept": "audio/*,*/*;q=0.5",
            "Icy-MetaData": "1",
            "Connection": "close",
        }, method="GET")
        with urlopen(req, timeout=5) as response:
            response.read(768)
            headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
            quality = _quality_from_track(info["track"], headers) or info["quality"]
            result = {
                "playlist_id": key,
                "online": True,
                "status": "LIVE",
                "quality": quality,
                "http_status": int(getattr(response, "status", 200) or 200),
                "latency_ms": int((time.monotonic() - started) * 1000),
                "checked_at": checked,
            }
    except Exception as exc:
        result = {
            "playlist_id": key,
            "online": False,
            "status": "OFFLINE",
            "quality": "STREAM",
            "latency_ms": int((time.monotonic() - started) * 1000),
            "checked_at": checked,
            "error": str(exc)[:240],
        }
    with LOCK:
        RADIO_HEALTH_CACHE[key] = dict(result, _mono=time.monotonic())
    return result


def capture_history_once() -> None:
    try:
        player = owntone_request("/player", timeout=4) or {}
        if player.get("state") == "stop":
            return
        queue = owntone_request("/queue?id=now_playing", timeout=4) or {}
        item = (queue.get("items") or [None])[0]
        if not isinstance(item, dict):
            return
        title = str(item.get("title") or "").strip()
        artist = str(item.get("artist") or "").strip()
        album = str(item.get("album") or "").strip()
        path = str(item.get("path") or "").strip()
        if not (title or path):
            return
        is_radio = item.get("data_kind") == "url" or path.startswith(("http://", "https://"))
        play_uri = str(item.get("uri") or "").strip()
        station_name = ""
        if is_radio and path:
            radio = _refresh_radio_map().get(path) or {}
            if radio.get("uri"):
                play_uri = str(radio["uri"])
                station_name = str(radio.get("name") or "")
        key = "|".join([str(item.get("id") or ""), title, artist, album, path])
        history = load_history()
        if history and history[0].get("key") == key:
            return
        record = {
            "key": key,
            "played_at": datetime.now().astimezone().isoformat(),
            "title": title or station_name or "Unknown",
            "artist": artist,
            "album": album,
            "station_name": station_name,
            "is_radio": bool(is_radio),
            "uri": str(item.get("uri") or ""),
            "play_uri": play_uri,
            "artwork_url": item.get("artwork_url") or "",
            "type": item.get("type") or "",
            "bitrate": item.get("bitrate") or "",
        }
        history.insert(0, record)
        save_history(history[:HISTORY_LIMIT])
    except Exception:
        return


def history_loop():
    while True:
        capture_history_once()
        time.sleep(12)


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
                    except Exception as exc:
                        runs[schedule_id] = minute_key
                        runtime["last_error"] = {
                            "at": datetime.now().astimezone().isoformat(),
                            "schedule": schedule_id,
                            "message": str(exc),
                        }
                    dirty = True

                try:
                    schedule_volume_bump(item, runtime)
                except Exception as exc:
                    runtime["last_error"] = {
                        "at": datetime.now().astimezone().isoformat(),
                        "schedule": schedule_id,
                        "message": f"ramp: {exc}",
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
    server_version = "OwnToneDashboardCompanion/1.1"

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
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path in ("/health", "/"):
            state = load_runtime_state()
            self._send(200, {
                "ok": True,
                "service": "owntone-dashboard-companion",
                "time": datetime.now().astimezone().isoformat(),
                "timezone": str(datetime.now().astimezone().tzinfo),
                "owntone": OWNTONE_BASE,
                "history_count": len(load_history()),
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
        if path == "/history":
            try:
                limit = max(1, min(HISTORY_LIMIT, int((query.get("limit") or [HISTORY_LIMIT])[0])))
            except ValueError:
                limit = HISTORY_LIMIT
            self._send(200, {"items": load_history()[:limit]})
            return
        if path == "/radio-health":
            playlist_id = str((query.get("playlist_id") or [""])[0]).strip()
            if not playlist_id or not re.match(r"^[A-Za-z0-9_-]+$", playlist_id):
                self._send(400, {"error": "playlist_id is required"})
                return
            try:
                result = probe_radio(playlist_id, force=(query.get("force") or ["0"])[0] == "1")
                self._send(200, result)
            except Exception as exc:
                self._send(200, {"playlist_id": playlist_id, "online": False, "status": "OFFLINE", "error": str(exc)})
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
    if not HISTORY_FILE.exists():
        _atomic_write(HISTORY_FILE, [])
    threading.Thread(target=scheduler_loop, name="scheduler", daemon=True).start()
    threading.Thread(target=history_loop, name="history", daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"OwnTone dashboard companion listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
