import importlib.util
import io
import pathlib
import struct
import sys
import types
import unittest
from unittest.mock import patch
import zlib
import binascii

APP = pathlib.Path(__file__).resolve().parents[1] / "apps/underhive"
sys.path.insert(0, str(APP))
from protocol import FrameParser, ProtocolError, parse_frame_header, validate_config
from renderer import (RamBlockDevice, RamPngSink, RawSink, Rgb332Encoder,
                      UnsupportedFirmware, validate_png)
from transport import Transport


def header(length=57, fmt=4, sequence=42, fps=8, flags=0, width=160):
    return struct.pack("<4sHHBBHII", b"UBF1", width, 120, fmt, flags, fps, sequence, length)


def response(payload=b"x" * 57, **kwargs):
    body = header(len(payload), **kwargs) + payload
    return b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


def png(width=160, depth=8, interlace=0):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(
            ">I", binascii.crc32(kind + data) & 0xffffffff
        )
    pixels = (b"\0" + b"\xff\0\0" * width) * 120
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, 120, depth, 2, 0, 0, interlace))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


class Sink:
    format_code = 4
    format_name = "png"

    def __init__(self):
        self.data = bytearray()
        self.commits = 0
        self.aborts = 0

    def begin(self, length):
        self.length = length
        self.data.clear()

    def write(self, data):
        self.data.extend(data)

    def commit(self):
        self.commits += 1

    def abort(self):
        self.aborts += 1


class ProtocolTests(unittest.TestCase):
    def test_fragmentation_every_boundary(self):
        data = response()
        for size in (1, 2, 3, 19, 20, 21, 63, 4096):
            sink = Sink()
            parser = FrameParser(sink)
            for offset in range(0, len(data), size):
                parser.feed(memoryview(data)[offset:offset + size])
            parser.eof()
            self.assertEqual(sink.commits, 1)
            self.assertEqual(bytes(sink.data), b"x" * 57)
            self.assertEqual(parser.meta, (42, 8, 0, 57))

    def test_incomplete_never_commits(self):
        sink = Sink()
        parser = FrameParser(sink)
        parser.feed(response()[:-1])
        with self.assertRaises(ProtocolError):
            parser.eof()
        self.assertEqual(sink.commits, 0)

    def test_bad_headers(self):
        for fields in (
            {"width": 320}, {"fmt": 2}, {"fps": 0}, {"flags": 2},
            {"length": 32769}, {"length": 56}
        ):
            with self.subTest(fields=fields), self.assertRaises(ProtocolError):
                parse_frame_header(header(**fields), 4)
        with self.assertRaises(ProtocolError):
            parse_frame_header(header()[:-1], 4)
        with self.assertRaises(ProtocolError):
            parse_frame_header(b"NOPE" + header()[4:], 4)

    def test_rgba_exact_size(self):
        self.assertEqual(parse_frame_header(header(76800, fmt=1), 1)[3], 76800)
        with self.assertRaises(ProtocolError):
            parse_frame_header(header(76799, fmt=1), 1)

    def test_rgb332_exact_size(self):
        self.assertEqual(parse_frame_header(header(19200, fmt=3), 3)[3], 19200)
        with self.assertRaises(ProtocolError):
            parse_frame_header(header(19199, fmt=3), 3)

    def test_http_rejections(self):
        cases = (
            response().replace(b"200 OK", b"401 Unauthorized"),
            response().replace(b"Content-Length: 77", b"Content-Length: 78"),
            response().replace(b"Content-Length: 77", b"Content-Length: 77\r\nContent-Length: 77"),
            response().replace(b"Content-Length: 77", b"Transfer-Encoding: chunked"),
            response().replace(b"Content-Length: 77", b"Content-Length: 77\r\nContent-Encoding: gzip"),
            b"HTTP/1.1 200 OK\r\nX: " + b"x" * 2048,
            response() + b"extra",
        )
        for data in cases:
            sink = Sink()
            with self.subTest(data=data[:50]), self.assertRaises(ProtocolError):
                FrameParser(sink).feed(data)
            self.assertEqual(sink.commits, 0)

    def test_config_never_accepts_header_or_query_injection(self):
        self.assertEqual(validate_config("http://192.168.1.2:8787", "x" * 32, "desk-badge")[:2],
                         ("192.168.1.2", 8787))
        for url, token, device in (
            ("http://example.test", "x" * 32, "safe"),
            ("http://192.168.1.2/path", "x" * 32, "safe"),
            ("http://192.168.1.2:65536", "x" * 32, "safe"),
            ("https://192.168.1.2", "x" * 32, "safe"),
            ("http://192.168.1.2", "x" * 32 + "\r\n", "safe"),
            ("http://192.168.1.2", "", "safe"),
            ("http://192.168.1.2", "x" * 32, "x&token=y"),
        ):
            with self.assertRaises(ValueError):
                validate_config(url, token, device)


