import json
import pathlib
import tempfile
import time
import types
import unittest

APP = pathlib.Path(__file__).resolve().parents[1] / "apps/underhive"
import sys
sys.path.insert(0, str(APP))

from hosted_config import (
    HostedSettings, empty_hosted_state, validate_hosted_state,
)
from hosted_transport import (
    HostedTransportError, VerifiedHttps, badge_authorization, build_request,
    open_response, redact_secret,
)
from protocol import validate_config
from state_store import StateError, StateStore
from trusted_time import TrustedClock, TrustedTimeError

ORIGIN = "https://badger-munda.vercel.app"
BADGE_ID = "11111111-1111-4111-8111-111111111111"
BADGE_SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678"


def hosted_state():
    return {
        "schema": 1,
        "mode": "hosted",
        "serviceOrigin": ORIGIN,
        "badgeId": BADGE_ID,
        "badgeSecret": BADGE_SECRET,
    }


class HostedConfigTests(unittest.TestCase):
    def test_hosted_configuration_is_separate_and_canonical(self):
        self.assertEqual(validate_hosted_state(hosted_state()), hosted_state())
        self.assertNotIn("wifi", repr(hosted_state()).lower())
        self.assertEqual(validate_hosted_state(empty_hosted_state()), {
            "schema": 1, "mode": "local",
        })

    def test_origin_restrictions_fail_closed(self):
        for origin in (
            "http://badger-munda.vercel.app",
            "https://badger-munda.vercel.app/",
            "https://BADGER-MUNDA.vercel.app",
            "https://badger-munda.vercel.app:443",
            "https://badger-munda.vercel.app/path",
            "https://example.vercel.app",
            "https://127.0.0.1",
        ):
            state = dict(hosted_state(), serviceOrigin=origin)
            with self.subTest(origin=origin), self.assertRaises(StateError):
                validate_hosted_state(state)

    def test_secret_and_id_validation_do_not_echo_values(self):
        for field, value in (
            ("badgeId", "not-a-badge-id"),
            ("badgeSecret", "private bad secret"),
        ):
            state = dict(hosted_state(), **{field: value})
            with self.assertRaises(StateError) as raised:
                validate_hosted_state(state)
            self.assertNotIn(value, str(raised.exception))

    def test_missing_hosted_state_keeps_local_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = HostedSettings(StateStore(directory, seed_root=None))
            self.assertEqual(settings.load(), empty_hosted_state())
            self.assertFalse(settings.enabled)
        self.assertEqual(
            validate_config(
                "http://192.168.1.2:8787", "x" * 32, "desk-badge"
            )[:2],
            ("192.168.1.2", 8787),
        )

    def test_system_state_seed_selects_hosted_mode_and_copies_to_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime = root / "state" / "underhive"
            system = root / "system" / "state" / "underhive"
            system.mkdir(parents=True)
            (system / "hosted.v1.json").write_text(json.dumps(hosted_state()))
            store = StateStore(str(runtime), seed_root=str(system))
            settings = HostedSettings(store)
            self.assertEqual(settings.load(), hosted_state())
            self.assertTrue(settings.enabled)
            self.assertEqual(store.last_source, "system-seed")
            self.assertEqual(
                json.loads((runtime / "hosted.v1.json").read_text()),
                hosted_state(),
            )


