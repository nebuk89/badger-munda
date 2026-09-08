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

    def test_saved_wifi_file_takes_priority_over_cached_factory_settings(self):
        module = self.load_app()
        from io import StringIO
        factory = types.SimpleNamespace(WIFI_SSID="factory-network", WIFI_PASSWORD="factory-password")
        saved = StringIO('WIFI_SSID = "saved-network"\nWIFI_PASSWORD = "saved-password"\n')
        with patch.dict(sys.modules, {"secrets": factory}), patch("builtins.open", return_value=saved):
            self.assertEqual(module._wifi_credentials(), ("saved-network", "saved-password"))

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
