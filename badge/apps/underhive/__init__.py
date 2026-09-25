"""Underhive broadcaster app for the stock MonaOS launcher lifecycle."""

import gc
import sys
import time
import binascii
import os

from badgeware import screen, brushes

try:
    from . import config
    from .defaults import HOSTED_MAX_PNG, HOSTED_RAM_BYTES, SETUP_HOLD_MS
    from .hosted_config import HostedSettings
    from .onboarding import WifiOnboarding
    from .renderer import RawSink, RamPngSink, Rgb332Sink, UnsupportedFirmware
    from .state_store import StateError, StateStore
    from .transport import Transport
    from .wifi_manager import WifiProfiles
except ImportError:
    import config
    from defaults import HOSTED_MAX_PNG, HOSTED_RAM_BYTES, SETUP_HOLD_MS
    from hosted_config import HostedSettings
    from onboarding import WifiOnboarding
    from renderer import RawSink, RamPngSink, Rgb332Sink, UnsupportedFirmware
    from state_store import StateError, StateStore
    from transport import Transport
    from wifi_manager import WifiProfiles

_sink = None
_transport = None
_wlan = None
_credentials = None
_factory_credentials = None
_profiles = None
_onboarding = None
_socket_module = None
_select_module = None
_connecting_since = None
_retry_at = None
_notice = "Starting broadcaster"
_last_notice = None
_notice_started = None
_wifi_state = "Connecting Wi-Fi"
_wifi_errors = {}
_black = None
_white = None
_accent = None
_setup_hold_since = None
_setup_triggered = False
_hosted = None
_clock = None
_ssl_module = None
_boot = None
_claim = None


def _configure_display_rotation():
    rotation = getattr(config, "DISPLAY_ROTATION", 0)
    if type(rotation) is not int or rotation not in (0, 180):
        raise ValueError("DISPLAY_ROTATION must be 0 or 180")
    from badgeware import display
    if not callable(getattr(display, "command", None)):
        raise UnsupportedFirmware("display.command absent")
    # MonaOS starts with MADCTL 0x90. Reverse both axes, preserving scan order.
    # The native binding takes a tuple, not bytes or an integer.
    display.command(0x36, (0x50 if rotation == 180 else 0x90,))


def _wifi_credentials():
    # MonaOS restores /secrets.py from /system on a hardware reset.
    # Read the persistent file before either the boot copy or a cached module.
    for filename in ("/system/secrets.py", "/secrets.py"):
        try:
            with open(filename, "r") as source:
                settings = {}
                exec(source.read(), settings)
        except OSError as error:
            if not error.args or error.args[0] != 2:
                raise
            continue
        ssid = settings.get("WIFI_SSID")
        password = settings.get("WIFI_PASSWORD")
        if not isinstance(ssid, str) or not isinstance(password, str):
            raise ValueError("invalid saved Wi-Fi settings")
        print("Underhive Wi-Fi source:", filename)
        return (ssid, password) if ssid else None
    sys.path.insert(0, "/")
    try:
        from secrets import WIFI_SSID, WIFI_PASSWORD
        if not isinstance(WIFI_SSID, str) or not isinstance(WIFI_PASSWORD, str):
            return None
        print("Underhive Wi-Fi source: factory module")
        return (WIFI_SSID, WIFI_PASSWORD) if WIFI_SSID else None
    except ImportError:
        return None
    finally:
        sys.path.pop(0)


