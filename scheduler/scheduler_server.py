#!/usr/bin/env python3
"""Tiny persistent companion service for OwnTone Dashboard.

No third-party Python packages are required. Besides scheduled playback, this
service keeps a small now-playing history and performs server-side radio stream
health probes so browser CORS rules never get in the way.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import threading
import time
from functools import partial
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

HOST = os.environ.get("OWNTONE_SCHEDULER_HOST", "127.0.0.1")
PORT = int(os.environ.get("OWNTONE_SCHEDULER_PORT", "3691"))
OWNTONE_BASE = os.environ.get("OWNTONE_BASE", "http://127.0.0.1:3689/api").rstrip("/")
DATA_DIR = Path(os.environ.get("OWNTONE_SCHEDULER_DATA", "/var/lib/owntone-dashboard"))
STATIONS_DIR = Path(os.environ.get("OWNTONE_STATIONS_DIR", "/media/music/Radio"))
PLAYLISTS_DIR = Path(os.environ.get("OWNTONE_PLAYLISTS_DIR", "/media/music/Playlists"))


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


NIGHT_START = _env_float("OWNTONE_NIGHT_START", 0)
NIGHT_END = _env_float("OWNTONE_NIGHT_END", 8)
NIGHT_MAX = _env_int("OWNTONE_NIGHT_MAX", 8)
# How many minutes past its scheduled time a run may still fire (restart/DST recovery).
GRACE_MINUTES = max(0, _env_int("OWNTONE_SCHEDULE_GRACE_MIN", 30))


def _local_zone() -> ZoneInfo:
    """
    The zone schedules are expressed in. TZ from the environment (the systemd
    unit sets it); falls back to UTC when the name is not installed.
    """
    name = os.environ.get("TZ") or os.environ.get("OWNTONE_TZ") or ""
    if name:
        try:
            return ZoneInfo(name)
        except Exception as exc:
            print(f"[time] unknown time zone {name!r} ({exc}); falling back to UTC", flush=True)
    return ZoneInfo("UTC")


LOCAL_ZONE = _local_zone()

# Mirrors radioPathHint / radioNameHints in config.js. Keep the two in step.
RADIO_PATH_HINT = (os.environ.get("OWNTONE_RADIO_PATH_HINT") or "/radio/").lower()
RADIO_NAME_HINTS = [
    hint.strip().lower()
    for hint in (os.environ.get("OWNTONE_RADIO_NAME_HINTS") or "radio").split(",")
    if hint.strip()
]
SCHEDULES_FILE = DATA_DIR / "schedules.json"
STATE_FILE = DATA_DIR / "scheduler-state.json"
HISTORY_FILE = DATA_DIR / "history.json"
LOCK = threading.RLock()
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
HISTORY_LIMIT = 500
ACTIVITY_LIMIT = 30
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


def update_runtime_state(mutate):
    """
    Read-modify-write the runtime state under one lock.

    The scheduler loop used to load the state, work for fifteen seconds and
    then write its stale copy back — silently dropping any activity entry or
    sleep field another thread had written in the meantime. Every writer goes
    through here now, so the whole cycle is atomic.

    `mutate(state)` may return False to skip the write.
    """
    with LOCK:
        state = load_runtime_state()
        if mutate(state) is False:
            return state
        _atomic_write(STATE_FILE, state)
        return state


def log_activity(kind: str, text: str) -> None:
    """Append a short event to the activity feed (latest first)."""

    def add(state):
        feed = state.setdefault("activity", [])
        entry = {"at": local_now().isoformat(), "kind": str(kind)[:24], "text": str(text)[:200]}
        if feed and feed[0] == entry:
            return False
        feed.insert(0, entry)
        state["activity"] = feed[:ACTIVITY_LIMIT]
        return True

    try:
        update_runtime_state(add)
    except OSError as exc:
        print(f"[activity] could not record {kind}: {exc}", flush=True)


def library_stats(days: int = 30) -> dict:
    history = load_history()
    cutoff = (local_now() - timedelta(days=days)).isoformat()
    recent = [h for h in history if str(h.get("played_at") or "") >= cutoff]
    day_counts: dict[str, int] = {}
    station_counts: dict[str, int] = {}
    artist_counts: dict[str, int] = {}
    for item in recent:
        day = str(item.get("played_at") or "")[:10]
        if day:
            day_counts[day] = day_counts.get(day, 0) + 1
        if item.get("is_radio"):
            name = str(item.get("station_name") or item.get("title") or "Radio")
            station_counts[name] = station_counts.get(name, 0) + 1
        else:
            artist = str(item.get("artist") or "").strip()
            if artist and artist != "Unknown artist":
                artist_counts[artist] = artist_counts.get(artist, 0) + 1
    def top(counts):
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
        return [{"name": name, "count": count} for name, count in ranked]

    return {
        "window_days": days,
        "total_plays": len(recent),
        "radio_plays": sum(station_counts.values()),
        "days": [{"date": d, "count": c} for d, c in sorted(day_counts.items())],
        "top_stations": top(station_counts),
        "top_artists": top(artist_counts),
        "generated_at": local_now().isoformat(),
    }


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
    except (TypeError, ValueError) as exc:
        raise ValueError("volume must be 0-100") from exc

    try:
        ramp_minutes = max(0, min(1440, int(raw.get("ramp_minutes", 0))))
    except (TypeError, ValueError) as exc:
        raise ValueError("ramp_minutes must be 0-1440") from exc

    try:
        ramp_volume = max(0, min(100, int(raw.get("ramp_volume", 0))))
    except (TypeError, ValueError) as exc:
        raise ValueError("ramp_volume must be 0-100") from exc

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
        "fallback_uri": str(raw.get("fallback_uri") or "")[:200],
        "fallback_name": str(raw.get("fallback_name") or "")[:160],
        "respect_night_cap": bool(raw.get("respect_night_cap", False)),
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


def schedule_volume_bump(item: dict, runtime: dict) -> bool:
    ramp_minutes = int(item.get("ramp_minutes") or 0)
    ramp_volume = int(item.get("ramp_volume") or 0)
    if ramp_minutes <= 0 or ramp_volume <= 0:
        return False
    run_key = str((runtime.get("runs") or {}).get(str(item.get("id")), ""))
    if not run_key:
        return False
    bumps = runtime.setdefault("bumps", {})
    if bumps.get(str(item.get("id"))) == run_key:
        return False
    try:
        ran_at = datetime.strptime(run_key, "%Y-%m-%dT%H:%M").replace(tzinfo=LOCAL_ZONE)
    except ValueError:
        return False
    if local_now() < ran_at + timedelta(minutes=ramp_minutes):
        return False
    output_id = str(item.get("output_id") or "")
    volume_query = urlencode({"volume": ramp_volume, "output_id": output_id})
    owntone_request(f"/player/volume?{volume_query}", "PUT")
    bumps[str(item.get("id"))] = run_key
    return True


def _night_window(now: datetime | None = None) -> bool:
    now = now or local_now()
    hour = now.hour + now.minute / 60.0
    if NIGHT_START == NIGHT_END:
        return True
    if NIGHT_START < NIGHT_END:
        return NIGHT_START <= hour < NIGHT_END
    return hour >= NIGHT_START or hour < NIGHT_END


def stream_alive(url: str, timeout: int = 4) -> bool:
    try:
        req = Request(url, headers={"User-Agent": "OwnToneDashboard/1.0", "Connection": "close"}, method="GET")
        with urlopen(req, timeout=timeout) as response:
            response.read(256)
            return True
    except Exception:
        return False


def _playlist_id_from_uri(uri: str) -> str:
    match = re.match(r"^library:playlist:(\d+)$", str(uri or "").strip())
    return match.group(1) if match else ""


def rescan_library() -> None:
    """Ask OwnTone to pick up a file we just wrote. Best effort — the caller's
    own result should not depend on the rescan succeeding."""
    try:
        owntone_request("/rescan", "POST", timeout=8)
    except Exception as exc:
        print(f"[library] rescan failed: {exc}", flush=True)


def execute_schedule(item: dict) -> dict:
    output_id = str(item["output_id"])
    source_uri = item["source_uri"]
    source_name = item["source_name"]
    volume = int(item["volume"])
    ramp_volume = int(item.get("ramp_volume") or 0)
    note = ""

    if item.get("respect_night_cap") and _night_window():
        cap = max(0, min(100, NIGHT_MAX))
        if volume > cap:
            volume = cap
            note = " (night cap)"
        if ramp_volume > cap:
            ramp_volume = cap

    if item.get("kind") == "radio":
        playlist_id = _playlist_id_from_uri(source_uri)
        alive = False
        if playlist_id:
            try:
                info = playlist_stream_info(playlist_id)
                alive = stream_alive(info["url"])
            except Exception:
                alive = False
        if not alive and item.get("fallback_uri"):
            source_uri = item["fallback_uri"]
            source_name = item.get("fallback_name") or "Fallback"
            note = f"{note} (fallback)".strip()

    owntone_request("/outputs/set", "PUT", {"outputs": [output_id]})
    volume_query = urlencode({"volume": volume, "output_id": output_id})
    owntone_request(f"/player/volume?{volume_query}", "PUT")
    play_query = urlencode({
        "uris": source_uri,
        "clear": "true",
        "playback": "start",
        "shuffle": "true" if item.get("shuffle") else "false",
    })
    owntone_request(f"/queue/items/add?{play_query}", "POST")
    return {"ok": True, "message": f"Playing {source_name} on {item['output_name']}{note}"}


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


def local_now() -> datetime:
    """
    Now, in the configured zone.

    datetime.now().astimezone() returns a *fixed* offset for today, so adding
    or subtracting days across a DST boundary kept today's offset and shifted
    schedules by an hour. A real ZoneInfo keeps each day's own offset.
    """
    return datetime.now(LOCAL_ZONE)


def _at_local_time(day: datetime, hour: int, minute: int) -> datetime:
    """
    `day` at hour:minute in the local zone.

    On the spring-forward day the wall clock time may not exist and on the
    autumn one it happens twice; normalising through the zone gives a real
    instant either way instead of a datetime that compares wrong.
    """
    naive = day.replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=None)
    return naive.replace(tzinfo=LOCAL_ZONE)


def _parse_hhmm(value: str):
    """(hour, minute) for a validated HH:MM string, or None."""
    text = str(value or "")
    if not TIME_RE.match(text):
        return None
    hour, minute = text.split(":", 1)
    return int(hour), int(minute)


def _schedule_occurrence(item: dict, now: datetime | None = None, field: str = "time"):
    """Return the most recent due occurrence within the scheduler grace window."""
    parsed = _parse_hhmm(item.get(field))
    if not parsed:
        return None
    hour, minute = parsed
    now = now or local_now()
    selected_days = set(item.get("days") or [])
    grace = timedelta(minutes=GRACE_MINUTES)

    for days_back in range(8):
        day = now - timedelta(days=days_back)
        if DAYS[day.weekday()] not in selected_days:
            continue
        candidate = _at_local_time(day, hour, minute)
        if candidate > now:
            continue
        return candidate if now - candidate <= grace else None
    return None


def next_run(item: dict, now: datetime | None = None):
    """The next time this schedule will fire, or None if it never will."""
    if not item.get("enabled"):
        return None
    # A hand-edited schedules.json used to reach int() here and raise, which
    # took the whole GET /schedules response down with it.
    parsed = _parse_hhmm(item.get("time"))
    if not parsed:
        return None
    hour, minute = parsed
    now = now or local_now()
    for add_days in range(8):
        day = now + timedelta(days=add_days)
        if DAYS[day.weekday()] not in item.get("days", []):
            continue
        candidate = _at_local_time(day, hour, minute)
        if candidate >= now:
            return candidate
    return None


def _is_radio_playlist(item: dict) -> bool:
    """
    Mirror of isRadioPlaylist() in shared.js.

    The path hint is the reliable signal; RADIO_NAME_HINTS is for libraries
    where stations are not all in one folder. This used to hardcode a handful
    of Belgrade station names, which misread any playlist called "S1" as one.
    """
    path = str(item.get("path") or "").lower().replace("\\", "/")
    name = str(item.get("name") or "").lower()
    if RADIO_PATH_HINT in path:
        return True
    return any(re.search(rf"(^|\s){re.escape(hint)}(\s|$)", name) for hint in RADIO_NAME_HINTS)


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
            except Exception as exc:
                print(f"[radio] could not read playlist {pid}: {exc}", flush=True)
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

    checked = local_now().isoformat()
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
            "played_at": local_now().isoformat(),
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
        label = f"{title} — {artist}" if artist else title
        if is_radio:
            log_activity("radio", f"📡 {station_name or title}: {label}")
        else:
            log_activity("track", f"▶ {label}")
    except Exception as exc:
        print(f"[history] capture failed: {exc}", flush=True)


def history_loop():
    while True:
        capture_history_once()
        time.sleep(12)


def _fade_output_id() -> str:
    """Which output the sleep fade should act on: the player's, else the first selected."""
    player = owntone_request("/player", timeout=4) or {}
    output_id = str(player.get("output_id") or "")
    if output_id:
        return output_id
    outputs = owntone_request("/outputs", timeout=4) or {}
    selected = [o for o in (outputs.get("outputs") or []) if o.get("selected")]
    return str(selected[0].get("id") or "") if selected else ""


