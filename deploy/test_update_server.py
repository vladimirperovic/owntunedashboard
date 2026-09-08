import contextlib
import io
import json
import socket
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from deploy import update_server


class UpdateServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        update_server.TARGET = root / "dashboard"
        update_server.STATE_DIR = root / "state"
        update_server.REQUEST_FILE = update_server.STATE_DIR / "update.request"
        update_server.RUNNING_FILE = update_server.STATE_DIR / "update-running.json"
        update_server.RESULT_FILE = update_server.STATE_DIR / "update-result.json"
        update_server.CHECK_FILE = update_server.STATE_DIR / "update-check.json"
        update_server.TARGET.mkdir(parents=True)
        update_server.STATE_DIR.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    @contextlib.contextmanager
    def http_server(self):
        server = update_server.ThreadingHTTPServer(("127.0.0.1", 0), update_server.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_address
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_fetch_rejects_invalid_sha_and_payload_shapes(self):
        for payload in (None, [], {}, {"sha": None}, {"sha": 12345678},
                        {"sha": "abcdef0"}, {"sha": "g" * 40}, {"sha": "../" * 20}):
            with self.subTest(payload=payload), patch.object(
                update_server, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())
            ), self.assertRaises(ValueError):
                update_server.fetch_latest_main()
        commit = "a" * 40
        with patch.object(update_server, "urlopen", return_value=io.BytesIO(json.dumps({"sha": commit}).encode())):
            self.assertEqual(update_server.fetch_latest_main()["commit"], commit)

    def test_invalid_or_future_cache_is_refetched(self):
        valid_commit = "a" * 40
        remote = {"commit": valid_commit, "checked_at": update_server.now().isoformat()}
        invalid = [[], {"commit": "invalid", "checked_at": remote["checked_at"]},
                   {"commit": valid_commit, "checked_at": "invalid"},
                   {"commit": valid_commit, "checked_at": (update_server.now() + timedelta(days=1)).isoformat()},
                   {"commit": valid_commit, "checked_at": (update_server.now() - timedelta(days=1)).isoformat()}]
        for value in invalid:
            with self.subTest(value=value):
                update_server.CHECK_FILE.write_text(json.dumps(value), encoding="utf-8")
                with patch.object(update_server, "fetch_latest_main", return_value=remote) as fetch:
                    self.assertEqual(update_server.check_latest()["latest"], remote)
                    fetch.assert_called_once()

    def test_same_commit_requires_hex_and_at_least_seven_characters(self):
        for left, right in (("a", "a"), ("invalid", "invalid"), ("g" * 40, "g" * 40), ("", "")):
            self.assertFalse(update_server.same_commit(left, right))
        self.assertTrue(update_server.same_commit("abcdef01", "abcdef01" + "0" * 32))

    def test_atomic_json_write_does_not_follow_symlinks(self):
        victim = update_server.STATE_DIR / "victim"
        victim.write_text("original", encoding="utf-8")
        update_server.CHECK_FILE.symlink_to(victim)
        update_server.CHECK_FILE.with_suffix(".json.tmp").symlink_to(victim)
        update_server.write_json(update_server.CHECK_FILE, {"commit": "a" * 40})
        self.assertEqual(victim.read_text(encoding="utf-8"), "original")
        self.assertFalse(update_server.CHECK_FILE.is_symlink())
        self.assertEqual(json.loads(update_server.CHECK_FILE.read_text())["commit"], "a" * 40)

    def test_concurrent_checks_share_one_fetch_and_atomic_cache(self):
        remote = {"commit": "a" * 40, "checked_at": update_server.now().isoformat()}
        with patch.object(update_server, "fetch_latest_main", return_value=remote) as fetch, \
                ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: update_server.check_latest(), range(20)))
        fetch.assert_called_once()
        self.assertTrue(all(value["latest"] == remote for value in results))
        self.assertEqual(json.loads(update_server.CHECK_FILE.read_text()), remote)

    def test_non_utf8_status_file_is_tolerated(self):
        (update_server.TARGET / "version.json").write_bytes(b"\xff")
        self.assertEqual(update_server.status()["current"], {})

    def test_http_rejects_request_bodies_and_ambiguous_framing(self):
        variants = ("Content-Length: 1\r\n", "Content-Length: -1\r\n", "Content-Length: nope\r\n",
                    "Content-Length: 0\r\nContent-Length: 0\r\n", "Transfer-Encoding: chunked\r\n")
        with self.http_server() as address:
            for headers in variants:
                with self.subTest(headers=headers), socket.create_connection(address, timeout=3) as conn:
                    conn.sendall(("POST /request HTTP/1.1\r\nHost: localhost\r\nX-OwnTone-Update: 1\r\n"
                                  + headers + "\r\nx").encode())
                    response = b""
                    while chunk := conn.recv(4096):
                        response += chunk
                    self.assertIn(b"HTTP/1.1 400", response)
                    self.assertFalse(update_server.REQUEST_FILE.exists())

    def test_http_post_closes_before_unread_bytes_can_be_another_request(self):
        with self.http_server() as address, socket.create_connection(address, timeout=3) as conn:
            conn.sendall(b"POST /request HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"
                         b"POST /request HTTP/1.1\r\nHost: localhost\r\nX-OwnTone-Update: 1\r\n\r\n")
            response = b""
            while chunk := conn.recv(4096):
                response += chunk
            self.assertIn(b"HTTP/1.1 403", response)
            self.assertNotIn(b"HTTP/1.1 202", response)
            self.assertFalse(update_server.REQUEST_FILE.exists())

    def test_status_reports_current_pending_running_and_result(self):
        (update_server.TARGET / "version.json").write_text('{"commit":"abc123"}\n', encoding="utf-8")
        update_server.REQUEST_FILE.write_text('{}\n', encoding="utf-8")
        update_server.RUNNING_FILE.write_text('{"status":"running"}\n', encoding="utf-8")
        update_server.RESULT_FILE.write_text('{"status":"success","commit":"abc123"}\n', encoding="utf-8")

        value = update_server.status()

        self.assertTrue(value["ok"])
        self.assertEqual(value["current"]["commit"], "abc123")
        self.assertTrue(value["pending"])
        self.assertTrue(value["running"])
        self.assertEqual(value["result"]["status"], "success")

    def test_request_update_is_atomic_and_deduplicated(self):
        first = update_server.request_update()
        second = update_server.request_update()

        self.assertTrue(first["queued"])
        self.assertTrue(second["already_running"])
        payload = json.loads(update_server.REQUEST_FILE.read_text(encoding="utf-8"))
        self.assertEqual(payload["source"], "github-main")
        self.assertTrue(payload["requested_at"])

    def test_check_latest_marks_new_main_and_reuses_12_hour_cache(self):
        current = "1111111111111111111111111111111111111111"
        latest = "2222222222222222222222222222222222222222"
        (update_server.TARGET / "version.json").write_text(json.dumps({"commit": current}) + "\n", encoding="utf-8")
        remote = {"commit": latest, "checked_at": update_server.now().isoformat()}

        with patch.object(update_server, "fetch_latest_main", return_value=remote) as fetch:
            first = update_server.check_latest()
            second = update_server.check_latest()

        self.assertTrue(first["update_available"])
        self.assertEqual(first["latest"]["commit"], latest)
        self.assertEqual(second["latest"]["commit"], latest)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(first["check_interval_seconds"], 12 * 60 * 60)

    def test_check_latest_accepts_short_deployed_commit_as_current(self):
        latest = "abcdef0123456789abcdef0123456789abcdef01"
        (update_server.TARGET / "version.json").write_text('{"commit":"abcdef0"}\n', encoding="utf-8")
        remote = {"commit": latest, "checked_at": update_server.now().isoformat()}

        with patch.object(update_server, "fetch_latest_main", return_value=remote):
            value = update_server.check_latest(force=True)

        self.assertFalse(value["update_available"])

    def test_http_request_requires_explicit_confirmation_header(self):
        server = update_server.ThreadingHTTPServer(("127.0.0.1", 0), update_server.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_address[1]}/request"
        try:
            with self.assertRaises(HTTPError) as rejected:
                urlopen(Request(url, method="POST"), timeout=3)
            self.assertEqual(rejected.exception.code, 403)

            request = Request(url, method="POST", headers={"X-OwnTone-Update": "1"})
            with urlopen(request, timeout=3) as response:
                payload = json.load(response)
            self.assertEqual(response.status, 202)
            self.assertTrue(payload["queued"])
            self.assertTrue(update_server.REQUEST_FILE.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