class RendererTests(unittest.TestCase):
    def test_rgb332_encoder_fragmentation_and_checksums(self):
        pixels = bytes(range(256)) * 75
        for fragment in (1, 159, 160, 161, 4096, 19200):
            output = io.BytesIO()
            encoder = Rgb332Encoder(output.write)
            row_id = id(encoder.row)
            encoder.begin()
            for offset in range(0, len(pixels), fragment):
                encoder.write(memoryview(pixels)[offset:offset + fragment])
            encoder.finish()
            data = output.getvalue()
            self.assertEqual(len(data), encoder.PNG_LENGTH)
            validate_png(io.BytesIO(data), len(data), memoryview(bytearray(1024)))
            offset, compressed, palette = 8, b"", b""
            while offset < len(data):
                size, kind = struct.unpack(">I4s", data[offset:offset + 8])
                body = data[offset + 8:offset + 8 + size]
                if kind == b"IDAT":
                    compressed += body
                if kind == b"PLTE":
                    palette = body
                offset += size + 12
            scanlines = zlib.decompress(compressed)
            self.assertEqual(len(scanlines), 161 * 120)
            decoded = b"".join(scanlines[y * 161 + 1:(y + 1) * 161] for y in range(120))
            self.assertEqual(decoded, pixels)
            self.assertEqual(palette[224 * 3:224 * 3 + 3], b"\xff\0\0")
            self.assertEqual(palette[28 * 3:28 * 3 + 3], b"\0\xff\0")
            self.assertEqual(palette[3 * 3:3 * 3 + 3], b"\0\0\xff")
            self.assertEqual(row_id, id(encoder.row))

    def test_rgb332_encoder_rejects_truncated_and_oversized_frames(self):
        encoder = Rgb332Encoder(lambda data: None)
        encoder.begin()
        encoder.write(memoryview(b"x" * 100))
        with self.assertRaises(ValueError):
            encoder.finish()
        with self.assertRaises(ValueError):
            encoder.write(memoryview(b"x" * 19200))

    def test_rgb332_encoder_restart_reuses_buffers(self):
        output = io.BytesIO()
        encoder = Rgb332Encoder(output.write)
        row_id, prefix_id = id(encoder.row), id(encoder.prefix)
        row = memoryview(bytes(range(160)))
        for _ in range(3):
            output.seek(0)
            encoder.begin()
            for _ in range(120):
                encoder.write(row)
            encoder.finish()
            data = output.getvalue()
            validate_png(io.BytesIO(data), len(data), memoryview(bytearray(1024)))
            self.assertEqual(id(encoder.row), row_id)
            self.assertEqual(id(encoder.prefix), prefix_id)

    def test_ram_device_read_write_erase(self):
        device = RamBlockDevice()
        device.ioctl(6, 1)
        device.writeblocks(1, b"abc", 17)
        output = bytearray(5)
        device.readblocks(1, output, 16)
        self.assertEqual(output, b"\xffabc\xff")
        self.assertEqual(device.ioctl(4, 0), 16)
        self.assertEqual(device.ioctl(5, 0), 4096)
        self.assertEqual(sum(map(len, device.blocks)), 65536)
        self.assertTrue(all(len(block) == 4096 for block in device.blocks))

    def test_ram_device_handles_transfers_across_block_boundaries(self):
        device = RamBlockDevice()
        source = bytes(range(256)) * 24
        device.writeblocks(1, source, 2000)
        result = bytearray(len(source))
        device.readblocks(1, result, 2000)
        self.assertEqual(result, source)

    def test_valid_png(self):
        data = png()
        validate_png(io.BytesIO(data), len(data), memoryview(bytearray(1024)))

    def test_bad_pngs_rejected_before_native_decode(self):
        bad_crc = bytearray(png())
        bad_crc[-1] ^= 1
        cases = [png(width=320), png(depth=4), png(interlace=1),
                 bytes(bad_crc), png()[:-12], png() + b"junk", b"no"]
        for data in cases:
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                validate_png(io.BytesIO(data), len(data), memoryview(bytearray(1024)))

    def test_raw_buffer_reused_and_partial_not_presented(self):
        class Screen(bytearray):
            width = 160
            height = 120
        screen = Screen(76800)
        sink = RawSink(screen)
        buffer_id = id(sink.buffer)
        for _ in range(2):
            sink.begin(76800)
            sink.write(memoryview(b"\xff" * 38400))
            with self.assertRaises(ValueError):
                sink.commit()
            sink.write(memoryview(b"\xff" * 38400))
            sink.commit()
        self.assertEqual(id(sink.buffer), buffer_id)
        self.assertEqual(screen, b"\xff" * 76800)

    def test_stock_image_buffer_absence_is_explicit(self):
        with self.assertRaises(UnsupportedFirmware):
            RawSink(types.SimpleNamespace(width=160, height=120))

    def test_ram_mount_is_required_and_flash_open_unused(self):
        screen = types.SimpleNamespace(width=160, height=120, load_into=lambda path: None)
        vfs = types.SimpleNamespace()
        with patch("builtins.open", side_effect=AssertionError("flash open forbidden")):
            with self.assertRaises(UnsupportedFirmware):
                RamPngSink(screen, vfs)

    def test_memory_budget_failure_before_allocating(self):
        screen = types.SimpleNamespace(width=160, height=120, load_into=lambda path: None)
        vfs = types.SimpleNamespace(VfsLfs2=None, mount=None, umount=None)
        with self.assertRaises(MemoryError):
            RamPngSink(screen, vfs, 100000)

    def test_ram_staging_reuses_device_and_never_opens_flash(self):
        displays = []
        mounts = []

        class RamFile(io.BytesIO):
            def close(self):
                self.saved = self.getvalue()

        class FakeFs:
            def __init__(self, device):
                self.device = device
                self.frame = None

            @staticmethod
            def mkfs(device):
                self.assertIsInstance(device, RamBlockDevice)

            def open(self, path, mode):
                self.assertEqual(path, "/frame.png")
                if mode == "wb":
                    self.frame = RamFile()
                    return self.frame
                return io.BytesIO(self.frame.saved)

            def remove(self, path):
                self.assertEqual(path, "/frame.png")
                if self.frame is None:
                    raise OSError(2)
                self.frame = None

        # Bind assertions without weakening the fake's path checks.
        FakeFs.assertEqual = lambda fs, actual, expected: self.assertEqual(actual, expected)
        vfs = types.SimpleNamespace(
            VfsLfs2=FakeFs, mount=lambda fs, path: mounts.append((fs, path)),
            umount=lambda path: mounts.append(path)
        )
        screen = types.SimpleNamespace(width=160, height=120, load_into=displays.append)
        data = png()
        with patch("builtins.open", side_effect=AssertionError("flash open forbidden")):
            sink = RamPngSink(screen, vfs, 250000)
            device_id = id(sink.device)
            for _ in range(25):
                sink.begin(len(data))
                sink.write(memoryview(data))
                sink.commit()
                self.assertEqual(id(sink.device), device_id)
            sink.close()
        self.assertEqual(displays, ["/underhive-ram/frame.png"] * 25)
        self.assertEqual(mounts[-1], "/underhive-ram")
        self.assertIsNone(sink.device)

    def test_ram_mount_failure_never_resolves_to_flash(self):
        class FailingFs:
            def __init__(self, device):
                pass

            @staticmethod
            def mkfs(device):
                pass

        def refuse(fs, path):
            raise OSError("mount collision")

        screen = types.SimpleNamespace(width=160, height=120, load_into=lambda path: None)
        vfs = types.SimpleNamespace(VfsLfs2=FailingFs, mount=refuse, umount=lambda path: None)
        with patch("builtins.open", side_effect=AssertionError("flash open forbidden")):
            with self.assertRaises(OSError):
                RamPngSink(screen, vfs)


