"""
Unit tests for the companion service's pure logic.

Standard library only, to match the service itself:

    python3 -m unittest discover -s scheduler -p 'test_*.py'

These cover the parts that decide *when* something plays and *how loud* — the
places where a bug is expensive and a test is cheap.
"""

import io
import json
import os
import socket
import stat
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
import re
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

# The service reads its configuration from the environment at import time.
os.environ.setdefault("TZ", "Europe/Belgrade")
os.environ.setdefault("OWNTONE_SCHEDULER_DATA", str(Path(__file__).parent / ".test-data"))
sys.path.insert(0, str(Path(__file__).parent))

import scheduler_server as srv

# Fail closed if a test accidentally reaches any real service or DNS resolver.
_NETWORK_PATCHES = []


def setUpModule():
    for patch in (
        mock.patch.object(srv, "urlopen", side_effect=AssertionError("real HTTP forbidden")),
        mock.patch.object(srv.socket, "getaddrinfo", side_effect=AssertionError("real DNS forbidden")),
        mock.patch.object(srv.socket, "create_connection", side_effect=AssertionError("real sockets forbidden")),
    ):
        patch.start()
        _NETWORK_PATCHES.append(patch)


def tearDownModule():
    for patch in reversed(_NETWORK_PATCHES):
        patch.stop()


ZONE = ZoneInfo("Europe/Belgrade")


def at(year, month, day, hour, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=ZONE)


def schedule(**overrides):
    base = {
        "id": "s1",
        "name": "Morning",
        "enabled": True,
        "time": "07:30",
        "days": ["mon", "tue", "wed", "thu", "fri"],
        "kind": "playlist",
        "source_uri": "library:playlist:3",
        "source_name": "Morning",
        "output_id": "hp",
        "output_name": "HomePod",
        "volume": 40,
    }
    base.update(overrides)
    return base


class ParseTime(unittest.TestCase):
    def test_accepts_valid_times(self):
        self.assertEqual(srv._parse_hhmm("00:00"), (0, 0))
        self.assertEqual(srv._parse_hhmm("07:30"), (7, 30))
        self.assertEqual(srv._parse_hhmm("23:59"), (23, 59))

    def test_rejects_anything_else(self):
        for value in ["24:00", "7:30", "07:60", "", None, "abc", "07:30:00"]:
            self.assertIsNone(srv._parse_hhmm(value), value)


class NextRun(unittest.TestCase):
    def test_finds_today_when_the_time_is_still_ahead(self):
        # Monday 2026-08-24, 06:00 -> today at 07:30
        self.assertEqual(srv.next_run(schedule(), at(2026, 8, 24, 6)), at(2026, 8, 24, 7, 30))

    def test_rolls_over_to_the_next_selected_day(self):
        # Friday 20:00 -> Monday, because the weekend is not selected
        self.assertEqual(srv.next_run(schedule(), at(2026, 8, 28, 20)), at(2026, 8, 31, 7, 30))

    def test_disabled_schedule_never_runs(self):
        self.assertIsNone(srv.next_run(schedule(enabled=False), at(2026, 8, 24, 6)))

    def test_malformed_time_returns_none_instead_of_raising(self):
        # A hand-edited schedules.json used to raise ValueError here and take
        # the whole GET /schedules response down with it.
        for bad in ["7:30", "", "nope", None]:
            self.assertIsNone(srv.next_run(schedule(time=bad), at(2026, 8, 24, 6)), bad)

    def test_keeps_wall_clock_time_across_the_autumn_dst_change(self):
        # Europe/Belgrade leaves DST in the early hours of 2026-10-25.
        # A schedule set for 07:30 must still be 07:30 local on either side —
        # datetime.now().astimezone() froze today's offset and shifted it.
        item = schedule(days=["mon", "tue", "wed", "thu", "fri", "sat", "sun"])

        before = srv.next_run(item, at(2026, 10, 23, 12))  # -> Sat 24 Oct, CEST
        after = srv.next_run(item, at(2026, 10, 26, 12))  # -> Tue 27 Oct, CET

        self.assertEqual((before.hour, before.minute), (7, 30))
        self.assertEqual((after.hour, after.minute), (7, 30))
        self.assertEqual(before.utcoffset(), timedelta(hours=2))
        self.assertEqual(after.utcoffset(), timedelta(hours=1))


class ScheduleOccurrence(unittest.TestCase):
    def test_fires_inside_the_grace_window(self):
        now = at(2026, 8, 24, 7, 45)  # 15 minutes late, grace is 30
        self.assertEqual(srv._schedule_occurrence(schedule(), now), at(2026, 8, 24, 7, 30))

    def test_does_not_fire_once_the_grace_window_has_passed(self):
        now = at(2026, 8, 24, 9, 0)  # 90 minutes late
        self.assertIsNone(srv._schedule_occurrence(schedule(), now))

    def test_ignores_days_that_are_not_selected(self):
        saturday = at(2026, 8, 29, 7, 40)
        self.assertIsNone(srv._schedule_occurrence(schedule(), saturday))

    def test_reads_the_stop_time_field(self):
        item = schedule(stop_time="08:15")
        now = at(2026, 8, 24, 8, 20)
        self.assertEqual(srv._schedule_occurrence(item, now, "stop_time"), at(2026, 8, 24, 8, 15))


class NightWindow(unittest.TestCase):
    def test_window_that_crosses_midnight(self):
        with mock.patch.object(srv, "NIGHT_START", 22), mock.patch.object(srv, "NIGHT_END", 8):
            self.assertTrue(srv._night_window(at(2026, 8, 24, 23)))
            self.assertTrue(srv._night_window(at(2026, 8, 24, 3)))
            self.assertFalse(srv._night_window(at(2026, 8, 24, 12)))

    def test_window_inside_one_day(self):
        with mock.patch.object(srv, "NIGHT_START", 0), mock.patch.object(srv, "NIGHT_END", 8):
            self.assertTrue(srv._night_window(at(2026, 8, 24, 3)))
            self.assertFalse(srv._night_window(at(2026, 8, 24, 9)))
            self.assertFalse(srv._night_window(at(2026, 8, 24, 23)))

    def test_equal_bounds_mean_always_on(self):
        with mock.patch.object(srv, "NIGHT_START", 5), mock.patch.object(srv, "NIGHT_END", 5):
            self.assertTrue(srv._night_window(at(2026, 8, 24, 12)))


