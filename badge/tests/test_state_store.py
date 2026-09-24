import json
import pathlib
import sys
import tempfile
import unittest

APP = pathlib.Path(__file__).resolve().parents[1] / "apps/underhive"
sys.path.insert(0, str(APP))

from state_store import StateError, StateStore
from wifi_manager import (
    WifiProfiles, empty_wifi_state, validate_password, validate_wifi_state,
)


class FailingOS:
    def __init__(self, module, fail_rename=None):
        self.module = module
        self.fail_rename = fail_rename

    def __getattr__(self, name):
        return getattr(self.module, name)

    def rename(self, source, target):
        if self.fail_rename and self.fail_rename(source, target):
            raise OSError(5)
        return self.module.rename(source, target)


class StateStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name) / "state" / "underhive"

    def tearDown(self):
        self.temp.cleanup()

    def store(self, os_module=None, maximum=8192):
        import os
        return StateStore(
            str(self.root), os_module=os_module or os,
            max_bytes=maximum
        )

    def test_missing_state_uses_checked_default(self):
        store = self.store()
        value = store.load("wifi.v1.json", validate_wifi_state, empty_wifi_state())
        self.assertEqual(value, empty_wifi_state())
        self.assertEqual(store.last_source, "default")
        self.assertFalse(self.root.exists())

    def test_save_keeps_a_valid_backup_and_loads_primary(self):
        store = self.store()
        first = dict(empty_wifi_state(), revision=1)
        second = dict(empty_wifi_state(), revision=2)
        store.save("wifi.v1.json", first, validate_wifi_state)
        store.save("wifi.v1.json", second, validate_wifi_state)
        self.assertEqual(store.load("wifi.v1.json", validate_wifi_state, {}), second)
        backup = json.loads((self.root / "wifi.v1.json.bak").read_text())
        self.assertEqual(backup["revision"], 1)

    def test_corrupt_primary_recovers_from_backup(self):
        store = self.store()
        first = dict(empty_wifi_state(), revision=1)
        second = dict(empty_wifi_state(), revision=2)
        store.save("wifi.v1.json", first, validate_wifi_state)
        store.save("wifi.v1.json", second, validate_wifi_state)
        (self.root / "wifi.v1.json").write_text("{broken")
        self.assertEqual(
            store.load("wifi.v1.json", validate_wifi_state, empty_wifi_state()),
            first,
        )
        self.assertEqual(store.last_source, "backup")
        self.assertEqual(
            json.loads((self.root / "wifi.v1.json").read_text())["revision"], 1
        )

    def test_save_after_backup_recovery_preserves_a_valid_backup(self):
        store = self.store()
        first = dict(empty_wifi_state(), revision=1)
        second = dict(empty_wifi_state(), revision=2)
        third = dict(empty_wifi_state(), revision=3)
        store.save("wifi.v1.json", first, validate_wifi_state)
        store.save("wifi.v1.json", second, validate_wifi_state)
        (self.root / "wifi.v1.json").write_text("{broken")
        store.load("wifi.v1.json", validate_wifi_state, empty_wifi_state())
        store.save("wifi.v1.json", third, validate_wifi_state)
        self.assertEqual(
            validate_wifi_state(json.loads(
                (self.root / "wifi.v1.json.bak").read_text()
            ))["revision"],
            1,
        )

    def test_candidate_recovers_interrupted_final_rename(self):
        self.root.mkdir(parents=True)
        candidate = dict(empty_wifi_state(), revision=4)
        (self.root / "wifi.v1.json.new").write_text(json.dumps(candidate))
        store = self.store()
        self.assertEqual(
            store.load("wifi.v1.json", validate_wifi_state, empty_wifi_state()),
            candidate,
        )
        self.assertTrue((self.root / "wifi.v1.json").exists())
        self.assertFalse((self.root / "wifi.v1.json.new").exists())

    def test_valid_primary_discards_a_stale_candidate(self):
        store = self.store()
        primary = dict(empty_wifi_state(), revision=3)
        store.save("wifi.v1.json", primary, validate_wifi_state)
        (self.root / "wifi.v1.json.new").write_text(json.dumps(
            dict(empty_wifi_state(), revision=9)
        ))
        self.assertEqual(
            store.load("wifi.v1.json", validate_wifi_state, empty_wifi_state()),
            primary,
        )
        self.assertFalse((self.root / "wifi.v1.json.new").exists())

    def test_all_corrupt_copies_raise_without_echoing_content(self):
        self.root.mkdir(parents=True)
        secret = "do-not-print-this-password"
        for suffix in ("", ".new", ".bak"):
            (self.root / ("wifi.v1.json" + suffix)).write_text(secret)
        with self.assertRaises(StateError) as raised:
            self.store().load(
                "wifi.v1.json", validate_wifi_state, empty_wifi_state()
            )
        self.assertNotIn(secret, str(raised.exception))

    def test_candidate_rename_failure_restores_old_primary(self):
        import os
        normal = self.store()
        old = dict(empty_wifi_state(), revision=1)
        new = dict(empty_wifi_state(), revision=2)
        normal.save("wifi.v1.json", old, validate_wifi_state)

        def fail(source, target):
            return source.endswith(".new") and target.endswith("wifi.v1.json")

        failing = self.store(FailingOS(os, fail))
        with self.assertRaises(OSError):
            failing.save("wifi.v1.json", new, validate_wifi_state)
        self.assertEqual(
            normal.load("wifi.v1.json", validate_wifi_state, empty_wifi_state()),
            old,
        )

    def test_primary_to_backup_failure_keeps_old_primary(self):
        import os
        normal = self.store()
        old = dict(empty_wifi_state(), revision=1)
        new = dict(empty_wifi_state(), revision=2)
        normal.save("wifi.v1.json", old, validate_wifi_state)

        def fail(source, target):
            return source.endswith("wifi.v1.json") and target.endswith(".bak")

        failing = self.store(FailingOS(os, fail))
        with self.assertRaises(OSError):
            failing.save("wifi.v1.json", new, validate_wifi_state)
        self.assertEqual(
            normal.load("wifi.v1.json", validate_wifi_state, empty_wifi_state()),
            old,
        )

    def test_size_limit_applies_to_reads_and_writes(self):
        store = self.store(maximum=32)
        with self.assertRaisesRegex(StateError, "too large"):
            store.save(
                "wifi.v1.json", empty_wifi_state(), validate_wifi_state
            )
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "wifi.v1.json").write_text("x" * 33)
        with self.assertRaisesRegex(StateError, "corrupt"):
            store.load("wifi.v1.json", validate_wifi_state, empty_wifi_state())


class WifiProfilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = StateStore(str(pathlib.Path(self.temp.name) / "state"))
        counter = [0]

        def random_bytes(length):
            counter[0] += 1
            return bytes([counter[0]]) * length

        self.profiles = WifiProfiles(self.store, random_bytes)
        self.profiles.load()

    def tearDown(self):
        self.temp.cleanup()

    def test_save_select_update_and_remove(self):
        first = self.profiles.save_network(b"first", "password1")
        second = self.profiles.save_network(b"second", "password2", True)
        self.assertEqual(self.profiles.selected_profile()["id"], second)
        self.profiles.save_network(b"first", "changed-pass")
        self.assertEqual(self.profiles.selected_profile()["id"], first)
        self.assertEqual(self.profiles.selected_credentials(), (b"first", "changed-pass"))
        self.assertEqual(len(self.profiles.state["networks"]), 2)
        self.profiles.remove(first)
        self.assertEqual(self.profiles.selected_profile()["id"], second)

    def test_saved_network_limit_is_checked(self):
        for index in range(5):
            self.profiles.save_network(
                ("network-%d" % index).encode(), "password1"
            )
        with self.assertRaisesRegex(StateError, "limit"):
            self.profiles.save_network(b"network-6", "password1")

    def test_failed_update_does_not_change_live_credentials(self):
        self.profiles.save_network(b"home", "old-password")
        original = self.store.save

        def fail(*args):
            raise OSError(5)

        self.store.save = fail
        with self.assertRaises(OSError):
            self.profiles.save_network(b"home", "new-password")
        self.store.save = original
        self.assertEqual(
            self.profiles.selected_credentials(), (b"home", "old-password")
        )

    def test_forget_scrubs_password_from_recovery_backup(self):
        network_id = self.profiles.save_network(b"home", "private-password")
        self.profiles.remove(network_id)
        root = pathlib.Path(self.temp.name) / "state"
        self.assertNotIn(
            "private-password", (root / "wifi.v1.json.bak").read_text()
        )
        (root / "wifi.v1.json").write_text("{broken")
        recovered = WifiProfiles(self.store)
        recovered.load()
        self.assertIsNone(recovered.selected_credentials())

    def test_scan_results_are_deduplicated_sorted_and_secret_free(self):
        saved = self.profiles.save_network(b"saved", "private-password")
        results = [
            (b"open", b"a" * 6, 1, -70, 0, 1),
            (b"open", b"b" * 6, 1, -40, 0, 1),
            (b"secured", b"c" * 6, 6, -50, 3, 1),
        ]
        public = self.profiles.setup_networks(results)
        self.assertEqual(public[0]["savedId"], saved)
        self.assertEqual(
            next(item for item in public if item["ssid"] == "open")["rssi"], -40
        )
        self.assertNotIn("password", repr(public).lower())
        self.assertNotIn("private-password", repr(public))

    def test_password_and_schema_validation(self):
        for password in ("short", "bad\npassword", "x" * 65):
            with self.subTest(password=password), self.assertRaises(StateError):
                validate_password(password)
        self.assertEqual(validate_password(""), "open")
        self.assertEqual(validate_password("12345678"), "secured")
        with self.assertRaises(StateError):
            validate_wifi_state({"schema": 2, "revision": 0, "networks": []})
        with self.assertRaises(StateError):
            validate_wifi_state({
                "schema": 1, "revision": 0, "selected": "missing",
                "networks": [],
            })


if __name__ == "__main__":
    unittest.main()
