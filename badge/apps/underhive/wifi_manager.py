"""Saved Wi-Fi profiles and scan normalization."""

try:
    import ubinascii as binascii
except ImportError:
    import binascii
import os

try:
    from .defaults import MAX_SAVED_NETWORKS, STATE_SCHEMA, WIFI_STATE_FILE
    from .state_store import StateError
except ImportError:
    from defaults import MAX_SAVED_NETWORKS, STATE_SCHEMA, WIFI_STATE_FILE
    from state_store import StateError

_HEX = "0123456789abcdefABCDEF"


def _is_int(value):
    return type(value) is int


def _ssid_hex(ssid):
    if isinstance(ssid, str):
        ssid = ssid.encode("utf-8")
    if not isinstance(ssid, (bytes, bytearray)) or not 1 <= len(ssid) <= 32:
        raise StateError("invalid Wi-Fi name")
    return binascii.hexlify(bytes(ssid)).decode()


def decode_ssid(value):
    if not isinstance(value, str) or not value or len(value) > 64:
        raise StateError("invalid saved Wi-Fi name")
    if len(value) % 2 or any(char not in _HEX for char in value):
        raise StateError("invalid saved Wi-Fi name")
    try:
        ssid = binascii.unhexlify(value)
    except (TypeError, ValueError):
        raise StateError("invalid saved Wi-Fi name") from None
    if not 1 <= len(ssid) <= 32:
        raise StateError("invalid saved Wi-Fi name")
    return ssid


def display_ssid(ssid):
    try:
        return ssid.decode("utf-8")
    except (UnicodeError, AttributeError):
        return "<" + binascii.hexlify(ssid).decode() + ">"


def validate_password(password):
    if not isinstance(password, str):
        raise StateError("invalid Wi-Fi password")
    if not password:
        return "open"
    if len(password) == 64 and all(char in _HEX for char in password):
        return "secured"
    if not 8 <= len(password) <= 63:
        raise StateError("invalid Wi-Fi password")
    if any(ord(char) < 32 or ord(char) > 126 for char in password):
        raise StateError("invalid Wi-Fi password")
    return "secured"


def validate_wifi_state(value):
    if not isinstance(value, dict) or value.get("schema") != STATE_SCHEMA:
        raise StateError("unsupported Wi-Fi state")
    revision = value.get("revision")
    selected = value.get("selected")
    networks = value.get("networks")
    if not _is_int(revision) or revision < 0:
        raise StateError("invalid Wi-Fi revision")
    if selected is not None and not isinstance(selected, str):
        raise StateError("invalid selected network")
    if not isinstance(networks, list) or len(networks) > MAX_SAVED_NETWORKS:
        raise StateError("invalid saved networks")

    ids = set()
    clean = []
    for entry in networks:
        if not isinstance(entry, dict):
            raise StateError("invalid saved network")
        network_id = entry.get("id")
        if (not isinstance(network_id, str) or not 1 <= len(network_id) <= 24
                or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in network_id)
                or network_id in ids):
            raise StateError("invalid saved network ID")
        ids.add(network_id)
        ssid_hex = entry.get("ssidHex")
        decode_ssid(ssid_hex)
        password = entry.get("password")
        security = validate_password(password)
        if entry.get("security") != security:
            raise StateError("invalid saved network security")
        hidden = entry.get("hidden")
        priority = entry.get("priority")
        failures = entry.get("failureCount")
        disabled = entry.get("disabled")
        if type(hidden) is not bool or type(disabled) is not bool:
            raise StateError("invalid saved network flags")
        if not _is_int(priority) or not 0 <= priority <= 1000:
            raise StateError("invalid saved network priority")
        if not _is_int(failures) or not 0 <= failures <= 1000:
            raise StateError("invalid saved network failure count")
        clean.append({
            "id": network_id,
            "ssidHex": ssid_hex.lower(),
            "password": password,
            "security": security,
            "hidden": hidden,
            "priority": priority,
            "failureCount": failures,
            "disabled": disabled,
        })
    if selected is not None and selected not in ids:
        raise StateError("selected network is missing")
    return {
        "schema": STATE_SCHEMA,
        "revision": revision,
        "selected": selected,
        "networks": clean,
    }


def empty_wifi_state():
    return {"schema": STATE_SCHEMA, "revision": 0, "selected": None, "networks": []}


