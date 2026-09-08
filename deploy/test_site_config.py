import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.site_config import LiteralParser, prepare, validate


class SiteConfig(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "new"
        self.old = self.root / "old"
        self.external = self.root / "operator"
        self.source.mkdir()
        self.old.mkdir()
        self.defaults = Path(__file__).resolve().parents[1] / "config.js"
        (self.source / "config.js").write_bytes(self.defaults.read_bytes())

    def prepare(self):
        prepare(self.source, self.old, self.external)

    def test_migrate_settings_and_artwork_then_preserve_across_next_release(self):
        (self.old / "config.js").write_text(
            "window.OWNTONE_DASHBOARD = {manualVolume: 0, radioNameHints: ['fm'], "
            "radioArtwork: {'Local': 'station-logos/local.svg'},};")
        (self.old / "station-logos").mkdir()
        (self.old / "station-logos/local.svg").write_text("local artwork")
        self.prepare()
        config = self.external / "config.json"
        data = json.loads(config.read_text())
        self.assertEqual(data["manualVolume"], 0)
        self.assertEqual(data["radioArtwork"]["Local"], "/site-assets/local.svg")
        self.assertEqual((self.source / "site-assets/local.svg").read_text(), "local artwork")
        data["manualVolume"] = 9
        config.write_text(json.dumps(data))
        self.prepare()
        self.assertEqual(json.loads((self.source / "site-config.json").read_text())["manualVolume"], 9)
        self.assertTrue((self.source / "site-config.json").is_symlink())

    def test_invalid_existing_configuration_is_never_replaced(self):
        self.external.mkdir()
        config = self.external / "config.json"
        config.write_text('{"manualVolume": 120}')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(config.read_text(), '{"manualVolume": 120}')
        self.assertFalse((self.source / "site-config.json").exists())

    def test_expressions_are_not_executed(self):
        for expression in ("{manualVolume: dangerous()};", "{manualVolume: 5} || otherSettings;"):
            (self.old / "config.js").write_text("window.OWNTONE_DASHBOARD = " + expression)
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse(self.external.exists())

    def test_artwork_symlink_is_rejected_before_copy(self):
        (self.old / "station-logos").mkdir()
        (self.old / "station-logos/secret").symlink_to(self.defaults)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.external.exists())

    def test_unknown_keys_and_wrong_types_fail(self):
        defaults = LiteralParser(self.defaults.read_text()).value()
        for value in ([], {"__proto__": {}}, {"manualVolume": True}, {"pollMs": 0},
                      {"nightSafeStartHour": 25}, {"radioArtwork": {"Station": 9}}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate(value, defaults)

    def test_new_install_uses_empty_overrides(self):
        self.prepare()
        self.assertEqual(json.loads((self.external / "config.json").read_text()), {"radioArtwork": {}})

    def test_retry_detects_edits_to_restored_legacy_settings(self):
        legacy = self.old / "config.js"
        legacy.write_text("window.OWNTONE_DASHBOARD = {manualVolume:7};")
        self.prepare()
        legacy.write_text("window.OWNTONE_DASHBOARD = {manualVolume:2};")
        with self.assertRaisesRegex(ValueError, "changed after migration"):
            self.prepare()
        self.assertEqual(json.loads((self.external / "config.json").read_text())["manualVolume"], 7)

    def test_restrictive_umask_does_not_hide_new_public_directories(self):
        old_umask = os.umask(0o077)
        try:
            self.external = self.external / "nested"
            self.prepare()
        finally:
            os.umask(old_umask)
        for path in (self.external, self.external.parent, self.external / "artwork"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)

    def test_missing_child_of_symlink_and_release_overlap_are_rejected(self):
        link = self.root / "linked"
        link.symlink_to(self.root, target_is_directory=True)
        for target in (link / "new-site", self.old / "operator", Path(str(self.old) + ".rollback") / "operator"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                prepare(self.source, self.old, target)

    def test_root_and_dot_relative_artwork_paths_are_migrated(self):
        (self.old / "config.js").write_text(
            "window.OWNTONE_DASHBOARD = {radioArtwork: {A:'./station-logos/a.svg', B:'/station-logos/b.svg'}};")
        self.prepare()
        artwork = json.loads((self.external / "config.json").read_text())["radioArtwork"]
        self.assertEqual(artwork, {"A": "/site-assets/a.svg", "B": "/site-assets/b.svg"})

    def test_interrupted_artwork_copy_never_publishes_partial_data_and_tracks_origin(self):
        (self.old / "station-logos").mkdir()
        image = self.old / "station-logos/a.svg"
        image.write_text("original image")

        def interrupted(source, destination):
            Path(destination).write_text("partial")
            raise OSError("disk error")

        with patch("deploy.site_config.shutil.copyfile", side_effect=interrupted), self.assertRaises(OSError):
            self.prepare()
        self.assertFalse((self.external / "artwork/a.svg").exists())
        self.assertTrue((self.external / ".legacy-migration.json").exists())
        image.write_text("updated image")
        with self.assertRaisesRegex(ValueError, "changed after migration"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