def start_sleep(minutes: int) -> dict:
    if minutes <= 0:
        update_runtime_state(lambda state: state.pop("sleep", None) is not None or True)
        log_activity("sleep", "🌙 Sleep timer cancelled")
        return {"active": False}

    # Resolved before taking the lock: these are network calls.
    player = owntone_request("/player", timeout=4) or {}
    try:
        start_volume = max(0, min(100, int(player.get("volume") or 20)))
    except (TypeError, ValueError):
        start_volume = 20
    output_id = _fade_output_id()

    def begin(state):
        # sleep and sleep_output_id are written together. They used to be two
        # separate saves, and the scheduler loop could overwrite the second one
        # before sleep_tick ever read it — the fade then never started.
        state["sleep"] = {
            "start": local_now().isoformat(),
            "duration_min": int(minutes),
            "start_volume": start_volume,
        }
        state["sleep_output_id"] = output_id
        return True

    update_runtime_state(begin)
    log_activity("sleep", f"🌙 Sleep timer {minutes} min")
    return sleep_status()


def sleep_status() -> dict:
    with LOCK:
        entry = load_runtime_state().get("sleep")
        if not entry:
            return {"active": False}
        try:
            started = datetime.fromisoformat(str(entry.get("start")))
            total_s = int(entry.get("duration_min") or 0) * 60
            remaining_s = total_s - int((local_now() - started).total_seconds())
        except (TypeError, ValueError):
            return {"active": False}
        if remaining_s <= 0:
            return {"active": True, "remaining_min": 0, "remaining_s": 0}
        return {
            "active": True,
            "remaining_min": round(remaining_s / 60),
            "remaining_s": remaining_s,
            "duration_min": entry.get("duration_min"),
            "start_volume": entry.get("start_volume"),
        }


