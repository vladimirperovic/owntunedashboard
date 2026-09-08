#!/usr/bin/env python3
"""Tiny persistent companion service for OwnTone Dashboard.

No third-party Python packages are required. Besides scheduled playback, this
service keeps a small now-playing history and performs server-side radio stream
health probes so browser CORS rules never get in the way.
"""

from __future__ import annotations

import contextlib
import copy
import http.client
import ipaddress
import json
import os
import re
import socket
import stat
import tempfile
import threading
import time
from functools import partial, wraps
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

HOST = os.environ.get("OWNTONE_SCHEDULER_HOST", "127.0.0.1")
PORT = int(os.environ.get("OWNTONE_SCHEDULER_PORT", "3691"))
OWNTONE_BASE = os.environ.get("OWNTONE_BASE", "http://127.0.0.1:3689/api").rstrip("/")
DATA_DIR = Path(os.environ.get("OWNTONE_SCHEDULER_DATA", "/var/lib/owntone-dashboard"))
STATIONS_DIR = Path(os.environ.get("OWNTONE_STATIONS_DIR", "/media/music/Radio"))
PLAYLISTS_DIR = Path(os.environ.get("OWNTONE_PLAYLISTS_DIR", "/media/music/Playlists"))
# Pin the external origin for custom HTTPS/default-port reverse proxies.
DASHBOARD_ORIGIN = os.environ.get("OWNTONE_SCHEDULER_ORIGIN", "").strip().rstrip("/")
# Exact hostnames/IP literals only, configured by the operator (never by API
# callers). Allows LAN radio probes without granting trust to redirect targets.
STREAM_TRUSTED_HOSTS = frozenset(
    host.strip().lower().rstrip(".")
    for host in os.environ.get("OWNTONE_STREAM_TRUSTED_HOSTS", "").split(",")
    if host.strip()
)


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


def _system_zone_name() -> str:
    """
    The host's zone name, without pulling in a dependency.

    Falling back to UTC here would be wrong: on a box whose clock is set to
    Europe/Belgrade but with no TZ in the environment, every schedule would run
    one or two hours off and nothing would say so.
    """
    try:
        name = Path("/etc/timezone").read_text(encoding="utf-8").strip()
        if name:
            return name
    except OSError:
        pass
    try:
        # Most distributions symlink /etc/localtime into the zoneinfo tree.
        target = os.path.realpath("/etc/localtime")
        marker = "/zoneinfo/"
        if marker in target:
            return target.split(marker, 1)[1]
    except OSError:
        pass
    return ""


def _local_zone() -> ZoneInfo:
    """
    The zone schedules are expressed in.

    TZ (or OWNTONE_TZ) wins, so the systemd unit can pin it; otherwise the
    host's own zone; UTC only when neither can be resolved.
    """
    for source, name in (
        ("TZ", os.environ.get("TZ")),
        ("OWNTONE_TZ", os.environ.get("OWNTONE_TZ")),
        ("the host", _system_zone_name()),
    ):
        if not name:
            continue
        try:
            zone = ZoneInfo(name)
            print(f"[time] schedules use {name} (from {source})", flush=True)
            return zone
        except Exception as exc:
            print(f"[time] {source} names an unknown zone {name!r} ({exc})", flush=True)
    print(
        "[time] could not determine the local time zone; schedules will run in UTC. "
        "Set TZ in the systemd unit.",
        flush=True,
    )
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
PLAYBACK_LOCK = threading.RLock()
FILES_LOCK = threading.RLock()
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
TIME_RE = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]\Z")
HISTORY_LIMIT = 500
ACTIVITY_LIMIT = 30
RADIO_HEALTH_TTL = 90
RADIO_MAP_TTL = 600
RADIO_HEALTH_CACHE: dict[str, dict] = {}
RADIO_MAP_CACHE = {"expires": 0.0, "by_path": {}}


def _read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError, OSError):
        return fallback


def _atomic_write(path: Path, value) -> None:
    _atomic_text(path, json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", 0o600,
                 durable=True)


