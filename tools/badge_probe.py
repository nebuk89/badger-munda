#!/usr/bin/env python3
"""Opt-in RAM-only capability/display probe. Never imports badge secrets."""

import argparse
import os
from pathlib import Path
import select
import re
import sys
import termios
import time
import struct
import zlib
import binascii


def probe_source(prove_display=False, iterations=10, frame_format="rgb332"):
    prefix = """
import gc
import badgeware
from badgeware import screen
def report(key, value):
    print("BADGE_PROBE " + key + "=" + str(value))
report("screen_type", type(screen).__name__)
report("width", screen.width)
report("height", screen.height)
report("load_into", callable(getattr(screen, "load_into", None)))
try:
    probe_view = memoryview(screen)
    report("buffer_bytes", len(probe_view))
    del probe_view
except (TypeError, ValueError) as error:
    report("buffer_protocol", type(error).__name__)
try:
    import vfs
    report("vfs_lfs2", hasattr(vfs, "VfsLfs2"))
    report("vfs_mount", callable(getattr(vfs, "mount", None)))
except ImportError:
    report("vfs_lfs2", False)
gc.collect()
report("free_memory", gc.mem_free())
"""
    if not prove_display:
        return prefix + '\nreport("complete", True)\n'
    renderer = Path(__file__).resolve().parents[1] / "badge/apps/underhive/renderer.py"
    source = renderer.read_text()
    suffix = """
import time
sink = None
try:
    gc.collect()
    before = gc.mem_free()
    sink = Rgb332Sink(screen, vfs, before)
    report("ram_block_bytes", sink.device.byte_length)
    report("ram_mount", sink.mounted)
    report("wire_format", "rgb332")
    row = memoryview(%r)
    minimum = gc.mem_free()
    started = time.ticks_ms()
    for iteration in range(%d):
        sink.begin(160 * 120)
        for y in range(120):
            sink.write(row)
        sink.commit()
        badgeware.display.update()
        gc.collect()
        minimum = min(minimum, gc.mem_free())
    elapsed = time.ticks_diff(time.ticks_ms(), started)
    report("displayed_frames", %d)
    report("elapsed_ms", elapsed)
    report("free_memory_min", minimum)
    report("display_pattern", "red-green-blue-white-black")
except (AttributeError, TypeError, ValueError, OSError, RuntimeError, MemoryError, NameError) as error:
    report("proof_error_type", type(error).__name__)
finally:
    if sink is not None:
        sink.close()
    sink = None
    gc.collect()
    report("free_memory_after", gc.mem_free())
report("complete", True)
""" % (b"\xe0" * 32 + b"\x1c" * 32 + b"\x03" * 32 + b"\xff" * 32 + b"\0" * 32,
       iterations, iterations)
    if frame_format == "png":
        row = b"\xe0" * 32 + b"\x1c" * 32 + b"\x03" * 32 + b"\xff" * 32 + b"\0" * 32
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)
        palette = bytes(component for value in range(256) for component in (
            (value >> 5) * 255 // 7, ((value >> 2) & 7) * 255 // 7, (value & 3) * 85))
        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 160, 120, 8, 3, 0, 0, 0))
               + chunk(b"PLTE", palette) + chunk(b"IDAT", zlib.compress((b"\0" + row) * 120)) + chunk(b"IEND", b""))
        suffix = suffix.replace("Rgb332Sink(screen, vfs, before)", "RamPngSink(screen, vfs, before)")
        suffix = suffix.replace('report("wire_format", "rgb332")', 'report("wire_format", "png")')
        suffix = suffix.replace("row = memoryview(" + repr(row) + ")", "row = memoryview(" + repr(png) + ")")
        suffix = suffix.replace("sink.begin(160 * 120)\n        for y in range(120):\n            sink.write(row)",
                                "sink.begin(len(row))\n        sink.write(row)")
    return prefix + "\n" + source + "\n" + suffix