class NightCappedVolume(unittest.TestCase):
    """
    The cap has to hold for the delayed ramp too, not just the opening volume.

    execute_schedule used to cap `ramp_volume` into a local it never used, while
    schedule_volume_bump read the raw field — so a 06:00 wake-up with
    respect_night_cap started at the cap and then jumped to full volume ten
    minutes later, still inside the night window.
    """

    def setUp(self):
        patches = [
            mock.patch.object(srv, "NIGHT_START", 0),
            mock.patch.object(srv, "NIGHT_END", 8),
            mock.patch.object(srv, "NIGHT_MAX", 8),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_caps_inside_the_night_window(self):
        item = schedule(respect_night_cap=True)
        self.assertEqual(srv.night_capped(60, item, at(2026, 8, 24, 6)), (8, True))

    def test_leaves_a_quieter_volume_alone(self):
        item = schedule(respect_night_cap=True)
        self.assertEqual(srv.night_capped(5, item, at(2026, 8, 24, 6)), (5, False))

    def test_does_nothing_outside_the_night_window(self):
        item = schedule(respect_night_cap=True)
        self.assertEqual(srv.night_capped(60, item, at(2026, 8, 24, 14)), (60, False))

    def test_does_nothing_when_the_schedule_opted_out(self):
        item = schedule(respect_night_cap=False)
        self.assertEqual(srv.night_capped(60, item, at(2026, 8, 24, 6)), (60, False))


class RampBump(unittest.TestCase):
    """schedule_volume_bump is the call that actually reaches OwnTone."""

    def setUp(self):
        for patch in (
            mock.patch.object(srv, "NIGHT_START", 0),
            mock.patch.object(srv, "NIGHT_END", 8),
            mock.patch.object(srv, "NIGHT_MAX", 8),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def _bump_volume(self, item, now):
        """Run the bump with the clock frozen; return the volume it sent."""
        runtime = {"runs": {"s1": "2026-08-24T06:00"}}
        with (
            mock.patch.object(srv, "local_now", return_value=now),
            mock.patch.object(srv, "owntone_request") as request,
        ):
            self.assertTrue(srv.schedule_volume_bump(item, runtime))
        path = request.call_args[0][0]
        return int(re.search(r"volume=(\d+)", path).group(1))

    def test_ramp_is_capped_while_it_is_still_night(self):
        item = schedule(ramp_minutes=10, ramp_volume=60, respect_night_cap=True)
        self.assertEqual(self._bump_volume(item, at(2026, 8, 24, 6, 15)), 8)

    def test_ramp_runs_at_full_volume_once_the_night_is_over(self):
        item = schedule(ramp_minutes=180, ramp_volume=60, respect_night_cap=True)
        self.assertEqual(self._bump_volume(item, at(2026, 8, 24, 9, 5)), 60)

    def test_ramp_is_untouched_without_the_flag(self):
        item = schedule(ramp_minutes=10, ramp_volume=60, respect_night_cap=False)
        self.assertEqual(self._bump_volume(item, at(2026, 8, 24, 6, 15)), 60)


class CleanSchedule(unittest.TestCase):
    def test_fills_in_defaults_and_keeps_the_id(self):
        item = srv.clean_schedule(schedule(), existing_id="keep-me")
        self.assertEqual(item["id"], "keep-me")
        self.assertEqual(item["days"], ["mon", "tue", "wed", "thu", "fri"])
        self.assertEqual(item["volume"], 40)
        self.assertFalse(item["respect_night_cap"])

    def test_clamps_volume_into_range(self):
        self.assertEqual(srv.clean_schedule(schedule(volume=500))["volume"], 100)
        self.assertEqual(srv.clean_schedule(schedule(volume=-5))["volume"], 0)

    def test_orders_days_and_drops_unknown_ones(self):
        item = srv.clean_schedule(schedule(days=["sun", "notaday", "mon"]))
        self.assertEqual(item["days"], ["mon", "sun"])

    def test_rejects_invalid_input(self):
        for bad, message in [
            (schedule(time="25:00"), "Invalid time"),
            (schedule(stop_time="99:99"), "Invalid stop_time"),
            (schedule(days=[]), "at least one day"),
            (schedule(days="mon"), "days must be an array"),
            (schedule(kind="podcast"), "kind must be"),
            (schedule(source_uri=""), "source_uri"),
            (schedule(output_id=""), "output_id"),
        ]:
            with self.assertRaises(ValueError) as caught:
                srv.clean_schedule(bad)
            self.assertIn(message, str(caught.exception))

    def test_truncates_long_free_text(self):
        item = srv.clean_schedule(schedule(name="x" * 500, source_name="y" * 500))
        self.assertEqual(len(item["name"]), 120)
        self.assertEqual(len(item["source_name"]), 160)


class RadioPlaylistDetection(unittest.TestCase):
    def test_path_hint_wins(self):
        self.assertTrue(srv._is_radio_playlist({"path": "/media/music/Radio/KEXP.m3u", "name": "KEXP"}))

    def test_name_hint_matches_whole_words_only(self):
        with mock.patch.object(srv, "RADIO_NAME_HINTS", ["radio"]):
            self.assertTrue(srv._is_radio_playlist({"name": "Rock Radio", "path": "/music/x.m3u"}))
            # "Radiohead" is a band, not a station — the old substring match got this wrong
            self.assertFalse(srv._is_radio_playlist({"name": "Radiohead", "path": "/music/x.m3u"}))

    def test_unconfigured_names_are_not_stations(self):
        with mock.patch.object(srv, "RADIO_NAME_HINTS", ["radio"]):
            self.assertFalse(srv._is_radio_playlist({"name": "S1", "path": "/music/albums/S1.m3u"}))


class StationFileValidation(unittest.TestCase):
    def test_slug_pattern(self):
        self.assertTrue(srv.SLUG_RE.match("naxi-radio"))
        self.assertTrue(srv.SLUG_RE.match("s1"))
        for bad in ["../etc", "Naxi", "-lead", "a" * 65, ""]:
            self.assertIsNone(srv.SLUG_RE.match(bad), bad)

    def test_stream_url_must_be_http(self):
        self.assertTrue(srv.URL_RE.match("https://stream.example/live"))
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "/local/path", ""]:
            self.assertIsNone(srv.URL_RE.match(bad), bad)

    def test_playlist_line_pattern(self):
        self.assertTrue(srv.LINE_RE.match("#EXTM3U"))
        self.assertTrue(srv.LINE_RE.match("https://stream.example/live"))
        self.assertTrue(srv.LINE_RE.match("/media/music/track.flac"))
        self.assertIsNone(srv.LINE_RE.match("relative/path.flac"))


class PlaylistWriting(unittest.TestCase):
    """save_playlist_lines writes the file; check what lands in it."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        target = Path(directory.name) / "Evening.m3u"
        target.write_text("#EXTM3U\n")
        self.target = target
        for patch in (
            mock.patch.object(srv, "_playlist_path", lambda slug: target),
            mock.patch.object(srv, "rescan_library"),
            mock.patch.object(srv, "log_activity"),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def test_writes_one_header_and_the_lines(self):
        srv.save_playlist_lines("evening", ["https://stream.example/x", "/media/music/a.flac"])
        self.assertEqual(
            self.target.read_text().splitlines(), ["#EXTM3U", "https://stream.example/x", "/media/music/a.flac"]
        )
        self.assertTrue(self.target.read_text().endswith(os.linesep) or self.target.read_text()[-1] == "\n")

    def test_does_not_duplicate_a_header_sent_back_by_the_client(self):
        # Saving a playlist that was just read used to gain a second #EXTM3U.
        srv.save_playlist_lines("evening", ["#EXTM3U", "https://stream.example/x"])
        self.assertEqual(self.target.read_text().count("#EXTM3U"), 1)

    def test_rejects_a_relative_path(self):
        with self.assertRaises(ValueError):
            srv.save_playlist_lines("evening", ["../../etc/passwd"])


class RuntimeStateUpdates(unittest.TestCase):
    """update_runtime_state must not lose a concurrent writer's fields."""

    def setUp(self):
        self.state = {"runs": {}, "stops": {}, "last_error": None}
        self.saved = []
        patches = [
            mock.patch.object(srv, "load_runtime_state", lambda: dict(self.state)),
            mock.patch.object(srv, "_atomic_write", lambda path, value: self.saved.append(value)),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_writes_the_mutated_state(self):
        srv.update_runtime_state(lambda state: state.update({"sleep_output_id": "hp"}) or True)
        self.assertEqual(self.saved[-1]["sleep_output_id"], "hp")

    def test_returning_false_skips_the_write(self):
        srv.update_runtime_state(lambda state: False)
        self.assertEqual(self.saved, [])

    def test_a_nested_update_lands_in_the_same_write(self):
        # A schedule run mutates the state and also calls log_activity, which is
        # itself an update. If the inner call did its own read-modify-write, the
        # outer write would overwrite it.
        def outer(state):
            state["runs"] = {"s1": "2026-08-24T07:30"}
            srv.update_runtime_state(lambda inner: inner.setdefault("activity", []).append("x") or True)
            return True

        srv.update_runtime_state(outer)
        self.assertEqual(len(self.saved), 1, "expected exactly one write")
        self.assertEqual(self.saved[-1]["runs"], {"s1": "2026-08-24T07:30"})
        self.assertEqual(self.saved[-1]["activity"], ["x"])

    def test_a_nested_change_still_writes_when_the_outer_reports_nothing(self):
        # The scheduler tick reports "nothing changed" on a quiet minute, but a
        # nested log_activity may still have recorded something.
        def outer(state):
            srv.update_runtime_state(lambda inner: inner.setdefault("activity", []).append("y") or True)
            return False

        srv.update_runtime_state(outer)
        self.assertEqual(len(self.saved), 1)
        self.assertEqual(self.saved[-1]["activity"], ["y"])

    def test_each_update_starts_from_the_stored_state(self):
        # The scheduler loop used to hold a copy for 15 s and write it back,
        # dropping whatever the history thread had recorded meanwhile.
        srv.update_runtime_state(lambda state: state.update({"a": 1}) or True)
        self.state["b"] = 2  # another writer, between the two updates
        srv.update_runtime_state(lambda state: state.update({"c": 3}) or True)
        self.assertEqual(self.saved[-1]["b"], 2)
        self.assertEqual(self.saved[-1]["c"], 3)


class LibraryStats(unittest.TestCase):
    def test_counts_and_ranks_recent_plays(self):
        now = srv.local_now()
        history = [
            {"played_at": now.isoformat(), "is_radio": True, "station_name": "KEXP"},
            {"played_at": now.isoformat(), "is_radio": True, "station_name": "KEXP"},
            {"played_at": (now - timedelta(days=1)).isoformat(), "is_radio": False, "artist": "Air"},
            {"played_at": (now - timedelta(days=99)).isoformat(), "is_radio": False, "artist": "Old"},
        ]
        with mock.patch.object(srv, "load_history", lambda: history):
            stats = srv.library_stats(30)
        self.assertEqual(stats["total_plays"], 3)
        self.assertEqual(stats["radio_plays"], 2)
        self.assertEqual(stats["top_stations"][0], {"name": "KEXP", "count": 2})
        self.assertEqual([a["name"] for a in stats["top_artists"]], ["Air"])

    def test_ignores_unknown_artist_placeholder(self):
        now = srv.local_now()
        history = [{"played_at": now.isoformat(), "is_radio": False, "artist": "Unknown artist"}]
        with mock.patch.object(srv, "load_history", lambda: history):
            stats = srv.library_stats(30)
        self.assertEqual(stats["top_artists"], [])




class IsolatedTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for field, name in (
            ('SCHEDULES_FILE', 'schedules.json'), ('STATE_FILE', 'state.json'),
            ('HISTORY_FILE', 'history.json'), ('PLAYLISTS_DIR', 'playlists'),
            ('STATIONS_DIR', 'stations'),
        ):
            patch = mock.patch.object(srv, field, self.root / name)
            patch.start()
            self.addCleanup(patch.stop)
        for patch in (
            mock.patch.object(srv, 'LOCAL_ZONE', ZONE),
            mock.patch.object(srv, 'GRACE_MINUTES', 30),
            mock.patch.object(srv, 'DASHBOARD_ORIGIN', ''),
            mock.patch.object(srv, 'rescan_library'),
        ):
            patch.start()
            self.addCleanup(patch.stop)


class HTTPRequests(IsolatedTestCase):
    class Socket:
        def __init__(self, incoming):
            self.input = io.BytesIO(incoming)
            self.output = io.BytesIO()

        def makefile(self, *args):
            return self.input

        def sendall(self, data):
            self.output.write(data)

        def settimeout(self, timeout):
            pass

    def request(self, method, path, body=None, headers=None, tail=b''):
        payload = json.dumps(body).encode() if body is not None else b''
        lines = [('Host', 'dashboard.local:3690')]
        if headers is None:
            lines += [('Content-Length', str(len(payload))), ('Content-Type', 'application/json')]
        else:
            lines += headers
        raw = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in lines) + '\r\n'
        client = self.Socket(raw.encode() + payload + tail)
        class QuietHandler(srv.Handler):
            def log_message(self, *args):
                pass
        handler = QuietHandler(client, ('127.0.0.1', 12345), mock.Mock())
        response = client.output.getvalue()
        head, content = response.split(b'\r\n\r\n', 1)
        return int(head.split()[1]), content, handler

    def test_create_update_delete_round_trip(self):
        self.assertEqual(self.request('POST', '/schedules', schedule())[0], 201)
        status, content, _ = self.request('PUT', '/schedules/s1', {'volume': 12})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(content)['volume'], 12)
        self.assertEqual(self.request('DELETE', '/schedules/s1')[0], 200)
        self.assertEqual(srv.load_schedules(), [])

    def test_duplicate_ids_do_not_alias_existing_schedule(self):
        self.assertEqual(self.request('POST', '/schedules', schedule())[0], 201)
        self.assertEqual(self.request('POST', '/schedules', schedule(name='Other'))[0], 400)
        self.assertEqual(len(srv.load_schedules()), 1)

    def test_invalid_routes_cannot_update_or_delete_a_schedule(self):
        srv.save_schedules([schedule()])
        for method in ('PUT', 'DELETE'):
            for path in ('/stations/s1', '/schedules/s1/run', '/schedules/s1/extra', '/schedules//s1'):
                with self.subTest(method=method, path=path):
                    self.request(method, path, {'name': 'Overwritten'})
                    self.assertEqual(srv.load_schedules()[0]['name'], 'Morning')

    def test_csrf_covers_bodyless_actions_and_delete(self):
        srv.save_schedules([schedule()])
        with mock.patch.object(srv, 'execute_schedule') as play, mock.patch.object(srv, 'owntone_request') as api:
            for method, path in (
                ('POST', '/schedules/s1/run'), ('POST', '/playback/stop'), ('DELETE', '/schedules/s1')
            ):
                self.assertEqual(self.request(method, path, headers=[('Origin', 'https://attacker.example')])[0], 400)
            play.assert_not_called()
            api.assert_not_called()
        self.assertEqual(len(srv.load_schedules()), 1)

    def test_origin_checks_host_port_and_null(self):
        for origin in ('http://dashboard.local:3691', 'null', 'http://dashboard.local.attacker:3690',
                       'http://user@dashboard.local:3690', 'http://dashboard.local:3690/path'):
            with self.subTest(origin=origin):
                self.assertEqual(self.request('POST', '/sleep', headers=[('Origin', origin)])[0], 400)
        self.assertEqual(self.request('POST', '/sleep', headers=[('Origin', 'http://dashboard.local:3690')])[0], 200)

    def test_bundled_proxy_stripped_port_mapping_is_explicit(self):
        handler = object.__new__(srv.Handler)
        from email.message import Message
        handler.headers = Message()
        handler.headers['Host'] = 'dashboard.local'
        handler.headers['Origin'] = 'http://dashboard.local:3690'
        handler.rfile = io.BytesIO(b'')
        self.assertEqual(handler._body(), {})
        for origin in ('http://dashboard.local:9999', 'http://dashboard.local'):
            handler.headers.replace_header('Origin', origin)
            with self.assertRaises(ValueError):
                handler._body()

    def test_bodyless_native_bridge_requests_still_work(self):
        with mock.patch.object(srv, 'owntone_request') as api:
            self.assertEqual(self.request('POST', '/playback/stop', headers=[])[0], 200)
            api.assert_called_once_with('/player/stop', 'PUT')

    def test_custom_proxy_origin_is_an_exact_operator_setting(self):
        with mock.patch.object(srv, 'DASHBOARD_ORIGIN', 'https://music.example'):
            self.assertEqual(self.request('POST', '/sleep', headers=[('Origin', 'https://music.example')])[0], 200)
            for origin in ('http://music.example', 'https://music.example:9999', 'http://dashboard.local:3690'):
                self.assertEqual(self.request('POST', '/sleep', headers=[('Origin', origin)])[0], 400)

    def test_rejects_invalid_framing_without_reading_next_request(self):
        invalid = [
            [('Content-Length', '-1')], [('Content-Length', 'NaN')],
            [('Content-Length', '262145')], [('Content-Length', '0'), ('Content-Length', '0')],
            [('Transfer-Encoding', 'chunked')], [('Content-Type', 'text/plain')],
            [('Sec-Fetch-Site', 'cross-site')],
        ]
        for headers in invalid:
            with self.subTest(headers=headers):
                status, content, handler = self.request('POST', '/sleep', headers=headers,
                    tail=b'GET /health HTTP/1.1\r\nHost: dashboard.local\r\n\r\n')
                self.assertEqual(status, 400)
                self.assertTrue(handler.close_connection)
                self.assertNotIn(b'HTTP/1.1', content)

    def test_body_must_be_complete_json_object_and_finite(self):
        for body in ([], 'text', 4, {'minutes': float('inf')}, {'minutes': True}, {'minutes': 2.5}):
            with self.subTest(body=body):
                self.assertEqual(self.request('POST', '/sleep', body)[0], 400)
        self.assertEqual(self.request('POST', '/sleep', {}, headers=[
            ('Content-Length', '20'), ('Content-Type', 'application/json')])[0], 400)

    def test_bodyless_run_consumes_json_before_next_keepalive_request(self):
        srv.save_schedules([schedule()])
        with mock.patch.object(srv, 'execute_schedule', return_value={'ok': True}):
            status, content, _ = self.request('POST', '/schedules/s1/run', {},
                tail=b'GET /health HTTP/1.1\r\nHost: dashboard.local\r\n\r\n')
        self.assertEqual(status, 200)
        self.assertIn(b'HTTP/1.1 200', content)

    def test_concurrent_creates_and_partial_updates_are_not_lost(self):
        original_load = srv.load_schedules
        def slow_load():
            result = original_load()
            time.sleep(0.003)  # expose the old gap between separate load/save locks
            return result
        with mock.patch.object(srv, 'load_schedules', side_effect=slow_load):
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(self.request, 'POST', '/schedules', schedule(id=f's{i}')) for i in range(16)]
                self.assertTrue(all(f.result(timeout=5)[0] == 201 for f in futures))
            self.assertEqual(len(original_load()), 16)
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(self.request, 'PUT', '/schedules/s1', body)
                           for body in ({'volume': 17}, {'name': 'Updated'})]
                self.assertTrue(all(f.result(timeout=5)[0] == 200 for f in futures))
        item = next(item for item in original_load() if item['id'] == 's1')
        self.assertEqual((item['volume'], item['name']), (17, 'Updated'))


