"""Reconnect when the stock launcher resets USB after an interrupt."""

import time
from mpremote.transport import TransportError
from mpremote.transport_serial import SerialTransport


def connect_badge(port, attempts=4):
    for attempt in range(attempts):
        transport = None
        try:
            transport = SerialTransport(port, wait=3)
            transport.enter_raw_repl(soft_reset=True)
            return transport
        except (OSError, TransportError):
            if transport is not None:
                try:
                    transport.close()
                except OSError as error:
                    if error.errno not in (5, 6, 19):
                        raise
            if attempt == attempts - 1:
                raise
            print("The badge reset its USB port. Reconnecting...", flush=True)
            time.sleep(1)
