import pathlib
import sys
import types
import unittest

APP = pathlib.Path(__file__).resolve().parents[1] / "apps/underhive"
sys.path.insert(0, str(APP))

import onboarding
from onboarding import WifiOnboarding
from state_store import StateError
from wifi_manager import WifiProfiles, empty_wifi_state, validate_wifi_state


class MemoryStore:
    def __init__(self):
        self.value = empty_wifi_state()
        self.fail_save = False

    def load(self, name, validator, default):
        return validator(self.value)

    def save(self, name, value, validator):
        if self.fail_save:
            raise OSError(5)
        self.value = validator(value)
        return self.value


class FakeWlan:
    SEC_WPA_WPA2 = 7

    def __init__(self, interface):
        self.interface = interface
        self.active_values = []
        self.config_values = []
        self.connected = False
        self.status_value = 1
        self.connect_values = []
        self.disconnects = 0
        self.scan_values = [
            (b"visible", b"a" * 6, 6, -40, 3, 1),
            (b"open", b"b" * 6, 1, -60, 0, 1),
        ]

    def active(self, value=None):
        if value is None:
            return self.active_values[-1] if self.active_values else False
        self.active_values.append(value)

    def scan(self):
        return self.scan_values

    def disconnect(self):
        self.disconnects += 1
        self.connected = False

    def connect(self, *values):
        self.connect_values.append(values)

    def isconnected(self):
        return self.connected

    def status(self):
        return self.status_value

    def config(self, **values):
        self.config_values.append(values)

    def ifconfig(self):
        return ("192.168.4.1", "255.255.255.0", "192.168.4.1", "192.168.4.1")


class FakeNetwork:
    STA_IF = 0
    AP_IF = 1
    STAT_NO_AP_FOUND = -2
    STAT_WRONG_PASSWORD = -3
    STAT_CONNECT_FAIL = -1

    def __init__(self):
        self.sta = FakeWlan(self.STA_IF)
        self.aps = []

    def WLAN(self, interface):
        if interface == self.STA_IF:
            return self.sta
        ap = FakeWlan(interface)
        self.aps.append(ap)
        return ap


class FakeServer:
    instances = []

    def __init__(self, socket_module, nonce, networks, port):
        self.nonce = nonce
        self.networks = list(networks)
        self.port = port
        self.action = None
        self.last_activity = None
        self.status = ""
        self.closed = False
        self.started = None
        self.__class__.instances.append(self)

    def set_status(self, value):
        self.status = value

    def set_networks(self, values):
        self.networks = list(values)

    def start(self, now):
        self.started = now
        self.last_activity = now

    def update(self, now, ticks_diff):
        pass

    def pop_action(self):
        value = self.action
        self.action = None
        return value

    def close(self):
        self.closed = True


