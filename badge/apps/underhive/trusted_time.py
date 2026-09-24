"""Fail-closed trusted UTC bootstrap for certificate validation."""

try:
    from .defaults import STATE_SCHEMA, TRUSTED_TIME_FILE
    from .state_store import StateError
except ImportError:
    from defaults import STATE_SCHEMA, TRUSTED_TIME_FILE
    from state_store import StateError

MIN_TRUSTED_UNIX = 1735689600  # 2025-01-01T00:00:00Z
MAX_TRUSTED_UNIX = 4102444800  # 2100-01-01T00:00:00Z


class TrustedTimeError(ValueError):
    pass


def empty_trusted_time_state():
    return {"schema": STATE_SCHEMA, "unixSeconds": None}


def validate_trusted_time_state(value):
    if (not isinstance(value, dict) or value.get("schema") != STATE_SCHEMA
            or set(value) != {"schema", "unixSeconds"}):
        raise StateError("unsupported trusted time state")
    seconds = value.get("unixSeconds")
    if seconds is not None and (
        type(seconds) is not int
        or not MIN_TRUSTED_UNIX <= seconds <= MAX_TRUSTED_UNIX
    ):
        raise StateError("invalid trusted time")
    return {"schema": STATE_SCHEMA, "unixSeconds": seconds}


class TrustedClock:
    def __init__(self, store, time_module, rtc):
        self.store = store
        self.time = time_module
        self.rtc = rtc
        self.state = empty_trusted_time_state()
        self.persisted_seconds = None

    def load(self):
        self.state = self.store.load(
            TRUSTED_TIME_FILE,
            validate_trusted_time_state,
            empty_trusted_time_state(),
        )
        self.persisted_seconds = self.state.get("unixSeconds")
        return self.state

    def _set_rtc(self, seconds):
        epoch = self.time.gmtime(MIN_TRUSTED_UNIX)
        if len(epoch) < 3 or epoch[:3] != (2025, 1, 1):
            raise TrustedTimeError("trusted time epoch unsupported")
        parts = self.time.gmtime(seconds)
        if len(parts) < 7 or not 2025 <= parts[0] <= 2100:
            raise TrustedTimeError("trusted time epoch unsupported")
        self.rtc.datetime((
            parts[0], parts[1], parts[2], parts[6],
            parts[3], parts[4], parts[5], 0,
        ))

    def bootstrap(self):
        trusted = self.state.get("unixSeconds")
        if trusted is None:
            raise TrustedTimeError("trusted time unavailable")
        try:
            current = int(self.time.time())
        except (AttributeError, TypeError, ValueError, OverflowError):
            raise TrustedTimeError("trusted time unavailable") from None
        if current < trusted:
            self._set_rtc(trusted)
            current = int(self.time.time())
        if not trusted <= current <= MAX_TRUSTED_UNIX:
            raise TrustedTimeError("trusted time unavailable")
        return current

    def advance(self, seconds):
        if (type(seconds) is not int
                or not MIN_TRUSTED_UNIX <= seconds <= MAX_TRUSTED_UNIX):
            raise TrustedTimeError("invalid verified time")
        current = self.state.get("unixSeconds")
        if current is not None and seconds < current:
            raise TrustedTimeError("verified time moved backwards")
        updated = {"schema": STATE_SCHEMA, "unixSeconds": seconds}
        self.state = self.store.save(
            TRUSTED_TIME_FILE, updated, validate_trusted_time_state
        )
        self.persisted_seconds = seconds
        return self.state

    def observe(self, seconds, persist_interval=24 * 60 * 60):
        """Accept verified UTC, but limit trusted-time flash writes."""
        if (type(seconds) is not int
                or not MIN_TRUSTED_UNIX <= seconds <= MAX_TRUSTED_UNIX):
            raise TrustedTimeError("invalid verified time")
        current = self.state.get("unixSeconds")
        if current is not None and seconds < current:
            raise TrustedTimeError("verified time moved backwards")
        persisted = self.persisted_seconds
        if persisted is None or seconds - persisted >= persist_interval:
            return self.advance(seconds)
        self.state = {"schema": STATE_SCHEMA, "unixSeconds": seconds}
        return self.state