def sleep_tick(runtime: dict) -> bool:
    """Fade volume down as the deadline approaches; stop playback at zero. Returns dirty flag."""
    entry = runtime.get("sleep")
    if not entry:
        return False
    try:
        started = datetime.fromisoformat(str(entry.get("start")))
        total_s = int(entry.get("duration_min") or 0) * 60
        elapsed = (local_now() - started).total_seconds()
    except (TypeError, ValueError):
        runtime.pop("sleep", None)
        return True
    remaining = total_s - elapsed
    output_id = str(runtime.get("sleep_output_id") or "")
    if remaining <= 0:
        owntone_request("/player/stop", "PUT")
        runtime.pop("sleep", None)
        _forget_now_playing()
        log_activity("sleep", "🌙 Sleep timer finished — playback stopped")
        return True
    # fade only in the final stretch (<=3 min) so normal listening is untouched
    if total_s > 0 and remaining <= min(total_s, 180):
        start_volume = int(entry.get("start_volume") or 0)
        target = max(0, min(start_volume, round(start_volume * remaining / min(total_s, 180))))
        last = int(entry.get("last_sent") or -1)
        if target != last and output_id:
            q = urlencode({"volume": target, "output_id": output_id})
            try:
                owntone_request(f"/player/volume?{q}", "PUT")
                entry["last_sent"] = target
                return True
            except Exception:
                return False
    return False