def _show_notice(message, detail=None):
    global _last_notice, _notice_started
    now = time.ticks_ms()
    if _notice_started is None:
        _notice_started = now
    elapsed = max(0, time.ticks_diff(now, _notice_started))
    phase = (elapsed // 350) % 4
    stamp = (message, detail, phase, elapsed // 1000)
    if stamp == _last_notice:
        return
    _last_notice = stamp
    screen.brush = _black
    screen.clear()
    screen.brush = _accent
    screen.text("UNDERHIVE" + "." * phase, 8, 12)
    screen.brush = _white
    screen.text(message, 8, 42)
    screen.text(detail or "%ds elapsed" % (elapsed // 1000), 8, 66)
    screen.text("HOME: return to menu", 8, 99)


def _hosted_claim_changed(claim):
    global _claim, _last_notice
    _claim = claim
    _last_notice = None


def _report_mode(enabled, source):
    mode = "hosted" if enabled else "local"
    print("Underhive mode: %s; hosted state: %s" % (
        mode, source or "unknown"
    ))


def _show_claim():
    global _last_notice
    if _claim is None or _transport is None:
        return False
    seconds = _transport.claim_seconds()
    if seconds is None:
        return False
    retry = _transport.retry_seconds(time.ticks_ms())
    detail = "Enter in hosted app"
    if retry is not None and _transport.error_code is not None:
        detail = "%s; retry %ds" % (_transport.error_code, retry)
    minutes, remainder = divmod(seconds, 60)
    stamp = (_claim["code"], seconds, detail)
    if stamp == _last_notice:
        return True
    _last_notice = stamp
    screen.brush = _black
    screen.clear()
    screen.brush = _accent
    screen.text("CLAIM UNDERHIVE", 8, 8)
    screen.brush = _white
    screen.text("Code: " + _claim["code"], 20, 37)
    screen.text("Expires in %d:%02d" % (minutes, remainder), 20, 61)
    screen.text(detail, 8, 82)
    screen.text("HOME: return to menu", 8, 103)
    return True


def _start_playback():
    global _sink, _transport
    if _transport is not None:
        return
    gc.collect()
    print("Underhive RAM: before display", gc.mem_free())
    if _hosted is not None and _hosted.enabled:
        import vfs
        _sink = RamPngSink(
            screen, vfs, gc.mem_free(), HOSTED_RAM_BYTES, HOSTED_MAX_PNG
        )
    elif config.FRAME_FORMAT == "rgba":
        _sink = RawSink(screen)
    elif config.FRAME_FORMAT in ("png", "rgb332"):
        import vfs
        sink_type = Rgb332Sink if config.FRAME_FORMAT == "rgb332" else RamPngSink
        _sink = sink_type(screen, vfs, gc.mem_free())
    else:
        raise ValueError("unsupported configured format")
    if _hosted is not None and _hosted.enabled:
        try:
            from .hosted_client import HostedClient
        except ImportError:
            from hosted_client import HostedClient
        _transport = HostedClient(
            _sink, _hosted.state, _clock, _socket_module, _ssl_module,
            time.ticks_diff, time.ticks_add, _boot, "MonaOS-4.03",
            getattr(config, "TARGET_FPS", 8), _hosted_claim_changed,
        )
    else:
        _transport = Transport(
            _sink, config.SERVER_URL, config.DEVICE_TOKEN, config.DEVICE_ID,
            _socket_module, _select_module, time.ticks_diff, time.ticks_add,
            config.TARGET_FPS
        )
    print("Underhive RAM: after transport", gc.mem_free())
    _wlan.active(True)


def _stop_playback():
    global _sink, _transport
    if _transport is not None:
        _transport.close()
        _transport = None
    if _sink is not None:
        _sink.close()
        _sink = None


def _preferred_credentials():
    saved = _profiles.selected_credentials() if _profiles is not None else None
    return saved or _factory_credentials


def _setup_requested(now):
    global _setup_hold_since, _setup_triggered
    try:
        from badgeware import io
    except ImportError:
        return False
    held = getattr(io, "held", ())
    both = (getattr(io, "BUTTON_A", None) in held
            and getattr(io, "BUTTON_C", None) in held)
    if not both:
        _setup_hold_since = None
        _setup_triggered = False
        return False
    if _setup_hold_since is None:
        _setup_hold_since = now
        return False
    if (not _setup_triggered
            and time.ticks_diff(now, _setup_hold_since) >= SETUP_HOLD_MS):
        _setup_triggered = True
        return True
    return False


def _setup_cancel_pressed():
    try:
        from badgeware import io
    except ImportError:
        return False
    return getattr(io, "BUTTON_B", None) in getattr(io, "pressed", ())


def _show_setup():
    state = _onboarding.state
    screen.brush = _black
    screen.clear()
    screen.brush = _accent
    screen.text("WI-FI SETUP", 8, 8)
    screen.brush = _white
    if state == "scanning":
        screen.text("Scanning networks", 8, 34)
        screen.text("B: cancel", 8, 99)
        return
    if state == "joining":
        screen.text(_onboarding.message, 8, 34)
        screen.text("Testing connection", 8, 56)
        screen.text("B: cancel", 8, 99)
        return
    screen.text(_onboarding.message or "Join this network", 8, 28)
    screen.text(_onboarding.ap_ssid, 8, 45)
    screen.text("Key: " + _onboarding.ap_password, 8, 62)
    screen.text(_onboarding.url, 8, 79)
    screen.text("B: cancel", 8, 103)


def _begin_setup(now):
    global _notice, _connecting_since, _retry_at
    _stop_playback()
    _connecting_since = None
    _retry_at = None
    _notice = "Starting Wi-Fi setup"
    _onboarding.begin(now)


def _complete_setup(result):
    global _credentials, _notice, _wlan, _connecting_since, _retry_at
    status, credentials = result
    _wlan = _onboarding.sta
    _onboarding.close()
    _connecting_since = None
    _retry_at = None
    if status == "connected":
        _credentials = credentials
        _notice = "Connecting broadcaster"
    else:
        _credentials = _preferred_credentials()
        _notice = ("Hold A+C: Wi-Fi setup" if _credentials is None
                   else "Connecting Wi-Fi")
    if _credentials is not None or _wlan.isconnected():
        _start_playback()


def init():
    global _sink, _transport, _wlan, _credentials, _notice
    global _connecting_since, _retry_at, _last_notice, _black, _white, _accent
    global _notice_started, _wifi_state, _wifi_errors
    global _profiles, _onboarding, _factory_credentials
    global _socket_module, _select_module, _setup_hold_since, _setup_triggered
    global _hosted, _clock, _ssl_module, _boot, _claim
    _last_notice = None
    _notice_started = time.ticks_ms()
    _wifi_state = "Connecting Wi-Fi"
    _connecting_since = None
    _retry_at = None
    _black = brushes.color(10, 12, 14)
    _white = brushes.color(215, 220, 220)
    _accent = brushes.color(220, 250, 85)
    _setup_hold_since = None
    _setup_triggered = False
    _claim = None
    try:
        _configure_display_rotation()
        import network
        import socket
        import select
        _socket_module = socket
        _select_module = select
        _wifi_errors = {
            getattr(network, "STAT_NO_AP_FOUND", -2): "Wi-Fi network not found",
            getattr(network, "STAT_WRONG_PASSWORD", -3): "Wi-Fi password rejected",
            getattr(network, "STAT_CONNECT_FAIL", -1): "Wi-Fi connection failed",
        }
        store = StateStore()
        _hosted = HostedSettings(store)
        _hosted.load()
        _report_mode(_hosted.enabled, store.last_source)
        if _hosted.enabled:
            import machine
            import ssl
            try:
                from .trusted_time import TrustedClock
            except ImportError:
                from trusted_time import TrustedClock
            _ssl_module = ssl
            _clock = TrustedClock(store, time, machine.RTC())
            _clock.load()
            _clock.bootstrap()
            _boot = binascii.hexlify(os.urandom(8)).decode()
        else:
            # Validate local credentials before reserving graphics RAM.
            try:
                from .protocol import validate_config
            except ImportError:
                from protocol import validate_config
            validate_config(
                config.SERVER_URL, config.DEVICE_TOKEN, config.DEVICE_ID
            )
        _factory_credentials = _wifi_credentials()
        _profiles = WifiProfiles(store)
        try:
            _profiles.load()
        except StateError as error:
            print("Underhive state:", type(error).__name__)
        _credentials = _preferred_credentials()
        _wlan = network.WLAN(network.STA_IF)
        _onboarding = WifiOnboarding(
            network, socket, _profiles, time.ticks_diff
        )
        if not _wlan.isconnected() and _credentials is None:
            _wlan.active(True)
            _notice = "Hold A+C: Wi-Fi setup"
            return
        _start_playback()
        _notice = "Connecting Wi-Fi"
    except MemoryError as error:
        _notice = "Not enough free RAM"
        print("Underhive init:", type(error).__name__)
        on_exit()
    except (ImportError, UnsupportedFirmware) as error:
        _notice = "Firmware API unsupported"
        print("Underhive init:", type(error).__name__)
        on_exit()
    except (ValueError, OSError) as error:
        _notice = "Check app configuration"
        print("Underhive init:", type(error).__name__)
        on_exit()
    _show_notice(_notice)


def _connected(now):
    global _connecting_since, _retry_at, _wifi_state
    if _wlan.isconnected():
        _connecting_since = None
        _retry_at = None
        return True
    if _credentials is None:
        return False
    if _connecting_since is not None:
        elapsed = time.ticks_diff(now, _connecting_since)
        status = _wlan.status()
        if elapsed >= 30000 or (elapsed >= 1000 and status < 0):
            _wifi_state = _wifi_errors.get(status, "Wi-Fi join timed out")
            print("Underhive Wi-Fi status:", status)
            _wlan.disconnect()
            _connecting_since = None
            _retry_at = time.ticks_add(now, 15000)
        return False
    if _retry_at is None or time.ticks_diff(now, _retry_at) >= 0:
        _wlan.connect(*_credentials)
        _connecting_since = now
        _wifi_state = "Joining Wi-Fi"
    return False


def update():
    global _last_notice, _retry_at, _wifi_state
    now = time.ticks_ms()
    if _onboarding is not None and _onboarding.active:
        if _setup_cancel_pressed():
            _onboarding.cancel()
        _onboarding.update(now)
        result = _onboarding.take_result()
        if result is not None:
            try:
                _complete_setup(result)
            except (MemoryError, OSError, ValueError, UnsupportedFirmware) as error:
                print("Underhive setup:", type(error).__name__)
                _stop_playback()
        if _onboarding.active:
            _show_setup()
            return
    if _onboarding is not None and _setup_requested(now):
        _begin_setup(now)
        _show_setup()
        return
    if _transport is None:
        _show_notice(_notice)
        return
    _transport.confirm_presented(now)
    try:
        connected = _connected(now)
        if not connected:
            # Service pending WLAN work while no socket is active yet.
            time.sleep_ms(1)
    except OSError as error:
        print("Underhive Wi-Fi:", type(error).__name__)
        _wifi_state = "Wi-Fi connection error"
        _retry_at = time.ticks_add(now, 15000)
        connected = False
    _transport.update(now, connected)
    if not connected:
        _show_notice(_wifi_state)
    elif _show_claim():
        return
    elif _transport.status not in ("Live", "Paused"):
        retry = _transport.retry_seconds(now)
        detail = None
        if retry is not None and _transport.error_code is not None:
            detail = "%s; retry %ds" % (_transport.error_code, retry)
        elif _transport.error_code is not None:
            detail = "Code: " + _transport.error_code
        _show_notice(_transport.status, detail)
    else:
        _last_notice = None


def on_exit():
    global _credentials, _claim
    # The stock HOME IRQ invokes this before resetting; do not disconnect a
    # shared Wi-Fi connection, sleep, retry, or write persistent state here.
    if _onboarding is not None:
        _onboarding.close()
    _stop_playback()
    _credentials = None
    _claim = None
