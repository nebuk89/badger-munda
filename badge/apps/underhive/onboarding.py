"""Badge-hosted AP and manual Wi-Fi setup state machine."""

try:
    import ubinascii as binascii
except ImportError:
    import binascii
import os

try:
    from .defaults import (
        SETUP_CHANNEL, SETUP_ERROR_MIN_MS, SETUP_HTTP_PORT, SETUP_IDLE_MS,
        SETUP_JOIN_MS, SETUP_TOTAL_MS,
    )
    from .setup_http import SetupHttpServer
    from .state_store import StateError
    from .wifi_manager import decode_ssid, validate_password
except ImportError:
    from defaults import (
        SETUP_CHANNEL, SETUP_ERROR_MIN_MS, SETUP_HTTP_PORT, SETUP_IDLE_MS,
        SETUP_JOIN_MS, SETUP_TOTAL_MS,
    )
    from setup_http import SetupHttpServer
    from state_store import StateError
    from wifi_manager import decode_ssid, validate_password

_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def _random_text(length, random_bytes):
    data = random_bytes(length)
    return "".join(_ALPHABET[value % len(_ALPHABET)] for value in data)


class WifiOnboarding:
    def __init__(self, network_module, socket_module, profiles, ticks_diff,
                 random_bytes=None, server_factory=None):
        self.network = network_module
        self.socket_module = socket_module
        self.profiles = profiles
        self.ticks_diff = ticks_diff
        self.random_bytes = random_bytes or os.urandom
        self.server_factory = server_factory or SetupHttpServer
        self.sta = network_module.WLAN(network_module.STA_IF)
        self.ap = None
        self.server = None
        self.state = "idle"
        self.message = ""
        self.result = None
        self.started = None
        self.last_activity = None
        self.join_started = None
        self.candidate = None
        self.scan_results = []
        self.ap_ssid = ""
        self.ap_password = ""
        self.url = ""
        self.nonce = ""

    @property
    def active(self):
        return self.state not in ("idle", "done", "cancelled", "expired")

    def begin(self, now):
        if self.active:
            return
        self.close()
        self.state = "scanning"
        self.message = "Scanning Wi-Fi"
        self.result = None
        self.started = now
        self.last_activity = now
        self.ap_ssid = "UNDERHIVE-" + _random_text(4, self.random_bytes)
        self.ap_password = _random_text(12, self.random_bytes)
        self.nonce = binascii.hexlify(self.random_bytes(16)).decode()

    def _stop_ap(self):
        if self.server is not None:
            self.server.close()
            self.server = None
        if self.ap is not None:
            try:
                self.ap.active(False)
            finally:
                self.ap = None

    def _start_ap(self, now):
        self.sta.disconnect()
        self.sta.active(False)
        self.ap = self.network.WLAN(self.network.AP_IF)
        security = getattr(self.ap, "SEC_WPA_WPA2", None)
        if security is None:
            raise OSError("WPA access point unsupported")
        self.ap.active(False)
        self.ap.config(
            ssid=self.ap_ssid,
            security=security,
            key=self.ap_password,
            channel=SETUP_CHANNEL,
        )
        self.ap.active(True)
        address = self.ap.ifconfig()[0]
        self.url = "http://%s/" % address
        networks = self.profiles.setup_networks(self.scan_results)
        self.server = self.server_factory(
            self.socket_module, self.nonce, networks, SETUP_HTTP_PORT
        )
        self.server.set_status(self.message)
        self.server.start(now)
        self.state = "serving"
        self.last_activity = now

    def _scan(self, now):
        self.sta.active(True)
        self.scan_results = self.sta.scan()
        self.message = ""
        self._start_ap(now)

    def _apply(self, action, now):
        custom = action.get("ssid", "")
        selected = action.get("ssidHex", "")
        if bool(custom) == bool(selected):
            raise StateError("select or enter one Wi-Fi name")
        ssid = custom.encode("utf-8") if custom else decode_ssid(selected)
        if not 1 <= len(ssid) <= 32:
            raise StateError("invalid Wi-Fi name")
        password = action.get("password", "")
        saved = self.profiles.profile_for_ssid(ssid)
        if not password and selected and saved is not None:
            password = saved["password"]
        validate_password(password)
        hidden = action.get("hidden") is True
        self.candidate = (ssid, password, hidden)
        self._stop_ap()
        try:
            self.sta.active(True)
            self.sta.disconnect()
            self.sta.connect(ssid, password)
        except OSError:
            self._restart_after_error(now, "Connection failed")
            return
        self.join_started = now
        self.state = "joining"
        self.message = "Testing " + self._safe_ssid(ssid)

    @staticmethod
    def _safe_ssid(ssid):
        try:
            return ssid.decode("utf-8")
        except UnicodeError:
            return "selected network"

    def _restart_after_error(self, now, message):
        try:
            self.sta.disconnect()
        except OSError:
            pass
        self.message = message
        self.candidate = None
        self.join_started = None
        try:
            self._start_ap(now)
            self.server.set_status(message)
        except (OSError, ValueError):
            self._stop_ap()
            self.state = "cancelled"
            self.message = "Wi-Fi setup unsupported"
            self.result = ("error", None)

    def _joining(self, now):
        if self.sta.isconnected():
            ssid, password, hidden = self.candidate
            try:
                self.profiles.save_network(ssid, password, hidden)
            except (OSError, StateError):
                self._restart_after_error(now, "Could not save Wi-Fi")
                return
            self.result = ("connected", (ssid, password))
            self.state = "done"
            self.message = "Wi-Fi saved"
            self.candidate = None
            return
        elapsed = self.ticks_diff(now, self.join_started)
        status = self.sta.status()
        if elapsed >= SETUP_JOIN_MS or (
                elapsed >= SETUP_ERROR_MIN_MS and status < 0):
            errors = {
                getattr(self.network, "STAT_NO_AP_FOUND", -2): "Network not found",
                getattr(self.network, "STAT_WRONG_PASSWORD", -3): "Password rejected",
                getattr(self.network, "STAT_CONNECT_FAIL", -1): "Connection failed",
            }
            self._restart_after_error(
                now, errors.get(status, "Wi-Fi join timed out")
            )

    def cancel(self):
        if self.state == "joining":
            self.sta.disconnect()
        self._stop_ap()
        self.state = "cancelled"
        self.message = "Setup cancelled"
        self.result = ("cancelled", None)
        self.candidate = None

    def update(self, now):
        if not self.active:
            return
        if self.ticks_diff(now, self.started) >= SETUP_TOTAL_MS:
            self._stop_ap()
            self.state = "expired"
            self.message = "Setup expired"
            self.result = ("expired", None)
            return
        if self.state == "scanning":
            try:
                self._scan(now)
            except (OSError, ValueError):
                self._stop_ap()
                self.state = "cancelled"
                self.message = "Wi-Fi setup unsupported"
                self.result = ("error", None)
            return
        if self.state == "joining":
            self._joining(now)
            return
        if self.state != "serving":
            return
        self.server.update(now, self.ticks_diff)
        if self.server.last_activity is not None:
            self.last_activity = self.server.last_activity
        if self.ticks_diff(now, self.last_activity) >= SETUP_IDLE_MS:
            self._stop_ap()
            self.state = "expired"
            self.message = "Setup expired"
            self.result = ("expired", None)
            return
        action = self.server.pop_action()
        if action is None:
            return
        self.last_activity = now
        try:
            if action["type"] == "cancel":
                self.cancel()
            elif action["type"] == "remove":
                self.profiles.remove(action["networkId"])
                self.server.set_networks(
                    self.profiles.setup_networks(self.scan_results)
                )
                self.server.set_status("Saved network removed")
            elif action["type"] == "apply":
                self._apply(action, now)
        except (OSError, StateError, ValueError):
            if self.server is not None:
                self.server.set_status("Check the Wi-Fi settings")
            self.message = "Check the Wi-Fi settings"

    def take_result(self):
        result = self.result
        self.result = None
        return result

    def close(self):
        self._stop_ap()
        self.candidate = None
        if self.state != "idle":
            self.state = "idle"
