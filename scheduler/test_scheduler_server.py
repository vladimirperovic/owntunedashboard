"""
Unit tests for the companion service's pure logic.

Standard library only, to match the service itself:

    python3 -m unittest discover -s scheduler -p 'test_*.py'

These cover the parts that decide *when* something plays and *how loud* — the
places where a bug is expensive and a test is cheap.
"""

import os
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
        self.written = []
        target = Path("Evening.m3u")
        patches = [
            mock.patch.object(srv, "_playlist_path", lambda slug: target),
            mock.patch.object(srv, "rescan_library", lambda: None),
            mock.patch.object(srv, "log_activity", lambda *a, **k: None),
            mock.patch.object(srv.os, "replace", lambda a, b: None),
            mock.patch.object(
                Path, "write_text", lambda _self, text, **kw: self.written.append(text)
            ),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_writes_one_header_and_the_lines(self):
        srv.save_playlist_lines("evening", ["https://stream.example/x", "/media/music/a.flac"])
        self.assertEqual(
            self.written[-1].splitlines(), ["#EXTM3U", "https://stream.example/x", "/media/music/a.flac"]
        )
        self.assertTrue(self.written[-1].endswith(os.linesep) or self.written[-1][-1] == "\n")

    def test_does_not_duplicate_a_header_sent_back_by_the_client(self):
        # Saving a playlist that was just read used to gain a second #EXTM3U.
        srv.save_playlist_lines("evening", ["#EXTM3U", "https://stream.example/x"])
        self.assertEqual(self.written[-1].count("#EXTM3U"), 1)

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


if __name__ == "__main__":
    unittest.main()