class FakeSocket:
    def __init__(self, data):
        self.data = bytearray(data)
        self.sent = bytearray()
        self.closed = False

    def setblocking(self, value):
        assert value is False

    def connect(self, address):
        self.address = address

    def send(self, data):
        count = min(23, len(data))
        self.sent.extend(data[:count])
        return count

    def readinto(self, buffer):
        count = min(len(buffer), len(self.data), 17)
        buffer[:count] = self.data[:count]
        del self.data[:count]
        return count

    def close(self):
        self.closed = True


class FakePoll:
    def register(self, sock, flags):
        self.sock = sock
        self.flags = flags

    def modify(self, sock, flags):
        self.flags = flags

    def poll(self, delay):
        return [(self.sock, self.flags)]


class TransportTests(unittest.TestCase):
    def make_transport(self, data=None):
        self.sockets = []

        def create(*args):
            sock = FakeSocket(response() if data is None else data)
            self.sockets.append(sock)
            return sock

        module = types.SimpleNamespace(socket=create, AF_INET=2, SOCK_STREAM=1)
        poll = types.SimpleNamespace(poll=FakePoll, POLLIN=1, POLLOUT=4, POLLERR=8, POLLHUP=16)
        return Transport(Sink(), "http://192.168.1.2:8787", "x" * 32,
                         "desk-badge", module, poll, lambda a, b: a - b, lambda a, b: a + b)

    def test_ack_only_after_following_presentation(self):
        transport = self.make_transport()
        for now in range(100):
            transport.update(now)
            if transport.pending is not None:
                break
        self.assertEqual(transport.sink.commits, 1)
        self.assertIsNone(transport.last_applied)
        self.assertNotIn(b"X-Badge-Frame:", self.sockets[0].sent)
        transport.confirm_presented(now + 1)
        self.assertEqual(transport.last_applied, 42)
        self.assertIn(b"X-Badge-Frame: 42", transport._request())
        self.assertTrue(self.sockets[0].closed)

    def test_partial_disconnect_retry_and_no_ack(self):
        transport = self.make_transport(response()[:-1])
        for now in range(100):
            transport.update(now)
            if transport.failures:
                break
        self.assertEqual(transport.failures, 1)
        self.assertEqual(transport.sink.commits, 0)
        self.assertIsNone(transport.last_applied)
        self.assertEqual(transport.status, "Broadcaster offline")
        self.assertGreaterEqual(transport.due, 1000)

    def test_failure_status_interface_uses_safe_code_and_retry_countdown(self):
        transport = self.make_transport(response()[:-1])
        for now in range(100):
            transport.update(now)
            if transport.failures:
                break
        self.assertEqual(transport.error_type, "ProtocolError")
        self.assertEqual(transport.error_code, "protocol_invalid")
        self.assertEqual(transport.retry_seconds(now), 1)
        self.assertEqual(transport.retry_seconds(transport.due - 1), 1)
        self.assertEqual(transport.retry_seconds(transport.due), 0)

    def test_total_timeout(self):
        transport = self.make_transport()
        transport.update(0)
        transport.update(3001)
        self.assertEqual(transport.status, "Broadcaster offline")
        self.assertTrue(self.sockets[0].closed)

    def test_wifi_loss_cancels_socket(self):
        transport = self.make_transport()
        transport.update(0)
        transport.update(1, connected=False)
        self.assertTrue(self.sockets[0].closed)
        self.assertEqual(transport.status, "Waiting for Wi-Fi")
        self.assertIsNone(transport.last_applied)

    def test_close_prevents_future_connections(self):
        transport = self.make_transport()
        transport.update(0)
        transport.close()
        transport.update(10000)
        self.assertEqual(len(self.sockets), 1)
        self.assertIsNone(transport.token)

    def test_absolute_schedule_not_completion_delay(self):
        transport = self.make_transport()
        for now in range(100):
            transport.update(now)
            if transport.pending is not None:
                break
        self.assertEqual(transport.due, 125)

    def test_tick_wrap_supported(self):
        transport = self.make_transport()
        transport.add = lambda a, b: (a + b) % 65536
        transport.diff = lambda a, b: ((a - b + 32768) % 65536) - 32768
        transport.update(65530)
        transport.update(10)
        self.assertEqual(transport.failures, 0)