class CalendarRegressions(IsolatedTestCase):
    def test_rejects_trailing_newline_and_unicode_digits(self):
        for value in ('07:30\n', '0\uff17:30', '07:3\uff10'):
            self.assertIsNone(srv._parse_hhmm(value))
            with self.assertRaises(ValueError):
                srv.clean_schedule(schedule(time=value))

    def test_nonexistent_time_normalizes_to_real_instant(self):
        item = schedule(time='02:30', days=['sun'])
        result = srv.next_run(item, at(2026, 3, 29, 1))
        self.assertEqual(result, at(2026, 3, 29, 3, 30))
        self.assertEqual(srv._schedule_occurrence(item, at(2026, 3, 29, 3, 35)), result)

    def test_autumn_fold_does_not_refire_or_compare_in_wall_time(self):
        item = schedule(time='02:30', days=['sun'])
        second = at(2026, 10, 25, 2, 15).replace(fold=1)
        self.assertIsNone(srv._schedule_occurrence(item, second))  # first 02:30 was 45 min ago
        self.assertEqual(srv.next_run(item, second), at(2026, 11, 1, 2, 30))

    def test_overnight_stop_follows_selected_start_day(self):
        item = schedule(time='23:30', stop_time='00:30', days=['mon'])
        self.assertEqual(srv._schedule_occurrence(item, at(2026, 8, 25, 0, 35), 'stop_time'), at(2026, 8, 25, 0, 30))
        self.assertIsNone(srv._schedule_occurrence(item, at(2026, 8, 24, 0, 35), 'stop_time'))

    def test_zero_grace_still_fires_during_scheduled_minute(self):
        now = at(2026, 8, 24, 7, 30).replace(second=17)
        with mock.patch.object(srv, 'GRACE_MINUTES', 0):
            self.assertEqual(srv._schedule_occurrence(schedule(), now), now.replace(second=0))

    def test_elapsed_ramp_minutes_across_dst(self):
        item = schedule(time='01:50', ramp_minutes=30, ramp_volume=45)
        runtime = {'runs': {'s1': '2026-03-29T01:50'}}
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 3, 29, 3, 20)),
                  mock.patch.object(srv, 'owntone_request') as api):
            self.assertTrue(srv.schedule_volume_bump(item, runtime))
            api.assert_called_once()


