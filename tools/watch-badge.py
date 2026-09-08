#!/usr/bin/env python3
"""Capture boot diagnostics without commands or credential output."""

import re
import time
import serial

deadline = time.monotonic() + 65
connection = None
pending = bytearray()
print("Waiting for a badge reset...", flush=True)
try:
    while time.monotonic() < deadline:
        try:
            if connection is None:
                connection = serial.Serial("/dev/cu.usbmodem12101", 115200, timeout=0.2)
                print("USB attached", flush=True)
            data = connection.read(512)
            pending.extend(data)
            while b"\n" in pending:
                raw, _, pending = pending.partition(b"\n")
                line = raw.decode("utf-8", "replace").strip()
                error = re.match(r"([A-Za-z_]\w*(?:Error|Exception)):", line)
                if error:
                    print("ERROR TYPE:", error.group(1), flush=True)
                elif line.startswith('File "') or line.startswith("Traceback"):
                    print(line, flush=True)
                elif line.startswith(("MicroPython ", "MPY:", "Underhive init:", "Underhive Wi-Fi:", "Underhive RAM:")):
                    print(line, flush=True)
            if len(pending) > 4096:
                pending.clear()
        except (serial.SerialException, OSError):
            if connection is not None:
                connection.close()
                connection = None
                pending.clear()
                print("USB detached; waiting for the badge", flush=True)
            time.sleep(0.2)
finally:
    if connection is not None:
        connection.close()
print("Capture complete", flush=True)