def _write(fd, data, timeout=5):
    end = time.monotonic() + timeout
    view = memoryview(data)
    used = 0
    while used < len(data):
        if time.monotonic() >= end:
            raise TimeoutError("serial write deadline")
        if select.select([], [fd], [], 0.1)[1]:
            used += os.write(fd, view[used:used + 256])
            if used < len(data):
                # Raw REPL has no raw-paste flow control. Give its small USB
                # receive ring time to drain before sending another chunk.
                time.sleep(0.01)


def _until(fd, marker, timeout, maximum=65536):
    response = bytearray()
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if select.select([fd], [], [], 0.1)[0]:
            data = os.read(fd, 1024)
            if not data:
                raise OSError("serial closed")
            response.extend(data)
            if len(response) > maximum:
                raise RuntimeError("serial response exceeded limit")
            if marker in response:
                return bytes(response)
    raise TimeoutError("serial response deadline")


def serial_probe(port, source, soft_reset=False, resume=False):
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    saved = termios.tcgetattr(fd)
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0
    attrs[1] = 0
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    attrs[3] = 0
    attrs[4] = termios.B115200
    attrs[5] = termios.B115200
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    try:
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        termios.tcflush(fd, termios.TCIFLUSH)
        _write(fd, b"\x03\x03\x01")
        _until(fd, b"raw REPL; CTRL-B to exit\r\n>", 5)
        if soft_reset:
            _write(fd, b"\x04")
            _until(fd, b"raw REPL; CTRL-B to exit\r\n>", 10)
        _write(fd, source.encode(), 15)
        _write(fd, b"\x04")
        result = _until(fd, b"\x04>", 45)
        # Never echo boot/app/exception text or arbitrary device output.
        for line in result.decode("utf-8", "replace").splitlines():
            if line.startswith("OKBADGE_PROBE "):
                line = line[2:]
            if line.startswith("BADGE_PROBE "):
                print(line)
        if b"BADGE_PROBE complete=True" not in result:
            for line in result.decode("utf-8", "replace").splitlines():
                match = re.match(r"([A-Za-z_]\w*(?:Error|Exception)):", line)
                if match:
                    print("BADGE_PROBE execution_error=" + match.group(1))
                match = re.search(r'File "<stdin>", line (\d+)', line)
                if match:
                    print("BADGE_PROBE source_line=" + match.group(1))
            raise RuntimeError("probe did not complete; device output withheld")
        if b"BADGE_PROBE proof_error_type=" in result:
            raise RuntimeError("RAM display proof failed")
        if resume:
            _write(fd, b"from badgeware import run\nrun(running_app.update)\n")
            _write(fd, b"\x04")
            _until(fd, b"OK", 5)
    finally:
        try:
            if not resume:
                _write(fd, b"\x02", 1)
        finally:
            termios.tcsetattr(fd, termios.TCSANOW, saved)
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emit", action="store_true", help="print source without connecting")
    parser.add_argument("--port", help="runtime serial port, e.g. /dev/cu.usbmodem12101")
    parser.add_argument("--allow-interrupt", action="store_true",
                        help="explicit parent/user approval to stop the running app")
    parser.add_argument("--prove-display", action="store_true",
                        help="show color bars from a RAM-only filesystem; requires approval")
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--format", choices=("rgb332", "png"), default="rgb332")
    parser.add_argument("--soft-reset", action="store_true",
                        help="clear the interrupted app's RAM before the probe; no firmware/file changes")
    args = parser.parse_args()
    if not 1 <= args.iterations <= 100:
        parser.error("iterations must be 1..100")
    source = probe_source(args.prove_display, args.iterations, args.format)
    if args.emit:
        print(source)
        return
    if not args.port or not args.allow_interrupt:
        parser.error("use --emit, or --port plus explicitly approved --allow-interrupt")
    if Path("/Volumes/BADGER").exists():
        parser.error("BADGER is mounted: parent must approve and leave USB Disk Mode first")
    try:
        serial_probe(args.port, source, args.soft_reset)
    except (OSError, TimeoutError, RuntimeError) as error:
        print("Probe failed: " + type(error).__name__ + ". No firmware/files installed.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