class OnboardingTests(unittest.TestCase):
    def setUp(self):
        FakeServer.instances = []
        self.network = FakeNetwork()
        self.store = MemoryStore()
        counter = [0]

        def random_bytes(length):
            counter[0] += 1
            return bytes([counter[0]]) * length

        self.profiles = WifiProfiles(self.store, random_bytes)
        self.profiles.load()
        self.controller = WifiOnboarding(
            self.network, object(), self.profiles, lambda a, b: a - b,
            random_bytes=random_bytes, server_factory=FakeServer,
        )

    def start(self):
        self.controller.begin(0)
        self.controller.update(1)
        self.assertEqual(self.controller.state, "serving")
        return FakeServer.instances[-1]

    def test_scan_stops_sta_and_starts_wpa_ap_with_manual_url(self):
        server = self.start()
        ap = self.network.aps[-1]
        self.assertEqual(ap.config_values, [{
            "ssid": self.controller.ap_ssid,
            "security": ap.SEC_WPA_WPA2,
            "key": self.controller.ap_password,
            "channel": onboarding.SETUP_CHANNEL,
        }])
        self.assertEqual(ap.active_values, [False, True])
        self.assertEqual(self.controller.url, "http://192.168.4.1/")
        self.assertEqual(server.port, onboarding.SETUP_HTTP_PORT)
        self.assertTrue(any(item["ssid"] == "visible" for item in server.networks))

    def test_credentials_are_saved_only_after_successful_join(self):
        server = self.start()
        server.action = {
            "type": "apply", "ssidHex": "76697369626c65", "ssid": "",
            "password": "password1", "hidden": False,
        }
        self.controller.update(2)
        self.assertEqual(self.controller.state, "joining")
        self.assertEqual(self.profiles.state["networks"], [])
        self.assertEqual(
            self.network.sta.connect_values[-1], (b"visible", "password1")
        )
        self.network.sta.connected = True
        self.controller.update(3)
        self.assertEqual(self.controller.take_result(), (
            "connected", (b"visible", "password1")
        ))
        self.assertEqual(self.profiles.selected_credentials(), (
            b"visible", "password1"
        ))

    def test_saved_password_is_reused_without_phone_round_trip(self):
        self.profiles.save_network(b"visible", "saved-password")
        server = self.start()
        server.action = {
            "type": "apply", "ssidHex": "76697369626c65", "ssid": "",
            "password": "", "hidden": False,
        }
        self.controller.update(2)
        self.assertEqual(
            self.network.sta.connect_values[-1], (b"visible", "saved-password")
        )

    def test_failed_join_restarts_same_setup_session_without_saving(self):
        server = self.start()
        ssid = self.controller.ap_ssid
        password = self.controller.ap_password
        nonce = self.controller.nonce
        server.action = {
            "type": "apply", "ssidHex": "76697369626c65", "ssid": "",
            "password": "wrong-pass", "hidden": False,
        }
        self.controller.update(2)
        self.network.sta.status_value = self.network.STAT_WRONG_PASSWORD
        self.controller.update(1003)
        self.assertEqual(self.controller.state, "serving")
        self.assertEqual(self.controller.message, "Password rejected")
        self.assertEqual(self.profiles.state["networks"], [])
        self.assertEqual((self.controller.ap_ssid, self.controller.ap_password,
                          self.controller.nonce), (ssid, password, nonce))

    def test_station_connect_error_restarts_ap_instead_of_crashing(self):
        server = self.start()
        original_connect = self.network.sta.connect

        def fail_connect(*values):
            raise OSError(5)

        self.network.sta.connect = fail_connect
        server.action = {
            "type": "apply", "ssidHex": "76697369626c65", "ssid": "",
            "password": "password1", "hidden": False,
        }
        self.controller.update(2)
        self.assertEqual(self.controller.state, "serving")
        self.assertEqual(self.controller.message, "Connection failed")
        self.assertIsNotNone(self.controller.server)
        self.network.sta.connect = original_connect
        self.controller.update(3)

    def test_save_failure_restarts_setup_and_keeps_old_state(self):
        server = self.start()
        server.action = {
            "type": "apply", "ssidHex": "76697369626c65", "ssid": "",
            "password": "password1", "hidden": False,
        }
        self.controller.update(2)
        self.store.fail_save = True
        self.network.sta.connected = True
        self.controller.update(3)
        self.assertEqual(self.controller.state, "serving")
        self.assertEqual(self.controller.message, "Could not save Wi-Fi")
        self.assertEqual(self.profiles.state["networks"], [])

    def test_cancel_closes_ap_without_saving(self):
        server = self.start()
        self.controller.cancel()
        self.assertTrue(server.closed)
        self.assertEqual(self.controller.take_result(), ("cancelled", None))
        self.assertEqual(self.profiles.state["networks"], [])

    def test_http_cancel_remove_and_total_timeout(self):
        saved = self.profiles.save_network(b"saved", "password1")
        server = self.start()
        server.action = {"type": "remove", "networkId": saved}
        self.controller.update(2)
        self.assertEqual(self.profiles.state["networks"], [])
        server.action = {"type": "cancel"}
        self.controller.update(3)
        self.assertEqual(self.controller.take_result(), ("cancelled", None))

        self.controller.begin(10)
        self.controller.update(11)
        self.controller.update(10 + onboarding.SETUP_TOTAL_MS)
        self.assertEqual(self.controller.take_result(), ("expired", None))

    def test_invalid_submission_does_not_stop_setup(self):
        server = self.start()
        server.action = {
            "type": "apply", "ssidHex": "", "ssid": "",
            "password": "short", "hidden": False,
        }
        self.controller.update(2)
        self.assertEqual(self.controller.state, "serving")
        self.assertEqual(self.controller.message, "Check the Wi-Fi settings")
        self.assertEqual(self.network.sta.connect_values, [])

    def test_missing_wpa_ap_api_fails_safely(self):
        class UnsupportedAp(FakeWlan):
            SEC_WPA_WPA2 = None

        def wlan(interface):
            if interface == self.network.STA_IF:
                return self.network.sta
            return UnsupportedAp(interface)

        self.network.WLAN = wlan
        self.controller.begin(0)
        self.controller.update(1)
        self.assertEqual(self.controller.take_result(), ("error", None))
        self.assertEqual(self.controller.message, "Wi-Fi setup unsupported")


if __name__ == "__main__":
    unittest.main()