class SchedulerExecution(IsolatedTestCase):
    def run_tick(self, now, play=None, sleep=None):
        with mock.patch.object(srv, 'local_now', return_value=now), \
             mock.patch.object(srv, 'execute_schedule', **(play or {'return_value': {'ok': True}})) as execute, \
             mock.patch.object(srv, 'sleep_tick', **(sleep or {'return_value': False})), \
             mock.patch.object(srv, 'owntone_request'):
            srv.scheduler_tick()
        return execute

    def test_failed_sleep_does_not_replay_successful_schedule(self):
        srv.save_schedules([schedule()])
        self.run_tick(at(2026, 8, 24, 7, 31), sleep={'side_effect': OSError('offline')}).assert_called_once()
        self.run_tick(at(2026, 8, 24, 7, 32), sleep={'side_effect': OSError('offline')}).assert_not_called()
        state = srv.load_runtime_state()
        self.assertEqual(state['runs']['s1'], '2026-08-24T07:30')
        self.assertEqual(state['activity'][0]['kind'], 'schedule')

    def test_failed_run_never_arms_a_ramp(self):
        srv.save_schedules([schedule(ramp_minutes=5, ramp_volume=70)])
        self.run_tick(at(2026, 8, 24, 7, 30), play={'side_effect': OSError('offline')})
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 40)),
                  mock.patch.object(srv, 'owntone_request') as api):
            self.assertFalse(srv.schedule_volume_bump(srv.load_schedules()[0], srv.load_runtime_state()))
            api.assert_not_called()

    def test_late_run_ramp_uses_actual_start_time(self):
        srv.save_schedules([schedule(ramp_minutes=10, ramp_volume=70)])
        self.run_tick(at(2026, 8, 24, 7, 45))
        runtime = srv.load_runtime_state()
        with mock.patch.object(srv, 'owntone_request') as api:
            with mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 50)):
                self.assertFalse(srv.schedule_volume_bump(srv.load_schedules()[0], runtime))
            api.assert_not_called()
            with mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 55)):
                self.assertTrue(srv.schedule_volume_bump(srv.load_schedules()[0], runtime))

    def test_no_stale_ramp_or_ramp_after_stop(self):
        for item, now in ((schedule(ramp_minutes=10, ramp_volume=70), at(2026, 8, 25, 12)),
                          (schedule(ramp_minutes=10, ramp_volume=70, stop_time='07:35'), at(2026, 8, 24, 7, 40))):
            with (mock.patch.object(srv, 'local_now', return_value=now),
                  mock.patch.object(srv, 'owntone_request') as api):
                self.assertFalse(srv.schedule_volume_bump(item, {'runs': {'s1': '2026-08-24T07:30'}}))
                api.assert_not_called()

    def test_expired_schedule_does_not_briefly_start(self):
        srv.save_schedules([schedule(stop_time='07:35')])
        self.run_tick(at(2026, 8, 24, 7, 40)).assert_not_called()

    def test_malformed_rows_do_not_block_valid_rows_or_sleep(self):
        srv.SCHEDULES_FILE.write_text(json.dumps([None, {}, schedule(volume='bad'), schedule(id='good')]))
        self.run_tick(at(2026, 8, 24, 7, 31)).assert_called_once()
        self.assertEqual(srv.load_runtime_state()['runs'], {'good': '2026-08-24T07:30'})

    def test_malformed_state_containers_are_repaired(self):
        srv.STATE_FILE.write_text('{"runs": [], "stops": null, "activity": 1, "bumps": "bad", "sleep": []}')
        srv.save_schedules([schedule()])
        self.run_tick(at(2026, 8, 24, 7, 31)).assert_called_once()
        self.assertIsInstance(srv.load_runtime_state()['activity'], list)

    def test_failed_stop_is_retried(self):
        srv.save_schedules([schedule(stop_time='08:00')])
        srv.save_runtime_state({'runs': {'s1': '2026-08-24T07:30'}})
        with mock.patch.object(srv, 'stop_playback', side_effect=OSError('offline')):
            srv._run_due_schedules(at(2026, 8, 24, 8, 1))
        self.assertNotIn('s1', srv.load_runtime_state()['stops'])
        with mock.patch.object(srv, 'stop_playback') as stop:
            srv._run_due_schedules(at(2026, 8, 24, 8, 2))
            stop.assert_called_once()

    def test_playback_command_sequences_do_not_interleave(self):
        entered = threading.Event()
        release = threading.Event()
        calls = []
        def request(path, *args, **kwargs):
            calls.append((threading.current_thread().name, path))
            if len(calls) == 1:
                entered.set()
                if not release.wait(2):
                    raise AssertionError('test release timed out')
        with (mock.patch.object(srv, 'owntone_request', side_effect=request),
              ThreadPoolExecutor(max_workers=2) as pool):
            first = pool.submit(srv.execute_schedule, schedule())
            try:
                self.assertTrue(entered.wait(2))
                second = pool.submit(srv.execute_schedule, schedule(id='second'))
                time.sleep(0.02)
                self.assertEqual(len(calls), 1)
            finally:
                release.set()
            first.result(timeout=3)
            second.result(timeout=3)
        self.assertEqual(len(calls), 6)
        self.assertEqual(len({name for name, _ in calls[:3]}), 1)
        self.assertNotEqual(calls[0][0], calls[3][0])

    def test_sleep_at_zero_volume_does_not_unmute(self):
        with (mock.patch.object(srv, 'owntone_request', return_value={'volume': 0}),
              mock.patch.object(srv, '_fade_output_id', return_value='hp')):
            srv.start_sleep(2)
        self.assertEqual(srv.load_runtime_state()['sleep']['start_volume'], 0)

    def test_sleep_duration_validation_precedes_services(self):
        with mock.patch.object(srv, 'owntone_request') as api:
            for minutes in (-1, 1441, True, 2.5, None):
                with self.assertRaises(ValueError):
                    srv.start_sleep(minutes)
            api.assert_not_called()