def list_stations() -> list[dict]:
    items = []
    if not STATIONS_DIR.is_dir():
        return items
    for path in sorted(STATIONS_DIR.glob("*.m3u")):
        url = ""
        name = path.stem
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line.startswith("#EXTINF:"):
                    parts = line.split(",", 1)
                    if len(parts) == 2 and parts[1].strip():
                        name = parts[1].strip()
                elif line and not line.startswith("#"):
                    url = line
                    break
        except OSError:
            continue
        slug = re.sub(r"[^a-z0-9_-]", "", path.stem.lower().replace(" ", "_"))
        items.append({"slug": slug or path.stem, "name": name, "url": url, "file": path.name})
    return items


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _'&()./-]{0,59}$")
URL_RE = re.compile(r"^https?://[^\s\"<>]+$", re.IGNORECASE)


def create_station(name: str, url: str) -> dict:
    name = str(name or "").strip()
    url = str(url or "").strip()
    if not NAME_RE.match(name):
        raise ValueError("Invalid station name")
    if not URL_RE.match(url):
        raise ValueError("Stream URL must be http(s)")
    slug = re.sub(r"[^a-z0-9_-]", "", name.lower().replace(" ", "_")).strip("_") or "station"
    target = STATIONS_DIR / f"{slug}.m3u"
    counter = 2
    while target.exists():
        target = STATIONS_DIR / f"{slug}-{counter}.m3u"
        counter += 1
    STATIONS_DIR.mkdir(parents=True, exist_ok=True)
    target.write_text(f"#EXTM3U\n#EXTINF:-1,{name}\n{url}\n", encoding="utf-8")
    rescan_library()
    log_activity("station", f"📻 Station added: {name}")
    return {"slug": re.sub(r"[^a-z0-9_-]", '', target.stem), "name": name, "url": url, "file": target.name}


