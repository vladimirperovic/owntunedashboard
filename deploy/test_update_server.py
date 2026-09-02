import json
import tempfile
import threading
import unittest
from pathlib import Path
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
        update_server.TARGET.mkdir(parents=True)
        update_server.STATE_DIR.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

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