class AuthenticationTests(unittest.TestCase):
    def test_badge_authorization_header_formation(self):
        expected = "Badge " + BADGE_ID + "." + BADGE_SECRET
        self.assertEqual(badge_authorization(hosted_state()), expected)
        request = build_request(
            hosted_state(), "POST", "/api/device/sync", b'{"protocol":2}'
        )
        self.assertIn(("Authorization: " + expected + "\r\n").encode(), request)
        self.assertIn(b"Content-Length: 14\r\n", request)

    def test_secret_redaction_covers_headers_and_errors(self):
        exposed = "Authorization: Badge " + BADGE_ID + "." + BADGE_SECRET
        redacted = redact_secret(exposed, BADGE_SECRET)
        self.assertNotIn(BADGE_SECRET, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_request_rejects_header_injection(self):
        for path in ("/api/device/sync\r\nX: yes", "/content/frame", " /api/x"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                build_request(hosted_state(), "POST", path)


class FakeTime:
    def __init__(self, current):
        self.current = current

    def time(self):
        return self.current

    @staticmethod
    def gmtime(seconds):
        return time.gmtime(seconds)


class WrongEpochTime(FakeTime):
    @staticmethod
    def gmtime(seconds):
        value = time.gmtime(seconds)
        return (value[0] + 30,) + value[1:]


class FakeRtc:
    def __init__(self, time_module, target):
        self.time_module = time_module
        self.target = target
        self.values = []

    def datetime(self, value):
        self.values.append(value)
        self.time_module.current = self.target


class TrustedTimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.runtime = root / "state" / "underhive"
        self.system = root / "system" / "state" / "underhive"
        self.store = StateStore(
            str(self.runtime), seed_root=str(self.system)
        )

    def tearDown(self):
        self.temp.cleanup()

    def clock(self, current, target=1_790_265_600):
        time_module = FakeTime(current)
        rtc = FakeRtc(time_module, target)
        clock = TrustedClock(self.store, time_module, rtc)
        clock.load()
        return clock, time_module, rtc

    def test_missing_time_fails_closed(self):
        clock, _time, rtc = self.clock(0)
        with self.assertRaises(TrustedTimeError):
            clock.bootstrap()
        self.assertEqual(rtc.values, [])

    def test_usb_seed_bootstraps_rtc_before_tls(self):
        trusted = 1_790_265_600
        self.system.mkdir(parents=True)
        (self.system / "trusted-time.v1.json").write_text(json.dumps({
            "schema": 1, "unixSeconds": trusted,
        }))
        clock, _time, rtc = self.clock(0, trusted)
        self.assertEqual(self.store.last_source, "system-seed")
        self.assertEqual(
            json.loads((self.runtime / "trusted-time.v1.json").read_text()),
            {"schema": 1, "unixSeconds": trusted},
        )
        self.assertEqual(clock.bootstrap(), trusted)
        self.assertEqual(
            rtc.values,
            [(2026, 9, 24, 3, 16, 0, 0, 0)],
        )

    def test_verified_time_only_moves_forward(self):
        clock, _time, _rtc = self.clock(1_790_265_600)
        clock.advance(1_790_265_600)
        with self.assertRaises(TrustedTimeError):
            clock.advance(1_790_265_599)
        self.assertEqual(clock.advance(1_790_265_700)["unixSeconds"], 1_790_265_700)

    def test_verified_time_observation_limits_flash_writes(self):
        clock, _time, _rtc = self.clock(1_790_265_600)
        clock.advance(1_790_265_600)
        source = self.runtime / "trusted-time.v1.json"
        first = source.read_text()
        for seconds in range(1_790_265_700, 1_790_266_700, 100):
            clock.observe(seconds)
        self.assertEqual(source.read_text(), first)
        self.assertEqual(clock.state["unixSeconds"], 1_790_266_600)
        clock.observe(1_790_352_100)
        self.assertNotEqual(source.read_text(), first)

    def test_unsupported_epoch_fails_closed(self):
        trusted = 1_790_265_600
        time_module = WrongEpochTime(0)
        rtc = FakeRtc(time_module, trusted)
        clock = TrustedClock(self.store, time_module, rtc)
        clock.load()
        clock.advance(trusted)
        with self.assertRaisesRegex(TrustedTimeError, "epoch unsupported"):
            clock.bootstrap()
        self.assertEqual(rtc.values, [])


class FakeRawSocket:
    def __init__(self, events):
        self.events = events
        self.closed = False

    def settimeout(self, timeout):
        self.events.append(("timeout", timeout))

    def connect(self, address):
        self.events.append(("connect", address))

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, protocol, events):
        self.protocol = protocol
        self.events = events
        self.verify_mode = None

    def load_verify_locations(self, cafile=None):
        self.events.append(("ca", cafile))

    def wrap_socket(self, raw, server_hostname=None):
        self.events.append(("tls", server_hostname, self.verify_mode))
        return types.SimpleNamespace(raw=raw)


class VerifiedHttpsTests(unittest.TestCase):
    def test_tls_requires_trusted_time_ca_and_hostname(self):
        events = []

        class Clock:
            def bootstrap(self):
                events.append("clock")

        raw = FakeRawSocket(events)
        sockets = types.SimpleNamespace(
            SOCK_STREAM=1,
            getaddrinfo=lambda *args: [(2, 1, 6, "", ("203.0.113.8", 443))],
            socket=lambda *args: raw,
        )
        ssl = types.SimpleNamespace(
            PROTOCOL_TLS_CLIENT=2,
            CERT_REQUIRED=3,
        )
        ssl.SSLContext = lambda protocol: FakeContext(protocol, events)
        transport = VerifiedHttps(
            ORIGIN, ("badger-munda.vercel.app",), Clock(), sockets, ssl,
            ca_file="/apps/underhive/gts-roots.pem",
        )
        secured = transport.connect()
        self.assertIs(secured.raw, raw)
        self.assertEqual(events[0], "clock")
        self.assertIn(("ca", "/apps/underhive/gts-roots.pem"), events)
        self.assertIn(("tls", "badger-munda.vercel.app", 3), events)

    def test_tls_has_no_unverified_fallback(self):
        raw = FakeRawSocket([])
        opened = []
        sockets = types.SimpleNamespace(
            SOCK_STREAM=1,
            getaddrinfo=lambda *args: [(2, 1, 6, "", ("203.0.113.8", 443))],
            socket=lambda *args: opened.append(args) or raw,
        )
        ssl = types.SimpleNamespace(PROTOCOL_TLS_CLIENT=2)
        ssl.SSLContext = lambda protocol: object()
        clock = types.SimpleNamespace(bootstrap=lambda: None)
        transport = VerifiedHttps(
            ORIGIN, ("badger-munda.vercel.app",), clock, sockets, ssl
        )
        with self.assertRaisesRegex(HostedTransportError, "TLS verification unavailable"):
            transport.connect()
        self.assertEqual(opened, [])


class HttpsResponseTests(unittest.TestCase):
    class Socket:
        def __init__(self, response):
            self.response = bytearray(response)
            self.sent = bytearray()
            self.closed = False

        def send(self, data):
            count = min(7, len(data))
            self.sent.extend(data[:count])
            return count

        def read(self, count):
            count = min(count, 11, len(self.response))
            result = bytes(self.response[:count])
            del self.response[:count]
            return result

        def close(self):
            self.closed = True

    def response(self, headers=b"Content-Length: 4\r\n", body=b"test"):
        return b"HTTP/1.1 200 OK\r\n" + headers + b"\r\n" + body

    def test_exact_length_body_streams_in_bounded_fragments(self):
        socket = self.Socket(self.response())
        connection = types.SimpleNamespace(connect=lambda: socket)
        body = open_response(connection, b"GET / HTTP/1.1\r\n\r\n", 8)
        received = bytearray()
        while len(received) < body.length:
            received.extend(body.read(2))
        self.assertEqual(received, b"test")
        body.finish()
        body.close()
        self.assertTrue(socket.closed)

    def test_chunked_duplicate_and_oversized_lengths_are_rejected(self):
        cases = (
            self.response(b"Transfer-Encoding: chunked\r\n", b"4\r\ntest\r\n0\r\n\r\n"),
            self.response(b"Content-Length: 4\r\nContent-Length: 4\r\n"),
            self.response(b"Content-Length: 9\r\n", b"123456789"),
        )
        for response in cases:
            socket = self.Socket(response)
            connection = types.SimpleNamespace(connect=lambda: socket)
            with self.subTest(response=response[:80]), self.assertRaises(HostedTransportError):
                open_response(connection, b"GET / HTTP/1.1\r\n\r\n", 8)
            self.assertTrue(socket.closed)

    def test_retry_after_is_bounded_and_error_bodies_are_not_exposed(self):
        socket = self.Socket(
            b"HTTP/1.1 429 Too Many Requests\r\n"
            b"Retry-After: 17\r\n"
            b"Content-Length: 18\r\n\r\n"
            b"database-password"
        )
        connection = types.SimpleNamespace(connect=lambda: socket)
        with self.assertRaises(HostedTransportError) as raised:
            open_response(connection, b"POST /api/device/sync HTTP/1.1\r\n\r\n", 8192)
        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.retry_after_ms, 17000)
        self.assertNotIn("database-password", str(raised.exception))
        self.assertTrue(socket.closed)


if __name__ == "__main__":
    unittest.main()