def _atomic_text(path: Path, text: str, default_mode: int = 0o644, *, durable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique, exclusively created files avoid concurrent writers sharing a .tmp
    # and avoid following a pre-existing .tmp symlink.
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else default_mode
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            if durable:
                stream.flush()
                os.fsync(stream.fileno())
        os.replace(name, path)
        if durable:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


def load_schedules():
    with LOCK:
        data = _read_json(SCHEDULES_FILE, [])
        items = []
        seen = set()
        for raw in data if isinstance(data, list) else []:
            try:
                if not isinstance(raw, dict) or not raw.get("id"):
                    continue
                item = clean_schedule(raw)
                if item["id"] not in seen:
                    items.append(item)
                    seen.add(item["id"])
            except (ValueError, TypeError, OverflowError):
                continue
        return items


def save_schedules(items) -> None:
    with LOCK:
        previous = {item['id']: item for item in load_schedules()}
        for item in items:
            old = previous.get(item['id'], {})
            item['generation'] = item.get('generation') or old.get('generation') or uuid.uuid4().hex

            def fields(row):
                return {k: v for k, v in clean_schedule(row).items()
                        if k not in ('revision', 'generation')}

            unchanged = old and fields(old) == fields(item)
            item['revision'] = (item.get('revision') if unchanged else None) or (
                old.get('revision') if unchanged else None) or uuid.uuid4().hex
        _atomic_write(SCHEDULES_FILE, items)


def load_history():
    with LOCK:
        data = _read_json(HISTORY_FILE, [])
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def save_history(items) -> None:
    with LOCK:
        _atomic_write(HISTORY_FILE, list(items)[:HISTORY_LIMIT])


def load_runtime_state():
    with LOCK:
        data = _read_json(STATE_FILE, {"runs": {}, "stops": {}, "last_error": None})
        if not isinstance(data, dict):
            data = {}
        for key in ("runs", "stops", "bumps", "run_started", "schedule_generations"):
            if not isinstance(data.get(key), dict):
                data[key] = {}
        if not isinstance(data.get("activity"), list):
            data["activity"] = []
        if not isinstance(data.get("sleep"), dict):
            data.pop("sleep", None)
        data.setdefault("last_error", None)
        return data


def save_runtime_state(state) -> None:
    with LOCK:
        _atomic_write(STATE_FILE, state)


# The state dict currently open on this thread, if any. Set only by
# update_runtime_state, so nested calls join the outer update instead of
# starting their own read-modify-write.
_OPEN_UPDATE = threading.local()


def update_runtime_state(mutate):
    """
    Read-modify-write the runtime state under one lock.

    The scheduler loop used to load the state, work for fifteen seconds and
    then write its stale copy back — silently dropping any activity entry or
    sleep field another thread had written in the meantime. Every writer goes
    through here now, so the whole cycle is atomic.

    Calls nest: a schedule run mutates the state and also calls log_activity,
    which is itself an update. The inner call mutates the state the outer one
    already has open and marks it dirty, so both changes land in the single
    write at the end. Without that the outer write would overwrite the inner
    one — the very bug this function exists to prevent.

    `mutate(state)` may return False to mean "nothing changed". Callbacks must
    perform only local state work: claim first, release LOCK for network work,
    then finalize with a fresh update. Never save an execution snapshot.
    """
    with LOCK:
        frame = getattr(_OPEN_UPDATE, "frame", None)
        if frame is not None:
            if mutate(frame["state"]) is not False:
                frame["dirty"] = True
            return frame["state"]

        state = load_runtime_state()
        _OPEN_UPDATE.frame = {"state": state, "dirty": False}
        try:
            changed = mutate(state) is not False
            if changed or _OPEN_UPDATE.frame["dirty"]:
                _atomic_write(STATE_FILE, state)
            return state
        finally:
            _OPEN_UPDATE.frame = None


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


def _integer(value, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError(f"{field} must be an integer")
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be an integer") from exc


def clean_schedule(raw: dict, existing_id: str | None = None) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Schedule must be an object")

    schedule_id = existing_id or str(raw.get("id") or uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", schedule_id):
        raise ValueError("Invalid schedule id")
    for field in ("enabled", "shuffle", "respect_night_cap"):
        if field in raw and not isinstance(raw[field], bool):
            raise ValueError(f"{field} must be a boolean")
    for field in ("source_uri", "source_name", "output_name", "fallback_uri", "fallback_name", "name"):
        if field in raw and not isinstance(raw[field], str):
            raise ValueError(f"{field} must be a string")
    time_value = str(raw.get("time", "09:00"))
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
    if not _playlist_id_from_uri(source_uri):
        raise ValueError("source_uri must be a library playlist URI")
    fallback_uri = raw.get("fallback_uri", "").strip()
    if fallback_uri and not _playlist_id_from_uri(fallback_uri):
        raise ValueError("fallback_uri must be a library playlist URI")

    output = raw.get("output_id", "")
    if isinstance(output, bool) or not isinstance(output, (str, int)):
        raise ValueError("output_id must be a string or integer")
    output_id = str(output).strip()
    output_name = str(raw.get("output_name") or "").strip()
    if not output_id:
        raise ValueError("output_id is required")

    try:
        volume = max(0, min(100, _integer(raw.get("volume", 55), "volume")))
    except (TypeError, ValueError) as exc:
        raise ValueError("volume must be 0-100") from exc

    try:
        ramp_minutes = max(0, min(1440, _integer(raw.get("ramp_minutes", 0), "ramp_minutes")))
    except (TypeError, ValueError) as exc:
        raise ValueError("ramp_minutes must be 0-1440") from exc

    try:
        ramp_volume = max(0, min(100, _integer(raw.get("ramp_volume", 0), "ramp_volume")))
    except (TypeError, ValueError) as exc:
        raise ValueError("ramp_volume must be 0-100") from exc

    name = str(raw.get("name") or "").strip() or f"{source_name} · {time_value}"
    return {
        "id": schedule_id,
        # Internal ownership fields. HTTP mutations replace client values.
        "revision": str(raw.get("revision") or ""),
        "generation": str(raw.get("generation") or ""),
        "name": name[:120],
        "enabled": bool(raw.get("enabled", True)),
        "time": time_value,
        "days": days,
        "kind": kind,
        "source_name": source_name[:160],
        "source_uri": source_uri,
        "fallback_uri": fallback_uri,
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


def night_capped(volume: int, item: dict, now: datetime | None = None) -> tuple[int, bool]:
    """
    A schedule's volume with its own night cap applied.

    Both the initial volume and the delayed ramp go through here. The ramp used
    to be capped into a local variable that execute_schedule then threw away,
    while the bump itself read the raw value -- so a 06:00 run with
    respect_night_cap started at 8% and jumped to its full volume ten minutes
    later, in the middle of the night the flag exists to protect.
    """
    volume = max(0, min(100, int(volume)))
    if not item.get("respect_night_cap") or not _night_window(now):
        return volume, False
    cap = max(0, min(100, NIGHT_MAX))
    return (cap, True) if volume > cap else (volume, False)


def _volume_bump_action(item: dict, runtime: dict):
    """Return a volume request without performing I/O or changing state."""
    ramp_minutes = int(item.get("ramp_minutes") or 0)
    ramp_volume = int(item.get("ramp_volume") or 0)
    if ramp_minutes <= 0 or ramp_volume <= 0:
        return None
    run_key = str((runtime.get("runs") or {}).get(str(item.get("id")), ""))
    if not run_key:
        return None
    bumps = runtime.get("bumps", {})
    if bumps.get(str(item.get("id"))) == run_key:
        return None
    try:
        ran_at = datetime.strptime(run_key, "%Y-%m-%dT%H:%M").replace(tzinfo=LOCAL_ZONE)
        started = runtime.get("run_started", {}).get(str(item.get("id")), {})
        if started.get("key") == run_key:
            if started.get("revision", "") != item.get("revision", ""):
                return None
            ran_at = datetime.fromisoformat(started["at"])
    except (TypeError, ValueError, KeyError):
        return None
    now = local_now()
    delay = now.timestamp() - ran_at.timestamp() - ramp_minutes * 60
    if delay < 0 or delay > max(60, GRACE_MINUTES * 60):
        return None
    stop_at = _stop_for_start(item, ran_at)
    if stop_at and now.timestamp() >= stop_at.timestamp():
        return None
    # Capped at bump time, not at schedule time: the run may have started
    # outside the night window and be ramping up inside it, or the other way.
    ramp_volume, _ = night_capped(ramp_volume, item)
    output_id = str(item.get("output_id") or "")
    volume_query = urlencode({"volume": ramp_volume, "output_id": output_id})
    return {"path": f"/player/volume?{volume_query}", "key": run_key}


def schedule_volume_bump(item: dict, runtime: dict) -> bool:
    """Compatibility helper for callers with private state; tick uses claims."""
    with PLAYBACK_LOCK:
        action = _volume_bump_action(item, runtime)
        if action is None:
            return False
        owntone_request(action["path"], "PUT")
        runtime.setdefault("bumps", {})[str(item["id"])] = action["key"]
        return True


def _night_window(now: datetime | None = None) -> bool:
    now = now or local_now()
    hour = now.hour + now.minute / 60.0
    if NIGHT_START == NIGHT_END:
        return True
    if NIGHT_START < NIGHT_END:
        return NIGHT_START <= hour < NIGHT_END
    return hour >= NIGHT_START or hour < NIGHT_END


@contextlib.contextmanager
def _open_stream(url: str, timeout: int = 4):
    """Probe only public addresses, including redirects, with DNS pinned per hop.

    Keeping the original hostname on the connection preserves Host, TLS SNI and
    certificate checks; only the socket destination uses the validated address.
    Environment proxies are deliberately not used for these untrusted URLs.
    """
    for _ in range(6):
        parsed = urlparse(url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or any(ord(c) < 33 or ord(c) == 127 for c in url)):
            raise ValueError("Invalid HTTP stream URL")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        if not addresses:
            raise ValueError("Stream host has no addresses")
        trusted = parsed.hostname.lower().rstrip(".") in STREAM_TRUSTED_HOSTS
        for address in addresses:
            ip = ipaddress.ip_address(address[4][0])
            public = ip.is_global and not (
                getattr(ip, "ipv4_mapped", None) and not ip.ipv4_mapped.is_global
            )
            if ip.is_unspecified or ip.is_multicast or (not public and not trusted):
                raise ValueError("Stream probes require public IP addresses")
        destination = addresses[0][4][0]
        connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, port, timeout=timeout)
        def connect(address, timeout, source_address=None, destination=destination, port=port):
            return socket.create_connection((destination, port), timeout, source_address)
        connection._create_connection = connect
        try:
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            connection.request("GET", target, headers={
                "User-Agent": "OwnToneDashboard/1.0", "Connection": "close",
                "Accept": "audio/*,*/*;q=0.5", "Icy-MetaData": "1",
            })
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise ValueError("Stream redirect has no location")
                url = urljoin(url, location)
                continue
            if not 200 <= response.status < 300:
                raise ValueError(f"Stream returned HTTP {response.status}")
            yield response
            return
        finally:
            connection.close()
    raise ValueError("Too many stream redirects")


def stream_alive(url: str, timeout: int = 4) -> bool:
    try:
        with _open_stream(url, timeout=timeout) as response:
            return bool(response.read1(256))
    except Exception:
        return False


def _playlist_id_from_uri(uri: str) -> str:
    match = re.fullmatch(r"library:playlist:([0-9]+)", str(uri or "").strip())
    return match.group(1) if match else ""


def rescan_library() -> None:
    """Ask OwnTone to pick up a file we just wrote. Best effort — the caller's
    own result should not depend on the rescan succeeding."""
    try:
        owntone_request("/rescan", "POST", timeout=8)
    except Exception as exc:
        print(f"[library] rescan failed: {exc}", flush=True)


def _serialized(lock):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with lock:
                return function(*args, **kwargs)
        return wrapped
    return decorate


@_serialized(PLAYBACK_LOCK)
def execute_schedule(item: dict) -> dict:
    output_id = str(item["output_id"])
    source_uri = item["source_uri"]
    source_name = item["source_name"]
    volume = int(item["volume"])
    note = ""

    volume, capped = night_capped(volume, item)
    if capped:
        note = " (night cap)"

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
    _forget_now_playing()
    return {"ok": True, "message": f"Playing {source_name} on {item['output_name']}{note}"}


@_serialized(PLAYBACK_LOCK)
def stop_playback(item: dict) -> dict:
    output_id = str(item.get("output_id") or "")
    if output_id:
        owntone_request("/outputs/set", "PUT", {"outputs": [output_id]})
    owntone_request("/player/stop", "PUT")
    _forget_now_playing()
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
    # Choose the first occurrence of an ambiguous time; move a nonexistent
    # spring time forward by the gap (02:30 becomes 03:30).
    return naive.replace(tzinfo=LOCAL_ZONE, fold=0).astimezone(timezone.utc).astimezone(LOCAL_ZONE)


def _stop_for_start(item: dict, start: datetime):
    parsed = _parse_hhmm(item.get("stop_time"))
    if not parsed:
        return None
    day = start
    if item["stop_time"] <= item["time"]:
        day += timedelta(days=1)
    return _at_local_time(day, *parsed)


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
    # Even zero catch-up grace must include the scheduled minute: ticks rarely
    # happen at precisely second zero.
    grace_seconds = max(60, GRACE_MINUTES * 60)

    for days_back in range(8):
        day = now - timedelta(days=days_back)
        if DAYS[day.weekday()] not in selected_days:
            continue
        candidate = _at_local_time(day, hour, minute)
        if field == "stop_time":
            start = _parse_hhmm(item.get("time"))
            if not start:
                return None
            candidate = _stop_for_start(item, _at_local_time(day, *start))
        age = now.timestamp() - candidate.timestamp()
        if age < 0:
            continue
        return candidate if age <= grace_seconds else None
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
        if candidate.timestamp() >= now.timestamp():
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
        with _open_stream(info["url"], timeout=5) as response:
            if not response.read1(768):
                raise ValueError("Stream returned no audio data")
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


@_serialized(PLAYBACK_LOCK)
def start_sleep(minutes: int) -> dict:
    minutes = _integer(minutes, "minutes")
    if not 0 <= minutes <= 1440:
        raise ValueError("minutes must be 0-1440")
    if minutes <= 0:
        update_runtime_state(lambda state: state.pop("sleep", None) is not None or True)
        log_activity("sleep", "🌙 Sleep timer cancelled")
        return {"active": False}

    # Resolved before taking the lock, because these are network calls. Both are
    # best effort: the timer should still start and still stop playback when it
    # expires, even if OwnTone is unreachable at the moment it is set. Losing
    # them only costs the gentle fade over the last three minutes.
    start_volume = 20
    output_id = ""
    try:
        player = owntone_request("/player", timeout=4) or {}
        start_volume = max(0, min(100, int(player.get("volume", 20))))
    except (TypeError, ValueError, OSError) as exc:
        print(f"[sleep] could not read the current volume: {exc}", flush=True)
    try:
        output_id = _fade_output_id()
    except OSError as exc:
        print(f"[sleep] could not resolve the fade output: {exc}", flush=True)

    def begin(state):
        # sleep and sleep_output_id are written together. They used to be two
        # separate saves, and the scheduler loop could overwrite the second one
        # before sleep_tick ever read it — the fade then never started.
        state["sleep"] = {
            "id": uuid.uuid4().hex,
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


def _sleep_action(runtime: dict):
    entry = runtime.get("sleep")
    if not entry:
        return None
    try:
        started = datetime.fromisoformat(str(entry.get("start")))
        total_s = int(entry.get("duration_min") or 0) * 60
        elapsed = local_now().timestamp() - started.timestamp()
    except (TypeError, ValueError, OverflowError):
        return {"kind": "invalid"}
    remaining = total_s - elapsed
    if remaining <= 0:
        return {"kind": "stop", "path": "/player/stop"}
    output_id = str(runtime.get("sleep_output_id") or "")
    if total_s > 0 and remaining <= min(total_s, 180):
        start_volume = int(entry.get("start_volume") or 0)
        target = max(0, min(start_volume, round(start_volume * remaining / min(total_s, 180))))
        if target != int(entry.get("last_sent", -1)) and output_id:
            q = urlencode({"volume": target, "output_id": output_id})
            return {"kind": "fade", "path": f"/player/volume?{q}", "target": target}
    return None


@_serialized(PLAYBACK_LOCK)
def sleep_tick() -> bool:
    action = None

    def claim(state):
        nonlocal action
        action = _sleep_action(state)
        if action is None:
            return False
        entry = state["sleep"]
        # Migrate old timers once, before execution; identity survives restart.
        migrated = not entry.get("id")
        if migrated:
            entry["id"] = uuid.uuid4().hex
        action["timer_id"] = entry["id"]
        action["last_error"] = copy.deepcopy(state.get("last_error"))
        return migrated

    update_runtime_state(claim)
    if action is None:
        return False
    error = None
    if action["kind"] != "invalid":
        try:
            owntone_request(action["path"], "PUT")
            if action["kind"] == "stop":
                _forget_now_playing()
        except Exception as exc:
            error = exc

    def finish(state):
        entry = state.get("sleep") or {}
        if entry.get("id") != action["timer_id"]:
            return False
        if error is not None:
            # Failed fades are best effort; expiry stops retry on the next tick.
            if action["kind"] == "stop" and state.get("last_error") == action["last_error"]:
                return _record_last_error(state, f"sleep: {error}")
            return False
        if action["kind"] == "fade":
            entry["last_sent"] = action["target"]
        else:
            state.pop("sleep", None)
            if action["kind"] == "stop":
                log_activity("sleep", "🌙 Sleep timer finished — playback stopped")
        return True

    update_runtime_state(finish)
    return True


def list_stations() -> list[dict]:
    items = []
    if not STATIONS_DIR.is_dir():
        return items
    for path in sorted(STATIONS_DIR.glob("*.m3u")):
        if path.is_symlink():
            continue
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


SLUG_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _'&()./-]{0,59}\Z")
URL_RE = re.compile(r"https?://[^\s\"<>]+\Z", re.IGNORECASE)


def _create_m3u(directory: Path, slug: str, text: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    counter = 1
    while True:
        target = directory / f"{slug}{'-' + str(counter) if counter > 1 else ''}.m3u"
        try:
            # 'x' is exclusive, including for dangling symlinks.
            with target.open("x", encoding="utf-8") as stream:
                stream.write(text)
            return target
        except FileExistsError:
            counter += 1


def create_station(name: str, url: str) -> dict:
    with FILES_LOCK:
        name = str(name or "").strip()
        url = str(url or "").strip()
        if not NAME_RE.match(name):
            raise ValueError("Invalid station name")
        if not URL_RE.match(url):
            raise ValueError("Stream URL must be http(s)")
        parsed = urlparse(url)
        if not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ValueError("Invalid stream URL")
        _ = parsed.port  # validate the port before creating the file
        slug = re.sub(r"[^a-z0-9_-]", "", name.lower().replace(" ", "_")).strip("_") or "station"
        target = _create_m3u(STATIONS_DIR, slug, f"#EXTM3U\n#EXTINF:-1,{name}\n{url}\n")
    rescan_library()
    log_activity("station", f"📻 Station added: {name}")
    return {"slug": re.sub(r"[^a-z0-9_-]", '', target.stem), "name": name, "url": url, "file": target.name}


def delete_station(slug: str) -> dict:
    with FILES_LOCK:
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
        if path == wanted:
            return str(playlist.get("uri") or "")
    raise ValueError(f"No OwnTone playlist found for {filename} under {STATIONS_DIR}")


@_serialized(PLAYBACK_LOCK)
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
    for station in _random.sample(stations, min(6, len(stations))):
        try:
            result = play_station(station["slug"], output_id=output_id)
            return dict(result, random=True)
        except Exception as exc:
            errors.append(str(exc))
    raise ValueError("; ".join(errors)[:240] or "Random play failed")


# ---------- editable playlists (plain .m3u files) ----------

LINE_RE = re.compile(r"(#.*|https?://\S+|/.+)\Z")


def _playlist_path(slug: str) -> Path:
    if not SLUG_RE.match(str(slug or "")):
        raise ValueError("Invalid playlist id")
    for path in PLAYLISTS_DIR.glob("*.m3u"):
        stem_slug = re.sub(r"[^a-z0-9_-]", '', path.stem.lower().replace(' ', '_'))
        if stem_slug == slug:
            if path.is_symlink():
                raise ValueError("Symlink playlists cannot be edited")
            return path
    raise ValueError("Playlist not found")


def list_playlists() -> list[dict]:
    items = []
    if not PLAYLISTS_DIR.is_dir():
        return items
    for path in sorted(PLAYLISTS_DIR.glob("*.m3u")):
        if path.is_symlink():
            continue
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
    with FILES_LOCK:
        name = str(name or "").strip()
        if not NAME_RE.match(name):
            raise ValueError("Invalid playlist name")
        slug = re.sub(r"[^a-z0-9_-]", "", name.lower().replace(" ", "_")).strip("_") or "playlist"
        target = _create_m3u(PLAYLISTS_DIR, slug, "#EXTM3U\n")
    rescan_library()
    log_activity("playlist", f"🎵 Playlist created: {name}")
    return {"slug": re.sub(r"[^a-z0-9_-]", '', target.stem), "name": name, "file": target.name}


def save_playlist_lines(slug: str, lines: list) -> dict:
    with FILES_LOCK:
        if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
            raise ValueError("lines must be an array of strings")
        path = _playlist_path(slug)
        cleaned = []
        for raw in lines or []:
            if any(ord(c) < 32 or ord(c) == 127 for c in raw):
                raise ValueError("Playlist entries must be single lines without control characters")
            line = str(raw).strip()
            if not line:
                continue
            # The #EXTM3U header is written below, so drop it from the payload —
            # otherwise saving a playlist that was read back gains a second header
            # every time.
            if line.upper() == "#EXTM3U":
                continue
            if not LINE_RE.match(line):
                raise ValueError(f"Line must be a URL, a /path, or a # comment: {line[:60]}")
            cleaned.append(line)
        _atomic_text(path, "#EXTM3U\n" + "\n".join(cleaned) + "\n")
    rescan_library()
    log_activity("playlist", f"✏️ Playlist saved: {path.stem} ({len(cleaned)} tracks)")
    return {"ok": True, "track_count": len(cleaned)}


def delete_playlist(slug: str) -> dict:
    with FILES_LOCK:
        path = _playlist_path(slug)
        path.unlink()
    rescan_library()
    log_activity("playlist", f"🗑 Playlist deleted: {path.stem}")
    return {"ok": True}


def _record_last_error(state: dict, message: str) -> bool:
    state["last_error"] = {"at": local_now().isoformat(), "message": message}
    return True


def _claim_schedule_action(schedule_id: str, kind: str, now: datetime):
    """Commit one action under LOCK; PLAYBACK_LOCK is owned by the caller.

    Claim is the cancellation boundary. Edits may finish while its network
    operation is in flight, but cannot retract that operation. A stale result
    cannot change the edited/deleted schedule's state. Start claims consume an
    occurrence on disk before any I/O, including on failure or process restart.
    """
    action = None

    def claim(state):
        nonlocal action
        items, _, item = find_schedule(schedule_id)
        if item is None:
            return False
        if not item.get("generation") or not item.get("revision"):
            # Establish stable ownership for legacy rows before a claim can
            # race with their first HTTP edit. This write also precedes I/O.
            save_schedules(items)
        owners = state.setdefault("schedule_generations", {})
        generation = item.get("generation", "")
        dirty = owners.get(schedule_id) != generation
        if schedule_id in owners and dirty:
            # A deleted ID can be recreated before a prior state cleanup, or
            # the process can restart between the two atomic file writes.
            for field in ("runs", "stops", "bumps", "run_started"):
                state.setdefault(field, {}).pop(schedule_id, None)
        owners[schedule_id] = generation
        if not item.get("enabled"):
            return dirty
        runs = state["runs"]
        key = ""
        extra = {}
        if kind == "start":
            occurrence = _schedule_occurrence(item, now)
            key = occurrence.strftime("%Y-%m-%dT%H:%M") if occurrence else ""
            if not key or runs.get(schedule_id) == key:
                return dirty
            runs[schedule_id] = key
            state["bumps"][schedule_id] = key
            state["run_started"].pop(schedule_id, None)
            dirty = True
            deadline = _stop_for_start(item, occurrence)
            if deadline and local_now().timestamp() >= deadline.timestamp():
                return True
        elif kind == "ramp":
            extra = _volume_bump_action(item, state)
            if extra is None:
                return dirty
            key = extra["key"]
        else:
            occurrence = _schedule_occurrence(item, now, "stop_time") if item.get("stop_time") else None
            key = occurrence.strftime("%Y-%m-%dT%H:%M") if occurrence else ""
            if not key or state["stops"].get(schedule_id) == key:
                return dirty
        action = {"kind": kind, "item": copy.deepcopy(item), "key": key,
                  "run_key": runs.get(schedule_id),
                  "last_error": copy.deepcopy(state.get("last_error")), **extra}
        return dirty

    # Failure to persist the claim propagates; no action is returned/executed.
    update_runtime_state(claim)
    return action


def _execute_schedule_action(action):
    """Only playback/network effects; never called inside a state update."""
    if action["kind"] == "start":
        return execute_schedule(action["item"])
    if action["kind"] == "stop":
        return stop_playback(action["item"])
    owntone_request(action["path"], "PUT")
    return {}


def _finalize_schedule_action(action, result, error, completed_at):
    def finish(state):
        item = action["item"]
        schedule_id = item["id"]
        _, _, current = find_schedule(schedule_id)
        # Full equality also detects hand-edited files retaining a revision.
        if current != item or state["runs"].get(schedule_id) != action["run_key"]:
            return False
        if state["schedule_generations"].get(schedule_id) != item.get("generation", ""):
            return False
        kind = action["kind"]
        if error is None:
            if kind == "start":
                state["run_started"][schedule_id] = {
                    "key": action["key"], "at": completed_at,
                    "revision": item.get("revision", ""),
                }
                state["bumps"].pop(schedule_id, None)
                log_activity("schedule", f"⏰ {item.get('name')}: {(result or {}).get('message', '')}")
            elif kind == "ramp":
                state["bumps"][schedule_id] = action["key"]
            else:
                state["stops"][schedule_id] = action["key"]
                state["bumps"][schedule_id] = action["run_key"] or ""
            if kind != "ramp" and state.get("last_error") == action["last_error"]:
                state["last_error"] = None
        else:
            if state.get("last_error") == action["last_error"]:
                state["last_error"] = {
                    "at": completed_at, "schedule": schedule_id,
                    "message": ("ramp: " if kind == "ramp" else "") + str(error),
                }
            if kind == "start":
                log_activity("error", f"⏰ {item.get('name')}: {error}")
        return True

    update_runtime_state(finish)


@_serialized(PLAYBACK_LOCK)
def _run_due_schedules(now: datetime) -> bool:
    dirty = False
    # Snapshot IDs only; each action reloads its current configuration/state.
    for schedule_id in [item["id"] for item in load_schedules()]:
        for kind in ("start", "ramp", "stop"):
            action = _claim_schedule_action(schedule_id, kind, now)
            if action is None:
                continue
            result, error = None, None
            try:
                result = _execute_schedule_action(action)
            except Exception as exc:
                error = exc
            # Do not catch persistence errors as playback failures. In
            # particular, never enable a ramp unless success was persisted.
            _finalize_schedule_action(action, result, error, local_now().isoformat())
            dirty = True
    return dirty


@_serialized(PLAYBACK_LOCK)
def scheduler_tick():
    # Lock order is PLAYBACK_LOCK then brief LOCK transactions. No state frame
    # spans network work; history and HTTP state writers remain responsive.
    due = _run_due_schedules(local_now())
    try:
        slept = sleep_tick()
    except Exception as exc:
        update_runtime_state(partial(_record_last_error, message=f"sleep: {exc}"))
        slept = True
    return due or slept


def scheduler_loop():
    while True:
        try:
            scheduler_tick()
        except Exception as exc:
            message = str(exc)
            print(f"[scheduler] tick failed: {message}", flush=True)
            with contextlib.suppress(OSError):
                update_runtime_state(partial(_record_last_error, message=message))
        time.sleep(15)


class Handler(BaseHTTPRequestHandler):
    server_version = "OwnToneDashboardCompanion/1.1"
    # HTTP/1.0 (the default) closes the socket after every response, and the
    # dashboard polls several endpoints from every open device.
    protocol_version = "HTTP/1.1"
    # Without this, a client that announces a Content-Length and then sends
    # nothing keeps a worker thread blocked until TCP times out.
    timeout = 15

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
        # Validate every mutation, including bodyless play/stop/delete actions.
        # Close rejected requests: unread bytes must never become a second
        # HTTP/1.1 request on this connection.
        try:
            origin = self.headers.get("Origin")
            if len(self.headers.get_all("Origin", [])) > 1:
                raise ValueError("Multiple Origin headers")
            if origin is not None:
                parsed = urlparse(origin)
                host = urlparse("//" + self.headers.get("Host", ""))
                valid = (parsed.scheme in ("http", "https") and parsed.hostname
                         and parsed.username is None and parsed.password is None
                         and not parsed.path and not parsed.query and not parsed.fragment)
                # Older nginx configurations forward $host, dropping the
                # dashboard's :3690 port. Accept that one documented mapping.
                same = (parsed.hostname == host.hostname and
                        ((host.port is not None and parsed.netloc.lower() == host.netloc.lower()) or
                         (host.port is None and parsed.scheme == "http" and parsed.port == 3690)))
                if DASHBOARD_ORIGIN:
                    same = origin == DASHBOARD_ORIGIN
                if not valid or not same:
                    raise ValueError("Cross-origin mutation forbidden")
            if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
                raise ValueError("Cross-site mutation forbidden")
            if self.headers.get_all("Transfer-Encoding"):
                raise ValueError("Transfer-Encoding is not supported")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]+", lengths[0])):
                raise ValueError("Invalid Content-Length")
            length = int(lengths[0]) if lengths else 0
            if length > 256 * 1024:
                raise ValueError("Request body too large")
            types = self.headers.get_all("Content-Type", [])
            if len(types) > 1 or ((length or types) and
                    self.headers.get_content_type().lower() != "application/json"):
                raise ValueError("Content-Type must be application/json")
            raw = self.rfile.read(length) if length else b"{}"
            if len(raw) != length and length:
                raise ValueError("Incomplete request body")
            def invalid_constant(value):
                raise ValueError(f"Invalid JSON constant: {value}")
            body = json.loads(raw.decode("utf-8"), parse_constant=invalid_constant)
            if not isinstance(body, dict):
                raise ValueError("Request body must be a JSON object")
            return body
        except Exception:
            self.close_connection = True
            raise

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

    def _mutation(self, method):
        try:
            body = self._body()
            path = urlparse(self.path).path
            parts = path.strip("/").split("/")
            if path != "/" + "/".join(parts) or any(not part for part in parts):
                self._send(404, {"error": "Not found"})
                return
            self._handle_mutation(method, path, parts, body)
        except Exception as exc:
            self.log_message("%s %s failed: %s", method, self.path, exc)
            self._send(400, {"error": str(exc)})

    def do_POST(self):
        self._mutation("POST")

    def do_PUT(self):
        self._mutation("PUT")

    def do_DELETE(self):
        self._mutation("DELETE")

    def _handle_mutation(self, method, path, parts, body):
        if method == "POST":
            if path == "/schedules":
                item = clean_schedule(dict(body, revision=uuid.uuid4().hex, generation=uuid.uuid4().hex))
                with LOCK:
                    items = load_schedules()
                    if any(old["id"] == item["id"] for old in items):
                        raise ValueError("Schedule id already exists")
                    items.append(item)
                    save_schedules(items)
                self._send(201, item)
                return
            if len(parts) == 3 and parts[0] == "schedules" and parts[2] == "run":
                with PLAYBACK_LOCK:
                    _, _, item = find_schedule(parts[1])
                    if item is None:
                        self._send(404, {"error": "Schedule not found"})
                        return
                    result = execute_schedule(item)
                self._send(200, result)
                return
            if path == "/sleep":
                self._send(200, start_sleep(_integer(body.get("minutes", 0), "minutes")))
                return
            if path == "/stations":
                self._send(201, create_station(body.get("name"), body.get("url")))
                return
            if path == "/playlists":
                self._send(201, create_playlist(body.get("name")))
                return
            if path == "/playback/stop":
                with PLAYBACK_LOCK:
                    owntone_request("/player/stop", "PUT")
                    _forget_now_playing()
                    log_activity("station", "⏹ Playback stopped")
                self._send(200, {"ok": True})
                return
            if len(parts) == 3 and parts[0] == "stations" and parts[2] == "play":
                output_id = body.get("output_id", "")
                if isinstance(output_id, bool) or not isinstance(output_id, (str, int)):
                    raise ValueError("output_id must be a string or integer")
                if parts[1] == "random":
                    result = play_random_station(output_id=str(output_id))
                else:
                    result = play_station(parts[1], output_id=str(output_id))
                self._send(200, result)
                return
        if len(parts) == 2:
            kind, item_id = parts
            if kind == "playlists":
                if method == "PUT":
                    self._send(200, save_playlist_lines(item_id, body.get("lines", [])))
                    return
                if method == "DELETE":
                    self._send(200, delete_playlist(item_id))
                    return
            if kind == "stations" and method == "DELETE":
                self._send(200, delete_station(item_id))
                return
            if kind == "schedules" and method in ("PUT", "DELETE"):
                with LOCK:
                    items, index, old = find_schedule(item_id)
                    if old is not None:
                        if method == "PUT":
                            item = clean_schedule(dict(old, **body), existing_id=item_id)
                            item["generation"] = old.get("generation") or uuid.uuid4().hex
                            item["revision"] = uuid.uuid4().hex
                            items[index] = item
                            result = item
                        else:
                            del items[index]
                            result = {"ok": True}
                        save_schedules(items)
                        if method == "DELETE":
                            def forget(state):
                                for key in ("runs", "stops", "bumps", "run_started"):
                                    state.setdefault(key, {}).pop(item_id, None)
                            update_runtime_state(forget)
                if old is None:
                    self._send(404, {"error": "Schedule not found"})
                else:
                    self._send(200, result)
                return
        self._send(404, {"error": "Not found"})


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
