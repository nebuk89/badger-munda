"""Validated hosted badge settings, separate from Wi-Fi state."""

try:
    from .defaults import (
        HOSTED_SERVICE_ORIGIN, HOSTED_STATE_FILE, STATE_SCHEMA,
    )
    from .state_store import StateError
except ImportError:
    from defaults import HOSTED_SERVICE_ORIGIN, HOSTED_STATE_FILE, STATE_SCHEMA
    from state_store import StateError

_SAFE_SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
_HEX = "0123456789abcdef"


def _uuid(value):
    if not isinstance(value, str) or len(value) != 36:
        raise StateError("invalid badge ID")
    if tuple(value[index] for index in (8, 13, 18, 23)) != ("-", "-", "-", "-"):
        raise StateError("invalid badge ID")
    for index, char in enumerate(value):
        if index not in (8, 13, 18, 23) and char not in _HEX:
            raise StateError("invalid badge ID")
    if value[14] not in "12345" or value[19] not in "89ab":
        raise StateError("invalid badge ID")
    return value


def validate_https_origin(value, allowed_hosts):
    if not isinstance(value, str) or not value.startswith("https://"):
        raise StateError("hosted service must use HTTPS")
    authority = value[8:]
    if (not authority or authority != authority.lower()
            or any(char in authority for char in "/?#@:")
            or authority.startswith(".") or authority.endswith(".")):
        raise StateError("hosted service must be an origin")
    labels = authority.split(".")
    if len(labels) < 2:
        raise StateError("invalid hosted service host")
    for label in labels:
        if (not 1 <= len(label) <= 63 or label[0] == "-"
                or label[-1] == "-"
                or any(not (char.isalnum() or char == "-") for char in label)):
            raise StateError("invalid hosted service host")
    if allowed_hosts is not None and authority not in allowed_hosts:
        raise StateError("hosted service is not allowed")
    return authority, 443, authority


def validate_service_origin(value):
    return validate_https_origin(value, (HOSTED_SERVICE_ORIGIN[8:],))


def empty_hosted_state():
    return {"schema": STATE_SCHEMA, "mode": "local"}


def validate_hosted_state(value):
    if not isinstance(value, dict) or value.get("schema") != STATE_SCHEMA:
        raise StateError("unsupported hosted state")
    mode = value.get("mode")
    if mode == "local":
        if set(value) != {"schema", "mode"}:
            raise StateError("invalid local hosted state")
        return empty_hosted_state()
    if mode != "hosted":
        raise StateError("invalid hosted mode")
    if set(value) != {
        "schema", "mode", "serviceOrigin", "badgeId", "badgeSecret"
    }:
        raise StateError("invalid hosted state fields")
    origin = value.get("serviceOrigin")
    validate_service_origin(origin)
    badge_id = _uuid(value.get("badgeId"))
    secret = value.get("badgeSecret")
    if (not isinstance(secret, str) or len(secret) != 43
            or any(char not in _SAFE_SECRET for char in secret)):
        raise StateError("invalid badge secret")
    return {
        "schema": STATE_SCHEMA,
        "mode": "hosted",
        "serviceOrigin": origin,
        "badgeId": badge_id,
        "badgeSecret": secret,
    }


class HostedSettings:
    def __init__(self, store):
        self.store = store
        self.state = empty_hosted_state()

    def load(self):
        self.state = self.store.load_seeded(
            HOSTED_STATE_FILE, validate_hosted_state, empty_hosted_state()
        )
        return self.state

    @property
    def enabled(self):
        return self.state["mode"] == "hosted"