class AppImportTests(unittest.TestCase):
    def load_app(self):
        fake = types.ModuleType("badgeware")
        fake.screen = types.SimpleNamespace(clear=lambda: None, text=lambda *args: None)
        fake.brushes = object()
        spec = importlib.util.spec_from_file_location("underhive_test_app", APP / "__init__.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"badgeware": fake}):
            spec.loader.exec_module(module)
        return module

    def test_upside_down_display_reverses_both_axes_without_changing_scan_order(self):
        module = self.load_app()
        commands = []
        fake = types.SimpleNamespace(display=types.SimpleNamespace(command=lambda *args: commands.append(args)))
        with patch.object(module, "config", types.SimpleNamespace(DISPLAY_ROTATION=180)), patch.dict(sys.modules, {"badgeware": fake}):
            module._configure_display_rotation()
        self.assertEqual(commands, [(0x36, (0x50,))])
        self.assertEqual(0x90 ^ commands[0][1][0], 0xC0)

    def test_upright_and_legacy_config_use_the_stock_orientation(self):
        for settings in (types.SimpleNamespace(DISPLAY_ROTATION=0), types.SimpleNamespace()):
            module = self.load_app()
            commands = []
            fake = types.SimpleNamespace(display=types.SimpleNamespace(command=lambda *args: commands.append(args)))
            with patch.object(module, "config", settings), patch.dict(sys.modules, {"badgeware": fake}):
                module._configure_display_rotation()
            self.assertEqual(commands, [(0x36, (0x90,))])

    def test_invalid_rotation_cannot_write_a_display_register(self):
        for rotation in (90, 270, "180", False):
            module = self.load_app()
            with patch.object(module, "config", types.SimpleNamespace(DISPLAY_ROTATION=rotation)):
                with self.assertRaisesRegex(ValueError, "DISPLAY_ROTATION must be 0 or 180"):
                    module._configure_display_rotation()

    def test_rotation_requires_the_supported_display_command(self):
        module = self.load_app()
        fake = types.SimpleNamespace(display=object())
        with patch.object(module, "config", types.SimpleNamespace(DISPLAY_ROTATION=180)), patch.dict(sys.modules, {"badgeware": fake}):
            with self.assertRaisesRegex(module.UnsupportedFirmware, "display.command absent"):
                module._configure_display_rotation()

    def test_init_rotates_the_display_before_showing_a_configuration_error(self):
        module = self.load_app()
        events = []
        module.config = types.SimpleNamespace(
            DISPLAY_ROTATION=180, SERVER_URL="", DEVICE_TOKEN="", DEVICE_ID="desk-badge")
        module.time = types.SimpleNamespace(ticks_ms=lambda: 0)
        module.brushes = types.SimpleNamespace(color=lambda *args: args)
        module._show_notice = lambda message: events.append(message)
        fake = types.SimpleNamespace(display=types.SimpleNamespace(command=lambda *args: events.append(args)))
        with patch.dict(sys.modules, {"badgeware": fake, "network": types.SimpleNamespace()}):
            module.init()
        self.assertEqual(events, [(0x36, (0x50,)), "Check app configuration"])

    def test_waiting_title_animates_without_a_status_change(self):
        module = self.load_app()
        labels = []
        module.screen.text = lambda text, *_: labels.append(text)
        now = [0]
        module.time = types.SimpleNamespace(
            ticks_ms=lambda: now[0], ticks_diff=lambda a, b: a - b)
        module._show_notice("Joining Wi-Fi")
        self.assertIn("UNDERHIVE", labels)
        labels.clear()
        module._show_notice("Joining Wi-Fi")
        self.assertEqual(labels, [])
        now[0] = 700
        module._show_notice("Joining Wi-Fi")
        self.assertIn("UNDERHIVE..", labels)
        now[0] = 1500
        module._show_notice("Joining Wi-Fi")
        self.assertIn("1s elapsed", labels)

    def test_claim_screen_shows_only_the_code_expiry_and_safe_instructions(self):
        module = self.load_app()
        labels = []
        module.screen = types.SimpleNamespace(
            clear=lambda: None, text=lambda text, *_: labels.append(text),
        )
        module._black = "black"
        module._white = "white"
        module._accent = "accent"
        module._last_notice = None
        module._claim = {
            "code": "123456",
            "expiresAtMs": 1_790_266_200_000,
        }
        module.time = types.SimpleNamespace(ticks_ms=lambda: 0)
        module._transport = types.SimpleNamespace(
            claim_seconds=lambda: 125,
            retry_seconds=lambda now: None,
            error_code=None,
        )
        self.assertTrue(module._show_claim())
        self.assertIn("Code: 123456", labels)
        self.assertIn("Expires in 2:05", labels)
        self.assertIn("HOME: return to menu", labels)
        self.assertNotIn("badge-secret", " ".join(labels))

    def test_claim_screen_keeps_the_code_and_shows_a_safe_retry_state(self):
        module = self.load_app()
        labels = []
        module.screen = types.SimpleNamespace(
            clear=lambda: None, text=lambda text, *_: labels.append(text),
        )
        module.time = types.SimpleNamespace(ticks_ms=lambda: 1000)
        module._black = "black"
        module._white = "white"
        module._accent = "accent"
        module._last_notice = None
        module._claim = {"code": "123456", "expiresAtMs": 1}
        module._transport = types.SimpleNamespace(
            claim_seconds=lambda: 45,
            retry_seconds=lambda now: 17,
            error_code="network_failed",
        )
        self.assertTrue(module._show_claim())
        self.assertIn("Code: 123456", labels)
        self.assertIn("network_failed; retry 17s", labels)

    def test_runtime_selects_hosted_or_local_transport_from_installed_state(self):
        module = self.load_app()
        events = []

        class Sink:
            def close(self):
                events.append("sink-close")

        class Hosted:
            def __init__(self, *args):
                events.append(("hosted", args[-1]))

            def close(self):
                events.append("hosted-close")

        class Local:
            def __init__(self, *args):
                events.append("local")

            def close(self):
                events.append("local-close")

        module.gc = types.SimpleNamespace(
            collect=lambda: None, mem_free=lambda: 100000
        )
        module.time = types.SimpleNamespace(
            ticks_diff=lambda a, b: a - b, ticks_add=lambda a, b: a + b
        )
        module.RamPngSink = lambda *args: Sink()
        module._clock = object()
        module._socket_module = object()
        module._ssl_module = object()
        module._boot = "boot-id"
        module._wlan = types.SimpleNamespace(active=lambda value: None)
        module.config = types.SimpleNamespace(
            FRAME_FORMAT="png", TARGET_FPS=8,
            SERVER_URL="http://192.168.1.2:8787",
            DEVICE_TOKEN="x" * 32, DEVICE_ID="desk-badge",
        )
        module.Transport = Local
        with patch.dict(sys.modules, {
            "vfs": types.SimpleNamespace(),
            "hosted_client": types.SimpleNamespace(HostedClient=Hosted),
        }):
            module._hosted = types.SimpleNamespace(
                enabled=True, state={"mode": "hosted"}
            )
            module._start_playback()
            self.assertEqual(events[0][0], "hosted")
            self.assertIs(events[0][1], module._hosted_claim_changed)
            module._stop_playback()
            module._hosted = types.SimpleNamespace(
                enabled=False, state={"mode": "local"}
            )
            module._start_playback()
            self.assertEqual(events[-1], "local")

    def test_local_broadcaster_failure_uses_shared_safe_status_interface(self):
        module = self.load_app()
        labels = []
        now = 100

        class FailingSocket:
            def setblocking(self, value):
                self.assertFalse(value)

            def connect(self, address):
                raise OSError("private-broadcaster-detail")

            def close(self):
                pass

        FailingSocket.assertFalse = lambda sock, value: self.assertFalse(value)
        socket_module = types.SimpleNamespace(
            socket=lambda *args: FailingSocket(), AF_INET=2, SOCK_STREAM=1,
        )
        select_module = types.SimpleNamespace(
            poll=lambda: FakePoll(), POLLIN=1, POLLOUT=4, POLLERR=8,
            POLLHUP=16,
        )
        module.screen = types.SimpleNamespace(
            clear=lambda: None, text=lambda text, *_: labels.append(text),
        )
        module.time = types.SimpleNamespace(
            ticks_ms=lambda: now, ticks_diff=lambda a, b: a - b,
            ticks_add=lambda a, b: a + b, sleep_ms=lambda delay: None,
        )
        module._black = "black"
        module._white = "white"
        module._accent = "accent"
        module._last_notice = None
        module._notice_started = now
        module._claim = None
        module._onboarding = types.SimpleNamespace(active=False)
        module._transport = Transport(
            Sink(), "http://192.168.1.2:8787", "x" * 32, "desk-badge",
            socket_module, select_module, lambda a, b: a - b,
            lambda a, b: a + b,
        )
        with patch.object(module, "_connected", return_value=True):
            module.update()
        self.assertEqual(module._transport.status, "Broadcaster offline")
        self.assertEqual(module._transport.error_code, "network_failed")
        self.assertIn("network_failed; retry 1s", labels)
        self.assertNotIn("private-broadcaster-detail", " ".join(labels))

    def test_mode_diagnostic_names_selection_and_state_source_without_secrets(self):
        module = self.load_app()
        messages = []
        with patch("builtins.print", side_effect=lambda *parts: messages.append(
                " ".join(str(part) for part in parts))):
            module._report_mode(True, "primary")
            module._report_mode(False, "default")
        self.assertEqual(messages, [
            "Underhive mode: hosted; hosted state: primary",
            "Underhive mode: local; hosted state: default",
        ])
        self.assertNotIn("badgeSecret", " ".join(messages))

    def test_notice_can_show_a_stable_error_and_retry_without_secrets(self):
        module = self.load_app()
        labels = []
        module.screen.text = lambda text, *_: labels.append(text)
        module.time = types.SimpleNamespace(
            ticks_ms=lambda: 0, ticks_diff=lambda a, b: a - b
        )
        module._show_notice("Hosted station busy", "server_backoff; retry 17s")
        self.assertIn("server_backoff; retry 17s", labels)
        self.assertNotIn("Authorization", " ".join(labels))

    def test_join_receives_thirty_seconds_and_names_failure(self):
        module = self.load_app()
        calls = []
        module.time = types.SimpleNamespace(ticks_diff=lambda a, b: a - b, ticks_add=lambda a, b: a + b)
        module._credentials = ("test-network", "test-password")
        module._wlan = types.SimpleNamespace(
            isconnected=lambda: False, status=lambda: 1,
            disconnect=lambda: calls.append("disconnect"),
            connect=lambda *_: calls.append("connect"))
        module._connected(0)
        module._connected(11000)
        self.assertEqual(calls, ["connect"])
        module._connected(30000)
        self.assertEqual(calls, ["connect", "disconnect"])
        self.assertEqual(module._wifi_state, "Wi-Fi join timed out")
        self.assertEqual(module._retry_at, 45000)

    def test_setup_gesture_requires_both_buttons_for_three_seconds(self):
        module = self.load_app()
        button_a, button_c = object(), object()
        badge_io = types.SimpleNamespace(
            BUTTON_A=button_a, BUTTON_C=button_c, held=[], pressed=[]
        )
        fake = types.SimpleNamespace(io=badge_io)
        module.time = types.SimpleNamespace(ticks_diff=lambda a, b: a - b)
        with patch.dict(sys.modules, {"badgeware": fake}):
            badge_io.held = [button_a]
            self.assertFalse(module._setup_requested(0))
            badge_io.held = [button_a, button_c]
            self.assertFalse(module._setup_requested(1))
            self.assertFalse(module._setup_requested(3000))
            self.assertTrue(module._setup_requested(3001))
            self.assertFalse(module._setup_requested(6000))
            badge_io.held = []
            self.assertFalse(module._setup_requested(6001))
            badge_io.held = [button_a, button_c]
            self.assertFalse(module._setup_requested(6002))
            self.assertTrue(module._setup_requested(9002))

    def test_saved_state_precedes_factory_credentials_and_falls_back(self):
        module = self.load_app()
        module._factory_credentials = ("factory-network", "factory-password")
        module._profiles = types.SimpleNamespace(
            selected_credentials=lambda: (b"saved-network", "saved-password")
        )
        self.assertEqual(
            module._preferred_credentials(),
            (b"saved-network", "saved-password"),
        )
        module._profiles = types.SimpleNamespace(selected_credentials=lambda: None)
        self.assertEqual(
            module._preferred_credentials(),
            ("factory-network", "factory-password"),
        )

    def test_home_closes_setup_without_writing_or_disconnecting_sta(self):
        module = self.load_app()
        events = []
        module._onboarding = types.SimpleNamespace(
            close=lambda: events.append("setup-close")
        )
        module._transport = types.SimpleNamespace(
            close=lambda: events.append("transport-close")
        )
        module._sink = types.SimpleNamespace(close=lambda: events.append("sink-close"))
        module._credentials = ("network", "password")
        module.on_exit()
        self.assertEqual(events, ["setup-close", "transport-close", "sink-close"])
        self.assertIsNone(module._credentials)

    def test_saved_wifi_file_takes_priority_over_cached_factory_settings(self):
        module = self.load_app()
        from io import StringIO
        factory = types.SimpleNamespace(WIFI_SSID="factory-network", WIFI_PASSWORD="factory-password")
        saved = StringIO('WIFI_SSID = "saved-network"\nWIFI_PASSWORD = "saved-password"\n')
        with patch.dict(sys.modules, {"secrets": factory}), patch("builtins.open", return_value=saved) as opened:
            self.assertEqual(module._wifi_credentials(), ("saved-network", "saved-password"))
            opened.assert_called_once_with("/system/secrets.py", "r")

    def test_wifi_uses_persistent_settings_instead_of_an_old_boot_copy(self):
        module = self.load_app()

        def open_settings(filename, mode):
            if filename == "/system/secrets.py":
                return io.StringIO('WIFI_SSID = "persistent-network"\nWIFI_PASSWORD = "persistent-password"\n')
            return io.StringIO('WIFI_SSID = "old-network"\nWIFI_PASSWORD = "old-password"\n')

        with patch("builtins.open", side_effect=open_settings):
            self.assertEqual(module._wifi_credentials(), ("persistent-network", "persistent-password"))

    def test_wifi_uses_legacy_boot_copy_only_when_persistent_file_is_missing(self):
        module = self.load_app()

        def open_settings(filename, mode):
            if filename == "/system/secrets.py":
                raise OSError(2)
            return io.StringIO('WIFI_SSID = "legacy-network"\nWIFI_PASSWORD = "legacy-password"\n')

        with patch("builtins.open", side_effect=open_settings):
            self.assertEqual(module._wifi_credentials(), ("legacy-network", "legacy-password"))

    def test_invalid_persistent_wifi_settings_do_not_fall_back_to_old_credentials(self):
        module = self.load_app()
        with patch("builtins.open", return_value=io.StringIO("WIFI_SSID = 42\nWIFI_PASSWORD = 'test'\n")):
            with self.assertRaises(ValueError):
                module._wifi_credentials()

    def test_unreadable_persistent_wifi_settings_raise_the_storage_error(self):
        module = self.load_app()
        with patch("builtins.open", side_effect=OSError(5)) as opened:
            with self.assertRaises(OSError):
                module._wifi_credentials()
            opened.assert_called_once_with("/system/secrets.py", "r")

    def test_launcher_import_has_no_wifi_or_disk_effects(self):
        fake = types.ModuleType("badgeware")
        fake.screen = object()
        fake.brushes = object()
        spec = importlib.util.spec_from_file_location("underhive_test_app", APP / "__init__.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"badgeware": fake}), patch(
                "builtins.open", side_effect=AssertionError("unexpected file access")):
            spec.loader.exec_module(module)
        self.assertTrue(callable(module.init))
        self.assertTrue(callable(module.update))
        self.assertTrue(callable(module.on_exit))
        self.assertIsNone(module._transport)


if __name__ == "__main__":
    unittest.main()
