#!/usr/bin/env python3
"""Set badge Wi-Fi from a local terminal without logging credentials."""

import argparse
import getpass
from pathlib import Path
import sys

from mpremote.transport import TransportError
from badge_connection import connect_badge


def source_for(ssid, password):
    return """
import os, sys, time, network
sys.path.insert(0, "/")
try:
    with open("/secrets.py", "r") as current:
        original = current.read()
except OSError as error:
    if error.args[0] != 2:
        raise
    import secrets
    original = ""
    for name in dir(secrets):
        value = getattr(secrets, name)
        if not name.startswith("_") and type(value) in (str, int, float, bool):
            original += name + " = " + repr(value) + "\\n"
try:
    os.stat("/secrets.py.before-underhive")
except OSError as error:
    if error.args[0] != 2:
        raise
    with open("/secrets.py.before-underhive", "w") as backup:
        backup.write(original)
ssid = %s
password = %s
with open("/secrets.py.underhive.tmp", "w") as updated:
    updated.write(original)
    updated.write("\\n# Underhive Wi-Fi configuration\\n")
    updated.write("WIFI_SSID = " + repr(ssid) + "\\n")
    updated.write("WIFI_PASSWORD = " + repr(password) + "\\n")
os.rename("/secrets.py.underhive.tmp", "/secrets.py")
print("BADGE_PROBE wifi_saved=True")
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.disconnect()
wlan.connect(ssid, password)
started = time.ticks_ms()
while not wlan.isconnected() and time.ticks_diff(time.ticks_ms(), started) < 15000:
    time.sleep_ms(100)
print("BADGE_PROBE wifi_status=" + str(wlan.status()))
print("BADGE_PROBE wifi_connected=" + str(wlan.isconnected()))
print("BADGE_PROBE complete=True")
""" % (ascii(ssid), ascii(password))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/cu.usbmodem12101")
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error("Run this command in a local interactive terminal.")
    if Path("/Volumes/BADGER").exists():
        parser.error("Eject BADGER and press RESET once before this command.")
    transport = None
    try:
        print("Connecting to the badge before asking for Wi-Fi details...")
        transport = connect_badge(args.port)
        print("USB connection ready.")
        print("Use a 2.4 GHz Wi-Fi network that can reach your Mac.")
        print("Both entries are hidden. Nothing is saved on the Mac.")
        ssid = getpass.getpass("Wi-Fi name (SSID): ")
        password = getpass.getpass("Wi-Fi password: ")
        if not 1 <= len(ssid.encode("utf-8")) <= 32:
            parser.error("The Wi-Fi name must contain 1-32 bytes.")
        if len(password.encode("utf-8")) > 64:
            parser.error("The Wi-Fi password is too long.")
        output, error = transport.exec_raw(source_for(ssid, password), timeout=30)
        for line in output.decode("utf-8", "replace").splitlines():
            if line.startswith("BADGE_PROBE "):
                print(line)
        if error or b"BADGE_PROBE complete=True" not in output:
            raise RuntimeError("The badge did not complete Wi-Fi configuration. Device error text is hidden to protect credentials.")
        print("Settings saved on the badge. The previous settings have a private backup there.")
        print("Press RESET once. Pass the Universe screen, then select underhive.")
    except (OSError, TransportError) as error:
        print("USB setup failed: " + type(error).__name__ + ".")
        print("Press RESET once, wait for the Universe screen, and run this command again.")
        raise SystemExit(1) from None
    finally:
        if transport is not None:
            transport.close()


if __name__ == "__main__":
    main()