class WifiProfiles:
    def __init__(self, store, random_bytes=None):
        self.store = store
        self.random_bytes = random_bytes or os.urandom
        self.state = empty_wifi_state()

    def load(self):
        self.state = self.store.load(
            WIFI_STATE_FILE, validate_wifi_state, empty_wifi_state()
        )
        return self.state

    def _new_id(self):
        for _ in range(8):
            value = "net-" + binascii.hexlify(self.random_bytes(4)).decode()
            if not any(entry["id"] == value for entry in self.state["networks"]):
                return value
        raise StateError("cannot allocate network ID")

    def selected_profile(self):
        selected = self.state.get("selected")
        candidates = [entry for entry in self.state["networks"] if not entry["disabled"]]
        candidates.sort(key=lambda entry: (
            entry["id"] != selected,
            -entry["priority"],
            entry["failureCount"],
        ))
        return candidates[0] if candidates else None

    def selected_credentials(self):
        profile = self.selected_profile()
        if profile is None:
            return None
        return decode_ssid(profile["ssidHex"]), profile["password"]

    def profile_for_ssid(self, ssid):
        ssid_hex = _ssid_hex(ssid)
        for entry in self.state["networks"]:
            if entry["ssidHex"] == ssid_hex and not entry["disabled"]:
                return entry
        return None

    def save_network(self, ssid, password, hidden=False):
        ssid_hex = _ssid_hex(ssid)
        security = validate_password(password)
        if type(hidden) is not bool:
            raise StateError("invalid hidden-network flag")
        networks = [dict(entry) for entry in self.state["networks"]]
        match = None
        for entry in networks:
            if entry["ssidHex"] == ssid_hex:
                match = entry
                break
        if match is None:
            if len(networks) >= MAX_SAVED_NETWORKS:
                raise StateError("saved network limit reached")
            match = {
                "id": self._new_id(),
                "priority": 100,
                "failureCount": 0,
                "disabled": False,
            }
            networks.append(match)
        match.update({
            "ssidHex": ssid_hex,
            "password": password,
            "security": security,
            "hidden": hidden,
            "failureCount": 0,
            "disabled": False,
        })
        updated = {
            "schema": STATE_SCHEMA,
            "revision": self.state["revision"] + 1,
            "selected": match["id"],
            "networks": networks,
        }
        self.state = self.store.save(WIFI_STATE_FILE, updated, validate_wifi_state)
        return match["id"]

    def remove(self, network_id):
        if not isinstance(network_id, str):
            raise StateError("invalid network ID")
        networks = [entry for entry in self.state["networks"]
                    if entry["id"] != network_id]
        if len(networks) == len(self.state["networks"]):
            raise StateError("saved network not found")
        selected = self.state["selected"]
        if selected == network_id:
            selected = networks[0]["id"] if networks else None
        updated = {
            "schema": STATE_SCHEMA,
            "revision": self.state["revision"] + 1,
            "selected": selected,
            "networks": networks,
        }
        self.state = self.store.save(WIFI_STATE_FILE, updated, validate_wifi_state)
        scrub = getattr(self.store, "scrub_backup", None)
        if callable(scrub):
            scrub(WIFI_STATE_FILE, self.state, validate_wifi_state)

    def setup_networks(self, scan_results):
        visible = {}
        for result in scan_results or ():
            if not isinstance(result, (tuple, list)) or len(result) < 5:
                continue
            ssid = result[0]
            if not isinstance(ssid, (bytes, bytearray)) or not ssid:
                continue
            ssid = bytes(ssid[:32])
            key = _ssid_hex(ssid)
            rssi = result[3] if _is_int(result[3]) else -1000
            current = visible.get(key)
            if current is None or rssi > current["rssi"]:
                visible[key] = {
                    "ssid": display_ssid(ssid),
                    "ssidHex": key,
                    "security": "open" if result[4] == 0 else "secured",
                    "rssi": rssi,
                    "savedId": None,
                }
        for entry in self.state["networks"]:
            key = entry["ssidHex"]
            item = visible.get(key)
            if item is None:
                ssid = decode_ssid(key)
                item = {
                    "ssid": display_ssid(ssid),
                    "ssidHex": key,
                    "security": entry["security"],
                    "rssi": None,
                    "savedId": entry["id"],
                }
                visible[key] = item
            else:
                item["savedId"] = entry["id"]
        values = list(visible.values())
        values.sort(key=lambda item: (
            item["savedId"] is None,
            -(item["rssi"] if item["rssi"] is not None else -1000),
            item["ssid"],
        ))
        return values[:16]