class SchedulerClaims(IsolatedTestCase):
    Socket = HTTPRequests.Socket
    request = HTTPRequests.request

    def blocked_tick(self, during, *, fail=False, now=None):
        """Use real playback sequencing against a blocked fake OwnTone call."""
        entered, release = threading.Event(), threading.Event()
        calls = []

        def request(path, *args, **kwargs):
            self.assertIsNone(getattr(srv._OPEN_UPDATE, 'frame', None))
            calls.append(path)
            if len(calls) == 1:
                entered.set()
                if not release.wait(5):
                    raise AssertionError('network release timed out')
                if fail:
                    raise OSError('offline')
            return {}

        with (mock.patch.object(srv, 'local_now', return_value=now or at(2026, 8, 24, 7, 30)),
              mock.patch.object(srv, 'owntone_request', side_effect=request),
              ThreadPoolExecutor(max_workers=3) as pool):
            tick = pool.submit(srv.scheduler_tick)
            try:
                self.assertTrue(entered.wait(3))
                # A timeout fails the test instead of hanging if LOCK still
                # spans the network call. Always release before joining workers.
                pool.submit(during, pool).result(timeout=3)
            finally:
                release.set()
            tick.result(timeout=3)
        return calls

    def test_reads_history_and_nested_updates_survive_blocked_network(self):
        srv.save_schedules([schedule()])
        newer_error = {'message': 'concurrent error'}

        def during(pool):
            self.assertEqual(self.request('GET', '/health')[0], 200)
            self.assertEqual(self.request('GET', '/schedules')[0], 200)
            state = srv.load_runtime_state()
            self.assertEqual(state['runs']['s1'], '2026-08-24T07:30')
            self.assertNotIn('s1', state['run_started'])
            # Exercise real history read/append/activity with all network mocked.
            with mock.patch.object(srv, 'owntone_request', side_effect=[
                {'state': 'play'}, {'items': [{'id': 1, 'title': 'During claim'}]},
            ]):
                srv.capture_history_once()

            def nested(state):
                state['unrelated'] = {'kept': True}
                state['last_error'] = newer_error
                srv.log_activity('test', 'nested during network')
                return False

            srv.update_runtime_state(nested)

        self.assertEqual(len(self.blocked_tick(during)), 3)
        state = srv.load_runtime_state()
        self.assertEqual(state['unrelated'], {'kept': True})
        self.assertEqual(state['last_error'], newer_error)
        self.assertEqual({item['kind'] for item in state['activity']}, {'track', 'test', 'schedule'})
        self.assertEqual(srv.load_history()[0]['title'], 'During claim')
        self.assertIn('s1', state['run_started'])

    def test_edit_and_disable_reject_stale_success_and_failure(self):
        for body in ({'volume': 17}, {'enabled': False}):
            for fail in (False, True):
                with self.subTest(body=body, fail=fail):
                    srv.save_schedules([schedule(ramp_minutes=5, ramp_volume=70)])
                    srv.save_runtime_state({})
                    previous = srv.load_schedules()[0]

                    def during(pool, body=body, previous=previous):
                        self.assertEqual(self.request('PUT', '/schedules/s1', body)[0], 200)
                        current = srv.load_schedules()[0]
                        self.assertNotEqual(current['revision'], previous['revision'])
                        self.assertEqual(current['generation'], previous['generation'])

                    self.blocked_tick(during, fail=fail)
                    state = srv.load_runtime_state()
                    self.assertEqual(state['runs']['s1'], '2026-08-24T07:30')
                    self.assertNotIn('s1', state['run_started'])
                    self.assertEqual(state['bumps']['s1'], '2026-08-24T07:30')
                    self.assertIsNone(state['last_error'])
                    self.assertEqual(state['activity'], [])
                    with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 35)),
                          mock.patch.object(srv, 'owntone_request') as api):
                        srv.scheduler_tick()
                        api.assert_not_called()

    def test_delete_and_recreate_cannot_inherit_old_completion(self):
        for recreate in (False, True):
            with self.subTest(recreate=recreate):
                srv.save_schedules([schedule()])
                srv.save_runtime_state({})
                old = srv.load_schedules()[0]

                def during(pool, recreate=recreate, old=old):
                    self.assertEqual(self.request('DELETE', '/schedules/s1')[0], 200)
                    if recreate:
                        # Supplying the old ownership fields cannot impersonate it.
                        body = dict(old, time='09:00')
                        self.assertEqual(self.request('POST', '/schedules', body)[0], 201)
                        current = srv.load_schedules()[0]
                        self.assertNotEqual(current['generation'], old['generation'])
                        self.assertNotEqual(current['revision'], old['revision'])

                self.blocked_tick(during)
                state = srv.load_runtime_state()
                for field in ('runs', 'stops', 'bumps', 'run_started'):
                    self.assertNotIn('s1', state[field])
                self.assertEqual(state['activity'], [])

    def test_two_ticks_do_not_duplicate_a_blocked_start(self):
        srv.save_schedules([schedule()])
        second = []

        def during(pool):
            second.append(pool.submit(srv.scheduler_tick))
            self.assertFalse(second[0].done())

        self.assertEqual(len(self.blocked_tick(during)), 3)
        second[0].result(timeout=3)

    def test_start_claim_write_or_fsync_failure_has_zero_network(self):
        srv.save_schedules([schedule()])
        for target in ('_atomic_write', 'fsync'):
            with self.subTest(target=target):
                srv.save_runtime_state({})
                owner = srv if target == '_atomic_write' else srv.os
                with (mock.patch.object(owner, target, side_effect=OSError('disk failed')),
                      mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 30)),
                      mock.patch.object(srv, 'owntone_request') as api):
                    with self.assertRaises(OSError):
                        srv.scheduler_tick()
                    api.assert_not_called()

    def test_restart_after_start_claim_or_failed_finalize_does_not_replay(self):
        for executed in (False, True):
            with self.subTest(executed=executed):
                srv.save_schedules([schedule(ramp_minutes=5, ramp_volume=70)])
                srv.save_runtime_state({})
                with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 30)),
                      srv.PLAYBACK_LOCK):
                    action = srv._claim_schedule_action('s1', 'start', srv.local_now())
                    self.assertIsNotNone(action)
                    if executed:
                        with mock.patch.object(srv, 'owntone_request'):
                            srv._execute_schedule_action(action)
                        with (mock.patch.object(srv, '_atomic_write', side_effect=OSError('disk failed')),
                              self.assertRaises(OSError)):
                            srv._finalize_schedule_action(action, {}, None, srv.local_now().isoformat())
                # Drop every action snapshot. A new tick uses only persisted files.
                with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 35)),
                      mock.patch.object(srv, 'owntone_request') as api):
                    srv.scheduler_tick()
                    api.assert_not_called()
                self.assertNotIn('s1', srv.load_runtime_state()['run_started'])

    def test_generation_reconciles_restart_before_delete_cleanup(self):
        srv.save_schedules([schedule()])
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 30)),
              srv.PLAYBACK_LOCK):
            srv._claim_schedule_action('s1', 'start', srv.local_now())
        # Simulate schedules.json replaced but runtime cleanup never committed.
        srv.save_schedules([])
        srv.save_schedules([schedule()])
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 31)),
              mock.patch.object(srv, 'owntone_request') as api):
            srv.scheduler_tick()
            self.assertEqual(api.call_count, 3)
        state = srv.load_runtime_state()
        self.assertEqual(state['schedule_generations']['s1'], srv.load_schedules()[0]['generation'])
        self.assertIn('s1', state['run_started'])

    def test_edit_of_legacy_claim_keeps_consumed_occurrence(self):
        srv.SCHEDULES_FILE.write_text(json.dumps([schedule()]))

        def during(pool):
            self.assertEqual(self.request('PUT', '/schedules/s1', {'volume': 17})[0], 200)

        self.blocked_tick(during)
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 31)),
              mock.patch.object(srv, 'owntone_request') as api):
            srv.scheduler_tick()
            api.assert_not_called()

    def test_ramp_failure_retries_and_edit_does_not_reuse_old_ramp(self):
        srv.save_schedules([schedule(ramp_minutes=5, ramp_volume=70)])
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 30)),
              mock.patch.object(srv, 'owntone_request')):
            srv.scheduler_tick()
        with mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 35)):
            with mock.patch.object(srv, 'owntone_request', side_effect=OSError('offline')) as api:
                srv.scheduler_tick()
                api.assert_called_once()
            self.assertNotIn('s1', srv.load_runtime_state()['bumps'])
            with mock.patch.object(srv, 'owntone_request') as api:
                srv.scheduler_tick()
                api.assert_called_once()
        self.assertEqual(self.request('PUT', '/schedules/s1', {'ramp_volume': 50})[0], 200)
        # Even an unconsumed old ramp belongs to the revision that started it.
        srv.update_runtime_state(lambda state: state['bumps'].pop('s1', None))
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 36)),
              mock.patch.object(srv, 'owntone_request') as api):
            srv.scheduler_tick()
            api.assert_not_called()

    def test_sleep_fade_and_expiry_retry_from_persisted_state(self):
        timer = {'id': 'timer', 'start': at(2026, 8, 24, 7, 30).isoformat(),
                 'duration_min': 2, 'start_volume': 40}
        srv.save_runtime_state({'sleep': timer, 'sleep_output_id': 'hp'})
        with mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 31)):
            with mock.patch.object(srv, 'owntone_request', side_effect=OSError('offline')):
                srv.sleep_tick()
            self.assertNotIn('last_sent', srv.load_runtime_state()['sleep'])
            with mock.patch.object(srv, 'owntone_request') as api:
                srv.sleep_tick()
                api.assert_called_once_with('/player/volume?volume=20&output_id=hp', 'PUT')
            self.assertEqual(srv.load_runtime_state()['sleep']['last_sent'], 20)
        with mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 32)):
            with mock.patch.object(srv, 'owntone_request', side_effect=OSError('offline')):
                srv.sleep_tick()
            self.assertEqual(srv.load_runtime_state()['sleep']['id'], 'timer')
            with mock.patch.object(srv, 'owntone_request') as api:
                srv.sleep_tick()
                api.assert_called_once_with('/player/stop', 'PUT')
        self.assertNotIn('sleep', srv.load_runtime_state())
        self.assertEqual(srv.load_runtime_state()['activity'][0]['kind'], 'sleep')

    def test_edit_during_ramp_or_stop_rejects_stale_markers(self):
        for kind, now in (('ramp', at(2026, 8, 24, 7, 35)), ('stop', at(2026, 8, 24, 8))):
            with self.subTest(kind=kind):
                srv.save_schedules([schedule(stop_time='08:00',
                                             ramp_minutes=5 if kind == 'ramp' else 0,
                                             ramp_volume=70)])
                srv.save_runtime_state({})
                with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 30)),
                      mock.patch.object(srv, 'owntone_request')):
                    srv.scheduler_tick()

                def during(pool):
                    self.assertEqual(self.request('PUT', '/schedules/s1', {'volume': 17})[0], 200)

                self.assertTrue(self.blocked_tick(during, now=now))
                field = 'bumps' if kind == 'ramp' else 'stops'
                self.assertNotIn('s1', srv.load_runtime_state()[field])

    def test_sleep_cancellation_waits_for_committed_expiry(self):
        srv.save_runtime_state({'sleep': {
            'id': 'timer', 'start': at(2026, 8, 24, 7, 30).isoformat(),
            'duration_min': 2, 'start_volume': 40}})
        entered, release, cancelling = threading.Event(), threading.Event(), threading.Event()

        def request(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError('expiry release timed out')

        def cancel():
            cancelling.set()
            return srv.start_sleep(0)

        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 32)),
              mock.patch.object(srv, 'owntone_request', side_effect=request) as api,
              ThreadPoolExecutor(max_workers=3) as pool):
            expiry = pool.submit(srv.sleep_tick)
            try:
                self.assertTrue(entered.wait(3))
                cancellation = pool.submit(cancel)
                self.assertTrue(cancelling.wait(3))
                with self.assertRaises(FutureTimeoutError):
                    cancellation.result(timeout=0.05)
                self.assertTrue(pool.submit(srv.sleep_status).result(timeout=3)['active'])
            finally:
                release.set()
            expiry.result(timeout=3)
            self.assertEqual(cancellation.result(timeout=3), {'active': False})
            api.assert_called_once_with('/player/stop', 'PUT')
        self.assertNotIn('sleep', srv.load_runtime_state())

    def test_sleep_replacements_get_distinct_ids_at_the_same_time(self):
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, 30)),
              mock.patch.object(srv, 'owntone_request', return_value={'volume': 0, 'output_id': 'hp'})):
            srv.start_sleep(2)
            original = srv.load_runtime_state()['sleep']['id']
            srv.start_sleep(2)
        self.assertNotEqual(srv.load_runtime_state()['sleep']['id'], original)

    def test_stale_sleep_completion_cannot_restore_or_change_timer(self):
        for minute in (31, 32):
            for replace in (False, True):
                with self.subTest(minute=minute, replace=replace):
                    srv.save_runtime_state({'sleep': {
                        'start': at(2026, 8, 24, 7, 30).isoformat(),
                        'duration_min': 2, 'start_volume': 40}, 'sleep_output_id': 'hp'})
                    entered, release = threading.Event(), threading.Event()
                    replacement = {'id': 'replacement', 'start': at(2026, 8, 24, 7, 31).isoformat(),
                                   'duration_min': 60, 'start_volume': 10}

                    def request(*args, entered=entered, release=release, **kwargs):
                        self.assertIsNone(getattr(srv._OPEN_UPDATE, 'frame', None))
                        entered.set()
                        if not release.wait(5):
                            raise AssertionError('sleep release timed out')

                    def change(replace=replace, replacement=replacement):
                        def mutate(state):
                            state.pop('sleep', None)
                            if replace:
                                state['sleep'] = replacement.copy()
                        srv.update_runtime_state(mutate)

                    with (mock.patch.object(srv, 'local_now', return_value=at(2026, 8, 24, 7, minute)),
                          mock.patch.object(srv, 'owntone_request', side_effect=request),
                          ThreadPoolExecutor(max_workers=2) as pool):
                        future = pool.submit(srv.sleep_tick)
                        try:
                            self.assertTrue(entered.wait(3))
                            pool.submit(change).result(timeout=3)
                        finally:
                            release.set()
                        future.result(timeout=3)
                    self.assertEqual(srv.load_runtime_state().get('sleep'), replacement if replace else None)
                    self.assertEqual(srv.load_runtime_state()['activity'], [])

    def test_sleep_elapsed_time_crosses_dst_and_identity_is_stable(self):
        srv.save_runtime_state({'sleep': {'start': at(2026, 3, 29, 1, 50).isoformat(),
                                         'duration_min': 30, 'start_volume': 40}})
        with (mock.patch.object(srv, 'local_now', return_value=at(2026, 3, 29, 3, 20)),
              mock.patch.object(srv, 'owntone_request', side_effect=OSError('offline'))):
            srv.sleep_tick()
            timer_id = srv.load_runtime_state()['sleep']['id']
            srv.sleep_tick()
            self.assertEqual(srv.load_runtime_state()['sleep']['id'], timer_id)

    def test_rescan_releases_file_lock_after_committing_edit(self):
        srv.PLAYLISTS_DIR.mkdir()
        path = srv.PLAYLISTS_DIR / 'sample.m3u'
        path.write_text('#EXTM3U\n')
        entered, release = threading.Event(), threading.Event()

        def scan():
            entered.set()
            if not release.wait(5):
                raise AssertionError('rescan release timed out')

        def inspect():
            with srv.FILES_LOCK:
                self.assertIn('/music/song.flac', path.read_text())
                self.assertEqual(self.request('GET', '/health')[0], 200)

        with (mock.patch.object(srv, 'rescan_library', side_effect=scan),
              ThreadPoolExecutor(max_workers=2) as pool):
            future = pool.submit(srv.save_playlist_lines, 'sample', ['/music/song.flac'])
            try:
                self.assertTrue(entered.wait(3))
                pool.submit(inspect).result(timeout=3)
            finally:
                release.set()
            future.result(timeout=3)


