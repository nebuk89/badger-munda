"""Underhive broadcaster app for the stock MonaOS launcher lifecycle."""

import gc
import sys
import time

from badgeware import screen, brushes

try:
    from . import config
    from .renderer import RawSink, RamPngSink, Rgb332Sink, UnsupportedFirmware
    from .transport import Transport
except ImportError:
    import config
    from renderer import RawSink, RamPngSink, Rgb332Sink, UnsupportedFirmware
    from transport import Transport

_sink = None
_transport = None
_wlan = None
_credentials = None
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


def _show_notice(message):
    global _last_notice, _notice_started
    now = time.ticks_ms()
    if _notice_started is None:
        _notice_started = now
    elapsed = max(0, time.ticks_diff(now, _notice_started))
    phase = (elapsed // 350) % 4
    stamp = (message, phase, elapsed // 1000)
    if stamp == _last_notice:
        return
    _last_notice = stamp
    screen.brush = _black
    screen.clear()
    screen.brush = _accent
    screen.text("UNDERHIVE" + "." * phase, 8, 12)
    screen.brush = _white
    screen.text(message, 8, 42)
    screen.text("%ds elapsed" % (elapsed // 1000), 8, 66)
    screen.text("HOME: return to menu", 8, 99)


def init():
    global _sink, _transport, _wlan, _credentials, _notice
    global _connecting_since, _retry_at, _last_notice, _black, _white, _accent
    global _notice_started, _wifi_state, _wifi_errors
    _last_notice = None
    _notice_started = time.ticks_ms()
    _wifi_state = "Connecting Wi-Fi"
    _connecting_since = None
    _retry_at = None
    _black = brushes.color(10, 12, 14)
    _white = brushes.color(215, 220, 220)
    _accent = brushes.color(220, 250, 85)
    try:
        _configure_display_rotation()
        import network
        import socket
        import select
        _wifi_errors = {
            getattr(network, "STAT_NO_AP_FOUND", -2): "Wi-Fi network not found",
            getattr(network, "STAT_WRONG_PASSWORD", -3): "Wi-Fi password rejected",
            getattr(network, "STAT_CONNECT_FAIL", -1): "Wi-Fi connection failed",
        }
        # Validate credentials/config before reserving graphics RAM.
        try:
            from .protocol import validate_config
        except ImportError:
            from protocol import validate_config
        validate_config(config.SERVER_URL, config.DEVICE_TOKEN, config.DEVICE_ID)
        _credentials = _wifi_credentials()
        _wlan = network.WLAN(network.STA_IF)
        if not _wlan.isconnected() and _credentials is None:
            _notice = "Set Wi-Fi on BADGER drive"
            return
        gc.collect()
        print("Underhive RAM: before display", gc.mem_free())
        if config.FRAME_FORMAT == "rgba":
            _sink = RawSink(screen)
        elif config.FRAME_FORMAT in ("png", "rgb332"):
            import vfs
            sink_type = Rgb332Sink if config.FRAME_FORMAT == "rgb332" else RamPngSink
            _sink = sink_type(screen, vfs, gc.mem_free())
        else:
            raise ValueError("unsupported configured format")
        _transport = Transport(
            _sink, config.SERVER_URL, config.DEVICE_TOKEN, config.DEVICE_ID,
            socket, select, time.ticks_diff, time.ticks_add, config.TARGET_FPS
        )
        print("Underhive RAM: after transport", gc.mem_free())
        _wlan.active(True)
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
    if _transport is None:
        _show_notice(_notice)
        return
    now = time.ticks_ms()
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
    elif _transport.status not in ("Live", "Paused"):
        _show_notice(_transport.status)
    else:
        _last_notice = None


def on_exit():
    global _sink, _transport, _credentials
    # The stock HOME IRQ invokes this before resetting; do not disconnect a
    # shared Wi-Fi connection, sleep, retry, or write persistent state here.
    if _transport is not None:
        _transport.close()
        _transport = None
    if _sink is not None:
        _sink.close()
        _sink = None
    _credentials = None