def delete_station(slug: str) -> dict:
    slug = str(slug or "")
    if not SLUG_RE.match(slug):
        raise ValueError("Invalid station id")
    removed = False
    for path in STATIONS_DIR.glob("*.m3u"):
        stem_slug = re.sub(r"[^a-z0-9_-]", '', path.stem.lower().replace(' ', '_'))
        if stem_slug == slug:
            path.unlink()
            removed = True
            break
    if not removed:
        raise ValueError("Station not found")
    rescan_library()
    log_activity("station", f"🗑 Station deleted: {slug}")
    return {"ok": True}


def _resolve_station_playlist(station: dict) -> str:
    """Map a station .m3u file in STATIONS_DIR to its OwnTone playlist URI."""
    filename = str(station.get("file") or "")
    if not filename:
        raise ValueError("Station has no file name")
    # Match on the full configured path. The old code hardcoded
    # /media/music/Radio/ and fell back to matching the bare file name, which
    # could pick a same-named playlist from anywhere in the library.
    wanted = str((STATIONS_DIR / filename).as_posix()).lower()
    playlists = owntone_request("/library/playlists?limit=500") or {}
    for playlist in playlists.get("items", []):
        path = str(playlist.get("path") or "").replace("\\", "/").lower()
        if path == wanted or path.endswith(wanted):
            return str(playlist.get("uri") or "")
    raise ValueError(f"No OwnTone playlist found for {filename} under {STATIONS_DIR}")


def play_station(slug: str, output_id: str = "", shuffle: bool = False) -> dict:
    slug = str(slug or "")
    if not SLUG_RE.match(slug):
        raise ValueError("Invalid station id")
    station = next((s for s in list_stations() if s["slug"] == slug), None)
    if not station:
        raise ValueError("Station not found")
    uri = _resolve_station_playlist(station)
    if output_id:
        owntone_request("/outputs/set", "PUT", {"outputs": [str(output_id)]})
    query = urlencode({"uris": uri, "clear": "true", "playback": "start", "shuffle": "true" if shuffle else "false"})
    owntone_request(f"/queue/items/add?{query}", "POST")
    log_activity("station", f"▶ Playing {station['name']}")
    _forget_now_playing()
    return {"ok": True, "played": station["name"], "playlist": uri}


