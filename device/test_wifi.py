import contextlib
import io
import pathlib
import runpy
import sys
import types
import unittest
from unittest.mock import patch


SOURCE_FOR = runpy.run_path(
    str(pathlib.Path(__file__).resolve().parents[1] / "tools" / "configure-wifi.py")
)["source_for"]


class WifiPersistenceTest(unittest.TestCase):
    def setUp(self):
        self.original = 'WIFI_SSID = "factory"\nWIFI_PASSWORD = "factory-pass"\nOTHER_SETTING = 42\n'
        self.files = {
            "/system/secrets.py": self.original,
            "/secrets.py": self.original,
        }
        self.synced = False
        self.connection = None

    def open_file(self, filename, mode="r"):
        if mode == "r":
            if filename not in self.files:
                raise FileNotFoundError(2, "missing test file")
            return io.StringIO(self.files[filename])
        self.assertEqual(mode, "w")
        files = self.files

        class WritableFile(io.StringIO):
            def close(self):
                if not self.closed:
                    files[filename] = self.getvalue()
                super().close()

        return WritableFile()

    def stat(self, filename):
        if filename not in self.files:
            raise FileNotFoundError(2, "missing test file")
        return (0,) * 10

    def rename(self, source, target):
        self.files[target] = self.files.pop(source)

    def sync(self):
        self.synced = True

    def connect(self, ssid, password):
        self.connection = (ssid, password)

    def configure(self, ssid="test-network", password="test-password", sync=None, rename=None):
        network = types.SimpleNamespace(
            STA_IF=0,
            WLAN=lambda _: types.SimpleNamespace(
                active=lambda _: None, disconnect=lambda: None,
                connect=self.connect, isconnected=lambda: True, status=lambda: 3,
            ),
        )
        output = io.StringIO()
        self.output = output
        with patch.dict(sys.modules, {
            "os": types.SimpleNamespace(stat=self.stat, rename=rename or self.rename, sync=sync or self.sync),
            "network": network,
            "time": types.SimpleNamespace(ticks_ms=lambda: 0),
        }), patch.object(sys, "path", list(sys.path)), patch(
            "builtins.open", side_effect=self.open_file
        ), contextlib.redirect_stdout(output):
            exec(SOURCE_FOR(ssid, password), {})
        return output.getvalue()

    def test_settings_survive_monaos_restoring_the_boot_copy(self):
        output = self.configure()
        self.assertTrue(self.synced)
        self.assertEqual(self.connection, ("test-network", "test-password"))
        self.assertEqual(self.files["/secrets.py"], self.original)
        self.assertEqual(self.files["/system/secrets.py.before-underhive"], self.original)
        self.files["/secrets.py"] = self.files["/system/secrets.py"]
        after_reset = {}
        exec(self.files["/secrets.py"], after_reset)
        self.assertEqual(after_reset["WIFI_SSID"], "test-network")
        self.assertEqual(after_reset["WIFI_PASSWORD"], "test-password")
        self.assertEqual(after_reset["OTHER_SETTING"], 42)
        self.assertIn("BADGE_PROBE wifi_saved=True", output)
        self.assertNotIn("test-password", output)
        self.assertNotIn("test-network", output)

    def test_a_second_save_keeps_the_original_backup(self):
        self.configure()
        self.configure("second-network", "second-password")
        self.assertEqual(self.files["/system/secrets.py.before-underhive"], self.original)
        self.assertNotIn("/system/secrets.py.underhive.tmp", self.files)

    def test_a_sync_failure_cannot_report_a_successful_save(self):
        def fail_sync():
            raise OSError("test sync failure")

        with self.assertRaises(OSError):
            self.configure(sync=fail_sync)
        self.assertNotIn("wifi_saved=True", self.output.getvalue())
        self.assertIsNone(self.connection)

    def test_readback_must_match_before_the_tool_tries_to_connect(self):
        def lose_write(source, target):
            self.files.pop(source)

        with self.assertRaisesRegex(RuntimeError, "Saved Wi-Fi settings do not match"):
            self.configure(rename=lose_write)
        self.assertIsNone(self.connection)


if __name__ == "__main__":
    unittest.main()