class FileRegressions(IsolatedTestCase):
    def test_atomic_text_preserves_modes_and_json_defaults_private(self):
        target = self.root / 'playlist.m3u'
        srv._atomic_text(target, '#EXTM3U\n')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
        target.chmod(0o640)
        srv._atomic_text(target, '#EXTM3U\n/new.flac\n')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
        srv._atomic_write(srv.STATE_FILE, {})
        self.assertEqual(stat.S_IMODE(srv.STATE_FILE.stat().st_mode), 0o600)

    def test_predictable_temp_symlink_cannot_overwrite_another_file(self):
        victim = self.root / 'victim'
        victim.write_text('keep')
        srv.STATE_FILE.with_suffix('.json.tmp').symlink_to(victim)
        srv._atomic_write(srv.STATE_FILE, {'ok': True})
        self.assertEqual(victim.read_text(), 'keep')
        self.assertEqual(json.loads(srv.STATE_FILE.read_text()), {'ok': True})

    def test_concurrent_same_name_creation_gets_distinct_files(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(srv.create_station, 'Same', 'https://radio.example/live') for _ in range(8)]
            results = [future.result(timeout=5) for future in futures]
        self.assertEqual(len({result['file'] for result in results}), 8)

    def test_concurrent_playlist_saves_leave_a_complete_file(self):
        item = srv.create_playlist('Evening')
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(srv.save_playlist_lines, item['slug'], [f'/track{i}.flac'] * 30) for i in range(8)]
            for future in futures:
                future.result(timeout=5)
        lines = (srv.PLAYLISTS_DIR / item['file']).read_text().splitlines()
        self.assertEqual(lines[0], '#EXTM3U')
        self.assertEqual(len(lines), 31)
        self.assertEqual(len(set(lines[1:])), 1)

    def test_invalid_playlist_payload_cannot_clear_or_inject_lines(self):
        item = srv.create_playlist('Evening')
        path = srv.PLAYLISTS_DIR / item['file']
        original = path.read_text()
        for value in ('https://example/x', {}, None, [None], ['/track\rmalicious'], ['#x\n/local'], ['/track\x00']):
            with self.subTest(value=value), self.assertRaises(ValueError):
                srv.save_playlist_lines(item['slug'], value)
            self.assertEqual(path.read_text(), original)

    def test_playlist_symlinks_are_not_read_or_edited(self):
        srv.PLAYLISTS_DIR.mkdir()
        secret = self.root / 'secret'
        secret.write_text('private')
        (srv.PLAYLISTS_DIR / 'secret.m3u').symlink_to(secret)
        self.assertEqual(srv.list_playlists(), [])
        with self.assertRaises(ValueError):
            srv.save_playlist_lines('secret', ['/new.flac'])
        self.assertEqual(secret.read_text(), 'private')

    def test_station_matching_requires_full_path(self):
        wanted = str(srv.STATIONS_DIR / 'same.m3u')
        with mock.patch.object(srv, 'owntone_request', return_value={'items': [
            {'path': '/elsewhere' + wanted, 'uri': 'wrong'}, {'path': wanted, 'uri': 'right'}]}):
            self.assertEqual(srv._resolve_station_playlist({'file': 'same.m3u'}), 'right')

    def test_strict_schedule_types_and_uris(self):
        for change in ({'enabled': 'false'}, {'shuffle': 1}, {'respect_night_cap': 'true'},
                       {'volume': float('inf')}, {'volume': True}, {'ramp_minutes': 1.5},
                       {'source_uri': 'file:///etc/passwd'}, {'fallback_uri': 'http://localhost/'},
                       {'source_name': {}}, {'id': '../x'}, {'output_id': []}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                srv.clean_schedule(schedule(**change))
        self.assertEqual(srv.clean_schedule(schedule(output_id=0))['output_id'], '0')


class StreamProbeSecurity(unittest.TestCase):
    def setUp(self):
        def start(patch):
            result = patch.start()
            self.addCleanup(patch.stop)
            return result
        self.dns = start(mock.patch.object(srv.socket, 'getaddrinfo',
                                          return_value=self.addresses('93.184.216.34')))
        self.http = start(mock.patch.object(srv.http.client, 'HTTPConnection'))
        self.https = start(mock.patch.object(srv.http.client, 'HTTPSConnection'))
        start(mock.patch.object(srv, 'STREAM_TRUSTED_HOSTS', frozenset()))
        self.response = mock.Mock(status=200, headers={'Content-Type': 'audio/mpeg'})
        self.response.read1.return_value = b'audio'
        self.http.return_value.getresponse.return_value = self.response
        self.https.return_value.getresponse.return_value = self.response

    @staticmethod
    def addresses(ip):
        family = socket.AF_INET6 if ':' in ip else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, '', (ip, 80))]

    def test_public_probe_pins_socket_and_preserves_tls_hostname(self):
        with srv._open_stream('https://radio.example/live?x=1') as response:
            self.assertIs(response, self.response)
            connect = self.https.return_value._create_connection
            with mock.patch.object(srv.socket, 'create_connection') as socket_connect:
                connect(('radio.example', 443), 4)
                socket_connect.assert_called_once_with(('93.184.216.34', 443), 4, None)
        self.https.assert_called_once_with('radio.example', 443, timeout=4)
        self.https.return_value.close.assert_called_once()
        self.assertEqual(self.dns.call_count, 1)

    def test_private_mixed_and_ipv6_addresses_are_rejected_before_connecting(self):
        for ip in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '224.0.0.1'):
            self.dns.return_value = self.addresses('93.184.216.34') + self.addresses(ip)
            self.assertFalse(srv.stream_alive('http://radio.example/live'))
        self.http.assert_not_called()

    def test_private_redirect_is_rejected(self):
        self.response.status = 302
        self.response.getheader.return_value = 'http://127.0.0.1/private'
        self.dns.side_effect = [self.addresses('93.184.216.34'), self.addresses('127.0.0.1')]
        self.assertFalse(srv.stream_alive('http://radio.example/live'))
        self.http.assert_called_once()
        self.http.return_value.close.assert_called_once()

    def test_redirect_loop_is_bounded(self):
        self.response.status = 302
        self.response.getheader.return_value = '/next'
        self.assertFalse(srv.stream_alive('http://radio.example/live'))
        self.assertEqual(self.http.call_count, 6)
        self.assertEqual(self.http.return_value.close.call_count, 6)

    def test_trusted_lan_host_is_explicit_and_does_not_trust_redirect_hosts(self):
        with mock.patch.object(srv, 'STREAM_TRUSTED_HOSTS', frozenset({'radio.lan'})):
            self.dns.return_value = self.addresses('192.168.1.5')
            self.assertTrue(srv.stream_alive('http://radio.lan/live'))
            self.assertFalse(srv.stream_alive('http://other.lan/live'))
            self.response.status = 302
            self.response.getheader.return_value = 'http://other.lan/private'
            self.assertFalse(srv.stream_alive('http://radio.lan/live'))

    def test_invalid_url_and_empty_audio_are_offline(self):
        for url in ('file:///etc/passwd', 'http://user:pass@radio.example/live', 'http://radio.example:bad/', 'http://radio.example/a\rb'):
            self.assertFalse(srv.stream_alive(url))
        self.http.assert_not_called()
        self.response.read1.return_value = b''
        self.assertFalse(srv.stream_alive('http://radio.example/live'))

    def test_probe_radio_uses_same_guard_and_one_partial_read(self):
        with mock.patch.object(srv, 'playlist_stream_info', return_value={
            'url': 'http://radio.example/live', 'track': {}, 'quality': 'STREAM'}), \
             mock.patch.object(srv, 'RADIO_HEALTH_CACHE', {}):
            result = srv.probe_radio('123')
        self.assertTrue(result['online'])
        self.response.read1.assert_called_once_with(768)
        self.response.read.assert_not_called()


if __name__ == '__main__':
    unittest.main()