NOW_PLAYING_TTL = 2.0
_now_playing_cache = {"expires": 0.0, "path": ""}


def _current_stream_url() -> str:
    """
    The URL OwnTone is streaming right now, or "" when it is not playing.

    Cached for a couple of seconds because HomeKit bridges poll the switch
    endpoints often and each call would otherwise hit OwnTone twice.
    """
    now = time.monotonic()
    with LOCK:
        if _now_playing_cache["expires"] > now:
            return _now_playing_cache["path"]
    path = ""
    try:
        player = owntone_request("/player", timeout=4) or {}
        if player.get("state") == "play":
            queue = owntone_request("/queue?id=now_playing", timeout=4) or {}
            item = (queue.get("items") or [None])[0]
            candidate = str((item or {}).get("path") or "").strip()
            if candidate.startswith(("http://", "https://")):
                path = candidate
    except Exception:
        path = ""
    with LOCK:
        _now_playing_cache["path"] = path
        _now_playing_cache["expires"] = time.monotonic() + NOW_PLAYING_TTL
    return path


def station_is_playing(slug: str) -> bool:
    """
    Whether this station is the one currently on air.

    Read from OwnTone rather than remembered in a dict: the old in-memory map
    reported every switch as off after a service restart, and a scheduled run
    never updated it at all, so Siri could report the wrong state for hours.
    """
    station = next((s for s in list_stations() if s["slug"] == slug), None)
    if not station or not station.get("url"):
        return False
    return _current_stream_url() == str(station["url"]).strip()


def _forget_now_playing() -> None:
    """Drop the cache so a state change is visible on the next poll."""
    with LOCK:
        _now_playing_cache["expires"] = 0.0


def play_random_station(output_id: str = "") -> dict:
    stations = list_stations()
    if not stations:
        raise ValueError("No stations available")
    import random as _random
    errors = []
    for _ in range(min(6, len(stations))):
        station = _random.choice(stations)
        try:
            result = play_station(station["slug"], output_id=output_id)
            return dict(result, random=True)
        except Exception as exc:
            errors.append(str(exc))
    raise ValueError("; ".join(errors)[:240] or "Random play failed")


# ---------- editable playlists (plain .m3u files) ----------

LINE_RE = re.compile(r"^(#.*|https?://\S+|/.+)$")


def _playlist_path(slug: str) -> Path:
    if not SLUG_RE.match(str(slug or "")):
        raise ValueError("Invalid playlist id")
    for path in PLAYLISTS_DIR.glob("*.m3u"):
        stem_slug = re.sub(r"[^a-z0-9_-]", '', path.stem.lower().replace(' ', '_'))
        if stem_slug == slug:
            return path
    raise ValueError("Playlist not found")


def list_playlists() -> list[dict]:
    items = []
    if not PLAYLISTS_DIR.is_dir():
        return items
    for path in sorted(PLAYLISTS_DIR.glob("*.m3u")):
        lines: list[str] = []
        name = path.stem
        try:
            for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if line.startswith("#EXTINF:") and "," in line:
                    name = line.split(",", 1)[1].strip() or name
                elif line and not line.startswith("#"):
                    lines.append(line)
        except OSError:
            continue
        items.append({
            "slug": re.sub(r"[^a-z0-9_-]", '', path.stem.lower().replace(' ', '_')) or path.stem,
            "name": name,
            "file": path.name,
            "track_count": len(lines),
            "lines": lines,
        })
    return items


