#!/usr/bin/env python3
"""Check saved Wi-Fi without displaying its name or password."""

from badge_connection import connect_badge

transport = connect_badge("/dev/cu.usbmodem12101")
try:
    output, error = transport.exec_raw("""
import network, time, gc
saved = {}
exec(open("/system/secrets.py").read(), saved)
w = network.WLAN(network.STA_IF)
w.active(False)
time.sleep_ms(300)
w.active(True)
w.disconnect()
w.connect(saved["WIFI_SSID"], saved["WIFI_PASSWORD"])
for i in range(25):
    print("WIFI_STATUS", i, w.status(), w.isconnected())
    if w.isconnected():
        break
    time.sleep_ms(1000)
print("FREE_RAM", gc.mem_free())
""", timeout=35)
    print(output.decode("utf-8", "replace"))
    if error:
        raise RuntimeError("The Wi-Fi check failed; device error details were withheld.")
finally:
    transport.close()
