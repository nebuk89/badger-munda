import pathlib
import sys
import unittest
from urllib.parse import urlencode

APP = pathlib.Path(__file__).resolve().parents[1] / "apps/underhive"
sys.path.insert(0, str(APP))

from setup_http import RequestError, SetupHttpServer, parse_form, parse_request


def request(method, path, body=None, headers=None):
    body = b"" if body is None else body
    values = {"Host": "192.168.4.1"}
    values.update(headers or {})
    if method in ("POST", "DELETE"):
        values.setdefault("Content-Type", "application/x-www-form-urlencoded")
        values["Content-Length"] = str(len(body))
    lines = ["%s %s HTTP/1.1" % (method, path)]
    lines.extend("%s: %s" % item for item in values.items())
    return ("\r\n".join(lines) + "\r\n\r\n").encode() + body


def form(**values):
    return urlencode(values).encode()


class SetupHttpTests(unittest.TestCase):
    def server(self):
        networks = [{
            "ssid": '<home & "office">',
            "ssidHex": "686f6d65",
            "security": "secured",
            "rssi": -42,
            "savedId": "net-1234",
        }]
        return SetupHttpServer(object(), "nonce-123", networks)

    def test_parse_fragment_contract_and_reject_smuggling(self):
        raw = request("POST", "/setup/v1/cancel", form(nonce="nonce-123"))
        method, path, headers, body = parse_request(raw)
        self.assertEqual((method, path), ("POST", "/setup/v1/cancel"))
        self.assertEqual(parse_form(body), {"nonce": "nonce-123"})
        cases = [
            raw + b"extra",
            raw.replace(b"Content-Length:", b"Content-Length: 1\r\nContent-Length:"),
            raw.replace(b"Content-Length:", b"Transfer-Encoding: chunked\r\nContent-Length:"),
            b"POST / HTTP/1.1\r\nHost: x\r\n\r\n",
            b"GET http://bad/ HTTP/1.1\r\nHost: x\r\n\r\n",
        ]
        for value in cases:
            with self.subTest(value=value[:80]), self.assertRaises(RequestError):
                parse_request(value)

    def test_request_limit_and_form_validation(self):
        with self.assertRaisesRegex(RequestError, "large"):
            parse_request(b"GET / HTTP/1.1\r\nX: " + b"x" * 9000)
        for body in (b"x", b"x=%GG", b"x=1&x=2", b"=empty"):
            with self.subTest(body=body), self.assertRaises(RequestError):
                parse_form(body)

    def test_page_escapes_names_and_never_returns_passwords(self):
        server = self.server()
        page = server.handle(request("GET", "/"))
        self.assertIn(b"&lt;home &amp; &quot;office&quot;&gt;", page)
        self.assertNotIn(b"private-password", page)
        data = server.handle(request("GET", "/setup/v1/networks"))
        self.assertIn(b"net-1234", data)
        self.assertNotIn(b"password", data.lower())

    def test_apply_requires_nonce_and_queues_one_action(self):
        server = self.server()
        rejected = server.handle(request(
            "POST", "/setup/v1/apply",
            form(nonce="wrong", ssid_hex="686f6d65", ssid="", password="password1")
        ))
        self.assertIn(b"400 Bad Request", rejected)
        accepted = server.handle(request(
            "POST", "/setup/v1/apply",
            form(nonce="nonce-123", ssid_hex="686f6d65", ssid="",
                 password="", hidden="1")
        ))
        self.assertIn(b"200 OK", accepted)
        self.assertEqual(server.pop_action(), {
            "type": "apply", "ssidHex": "686f6d65", "ssid": "",
            "password": "", "hidden": True,
        })

    def test_deferred_action_waits_for_response_completion(self):
        server = self.server()
        raw = request(
            "POST", "/setup/v1/cancel", form(nonce="nonce-123")
        )
        server.handle(raw, defer_action=True)
        self.assertIsNone(server.pop_action())
        server.action_ready = True
        self.assertEqual(server.pop_action(), {"type": "cancel"})

    def test_cancel_remove_content_type_and_pending_action(self):
        server = self.server()
        response = server.handle(request(
            "POST", "/setup/v1/cancel", form(nonce="nonce-123")
        ))
        self.assertIn(b"200 OK", response)
        busy = server.handle(request(
            "POST", "/setup/v1/remove",
            form(nonce="nonce-123", network_id="net-1234")
        ))
        self.assertIn(b"409 Conflict", busy)
        self.assertEqual(server.pop_action(), {"type": "cancel"})
        removed = server.handle(request(
            "DELETE", "/setup/v1/networks/net-1234",
            form(nonce="nonce-123")
        ))
        self.assertIn(b"200 OK", removed)
        self.assertEqual(server.pop_action(), {
            "type": "remove", "networkId": "net-1234"
        })
        wrong_type = server.handle(request(
            "POST", "/setup/v1/cancel", b"nonce=nonce-123",
            {"Content-Type": "application/json"}
        ))
        self.assertIn(b"415 Unsupported Media Type", wrong_type)

    def test_captive_probe_redirects_but_manual_root_always_works(self):
        server = self.server()
        for path in (
            "/generate_204", "/hotspot-detect.html", "/ncsi.txt",
            "/connecttest.txt",
        ):
            with self.subTest(path=path):
                response = server.handle(request("GET", path))
                self.assertIn(b"302 Found", response)
                self.assertIn(b"Location: /", response)
        self.assertIn(b"200 OK", server.handle(request("GET", "/")))

    def test_unknown_and_extra_fields_are_rejected(self):
        server = self.server()
        response = server.handle(request(
            "POST", "/setup/v1/apply",
            form(nonce="nonce-123", ssid="home", ssid_hex="",
                 password="password1", surprise="yes")
        ))
        self.assertIn(b"400 Bad Request", response)
        self.assertIsNone(server.pop_action())


if __name__ == "__main__":
    unittest.main()