def create_playlist(name: str) -> dict:
    name = str(name or "").strip()
    if not NAME_RE.match(name):
        raise ValueError("Invalid playlist name")
    slug = re.sub(r"[^a-z0-9_-]", "", name.lower().replace(" ", "_")).strip("_") or "playlist"
    target = PLAYLISTS_DIR / f"{slug}.m3u"
    counter = 2
    while target.exists():
        target = PLAYLISTS_DIR / f"{slug}-{counter}.m3u"
        counter += 1
    PLAYLISTS_DIR.mkdir(parents=True, exist_ok=True)
    target.write_text("#EXTM3U\n", encoding="utf-8")
    rescan_library()
    log_activity("playlist", f"🎵 Playlist created: {name}")
    return {"slug": re.sub(r"[^a-z0-9_-]", '', target.stem), "name": name, "file": target.name}


def save_playlist_lines(slug: str, lines: list) -> dict:
    path = _playlist_path(slug)
    cleaned = []
    for raw in lines or []:
        line = str(raw).strip()
        if not line:
            continue
        if not LINE_RE.match(line):
            raise ValueError(f"Line must be a URL, a /path, or a # comment: {line[:60]}")
        cleaned.append(line)
    tmp = path.with_suffix(".m3u.tmp")
    tmp.write_text("#EXTM3U\n" + "\n".join(cleaned) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    rescan_library()
    log_activity("playlist", f"✏️ Playlist saved: {path.stem} ({len(cleaned)} tracks)")
    return {"ok": True, "track_count": len(cleaned)}


def delete_playlist(slug: str) -> dict:
    path = _playlist_path(slug)
    path.unlink()
    rescan_library()
    log_activity("playlist", f"🗑 Playlist deleted: {path.stem}")
    return {"ok": True}


def _record_last_error(state: dict, message: str) -> bool:
    state["last_error"] = {"at": local_now().isoformat(), "message": message}
    return True


def _run_due_schedules(runtime: dict, now: datetime) -> bool:
    """
    Fire every schedule that came due, plus its ramp and stop time.

    Called inside update_runtime_state, so the read-modify-write of the
    runtime file is atomic with respect to the history thread and request
    handlers. Returns True when the state changed.
    """
    runs = runtime.setdefault("runs", {})
    stops = runtime.setdefault("stops", {})
    dirty = False

    for item in load_schedules():
        if not item.get("enabled"):
            continue
        schedule_id = str(item.get("id"))

        run_at = _schedule_occurrence(item, now)
        run_key = run_at.strftime("%Y-%m-%dT%H:%M") if run_at else ""
        if run_key and runs.get(schedule_id) != run_key:
            # The key is written whether or not the run succeeded, so a broken
            # schedule is retried at its next occurrence, not every 15 seconds.
            runs[schedule_id] = run_key
            try:
                result = execute_schedule(item)
                runtime["last_error"] = None
                log_activity("schedule", f"⏰ {item.get('name')}: {result.get('message', '')}")
            except Exception as exc:
                runtime["last_error"] = {
                    "at": local_now().isoformat(),
                    "schedule": schedule_id,
                    "message": str(exc),
                }
                log_activity("error", f"⏰ {item.get('name')}: {exc}")
            dirty = True

        try:
            if schedule_volume_bump(item, runtime):
                dirty = True
        except Exception as exc:
            runtime["last_error"] = {
                "at": local_now().isoformat(),
                "schedule": schedule_id,
                "message": f"ramp: {exc}",
            }
            dirty = True

        stop_at = _schedule_occurrence(item, now, "stop_time") if item.get("stop_time") else None
        stop_key = stop_at.strftime("%Y-%m-%dT%H:%M") if stop_at else ""
        if stop_key and stops.get(schedule_id) != stop_key:
            stops[schedule_id] = stop_key
            try:
                stop_playback(item)
                runtime["last_error"] = None
            except Exception as exc:
                runtime["last_error"] = {
                    "at": local_now().isoformat(),
                    "schedule": schedule_id,
                    "message": str(exc),
                }
            dirty = True

    return dirty


def scheduler_loop():
    while True:
        try:
            now = local_now()

            def tick(runtime, now=now):
                # Both halves report whether they changed anything. `or` alone
                # would short-circuit and skip the sleep fade.
                due = _run_due_schedules(runtime, now)
                slept = sleep_tick(runtime)
                return due or slept

            update_runtime_state(tick)
        except Exception as exc:
            message = str(exc)
            print(f"[scheduler] tick failed: {message}", flush=True)
            with contextlib.suppress(OSError):
                update_runtime_state(partial(_record_last_error, message=message))
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
        if len(parts) >= 2 and parts[0] == "stations":
            return parts[1]
        return None

    def do_GET(self):
        try:
            self._handle_get()
        except Exception as exc:
            # GET used to be the only verb without a handler here, so a single
            # malformed schedules.json closed the connection with no response
            # and the dashboard reported a network error.
            self.log_message("GET %s failed: %s", self.path, exc)
            self._send(500, {"error": str(exc)})

    def _handle_get(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        parts = [x for x in path.split("/") if x]
        if path in ("/health", "/"):
            state = load_runtime_state()
            self._send(200, {
                "ok": True,
                "service": "owntone-dashboard-companion",
                "time": local_now().isoformat(),
                "timezone": str(LOCAL_ZONE),
                "owntone": OWNTONE_BASE,
                "history_count": len(load_history()),
                "last_error": state.get("last_error"),
            })
            return
        if path == "/schedules":
            now = local_now()
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
        if len(parts) == 3 and parts[0] == "stations" and parts[2] == "status":
            self._send(200, {"on": station_is_playing(parts[1])})
            return
        if path == "/sleep":
            self._send(200, sleep_status())
            return
        if path == "/stations":
            self._send(200, {"items": list_stations(), "dir": str(STATIONS_DIR)})
            return
        if path == "/activity":
            with LOCK:
                items = load_runtime_state().get("activity") or []
            self._send(200, {"items": items[:ACTIVITY_LIMIT]})
            return
        if path == "/stats":
            try:
                days = int((query.get("days") or [30])[0])
            except ValueError:
                days = 30
            self._send(200, library_stats(max(1, min(365, days))))
            return
        if path == "/playlists":
            self._send(200, {"items": list_playlists(), "dir": str(PLAYLISTS_DIR)})
            return
        self._send(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        parts = [x for x in path.split("/") if x]
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

            if path == "/sleep":
                body = self._body()
                try:
                    minutes = int(body.get("minutes") or 0)
                except (TypeError, ValueError) as exc:
                    raise ValueError("minutes must be an integer") from exc
                self._send(200, start_sleep(minutes))
                return

            if path == "/stations":
                body = self._body()
                self._send(201, create_station(str(body.get("name") or ""), str(body.get("url") or "")))
                return

            if path == "/playlists":
                body = self._body()
                self._send(201, create_playlist(str(body.get("name") or "")))
                return

            if path == "/playback/stop":
                owntone_request("/player/stop", "PUT")
                _forget_now_playing()
                log_activity("station", "⏹ Playback stopped")
                self._send(200, {"ok": True})
                return

            if len(parts) >= 2 and parts[0] == "stations" and len(parts) >= 3 and parts[2] == "play":
                body = self._body()
                if parts[1] == "random":
                    self._send(200, play_random_station(output_id=str(body.get("output_id") or "")))
                else:
                    self._send(200, play_station(parts[1], output_id=str(body.get("output_id") or "")))
                return
        except Exception as exc:
            self._send(400, {"error": str(exc)})
            return
        self._send(404, {"error": "Not found"})

    def do_PUT(self):
        parts = [x for x in urlparse(self.path).path.split("/") if x]
        if len(parts) == 2 and parts[0] == "playlists":
            try:
                body = self._body()
                self._send(200, save_playlist_lines(parts[1], body.get("lines") or []))
            except Exception as exc:
                self._send(400, {"error": str(exc)})
            return
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
        parts = [x for x in urlparse(self.path).path.split("/") if x]
        if len(parts) == 2 and parts[0] == "playlists":
            try:
                self._send(200, delete_playlist(parts[1]))
            except Exception as exc:
                self._send(400, {"error": str(exc)})
            return
        schedule_id = self._id_from_path()
        if not schedule_id:
            self._send(404, {"error": "Not found"})
            return
        if parts and parts[0] == "stations":
            try:
                self._send(200, delete_station(schedule_id))
            except Exception as exc:
                self._send(400, {"error": str(exc)})
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
