"""Small, bounded HTTP server for local Wi-Fi setup."""

import errno
try:
    import ujson as json
except ImportError:
    import json

try:
    from .defaults import SETUP_CLIENT_IDLE_MS, SETUP_MAX_REQUEST
except ImportError:
    from defaults import SETUP_CLIENT_IDLE_MS, SETUP_MAX_REQUEST


class RequestError(ValueError):
    pass


def _would_block(error):
    return bool(error.args) and error.args[0] in (
        errno.EAGAIN,
        getattr(errno, "EWOULDBLOCK", errno.EAGAIN),
        getattr(errno, "EINPROGRESS", 115),
    )


def _request_length(data, maximum=SETUP_MAX_REQUEST):
    if len(data) > maximum:
        raise RequestError("request too large")
    marker = data.find(b"\r\n\r\n")
    if marker < 0:
        return None
    if marker + 4 > maximum:
        raise RequestError("request headers too large")
    try:
        lines = bytes(data[:marker]).decode("ascii").split("\r\n")
    except UnicodeError:
        raise RequestError("request headers are not ASCII") from None
    if not lines or len(lines[0].split(" ")) != 3:
        raise RequestError("invalid request line")
    lengths = []
    for line in lines[1:]:
        if ":" not in line:
            raise RequestError("invalid request header")
        name, value = line.split(":", 1)
        name = name.strip().lower()
        value = value.strip()
        if name == "transfer-encoding":
            raise RequestError("transfer encoding unsupported")
        if name == "content-length":
            if not value or any(char < "0" or char > "9" for char in value):
                raise RequestError("invalid content length")
            lengths.append(int(value))
    if len(lengths) > 1:
        raise RequestError("duplicate content length")
    length = lengths[0] if lengths else 0
    total = marker + 4 + length
    if total > maximum:
        raise RequestError("request body too large")
    return total


def parse_request(data):
    total = _request_length(data)
    if total is None or len(data) != total:
        raise RequestError("incomplete request")
    marker = data.find(b"\r\n\r\n")
    lines = bytes(data[:marker]).decode("ascii").split("\r\n")
    method, target, version = lines[0].split(" ")
    if method not in ("GET", "POST", "DELETE") or version not in ("HTTP/1.0", "HTTP/1.1"):
        raise RequestError("unsupported request")
    if not target.startswith("/") or "://" in target or "#" in target:
        raise RequestError("invalid request target")
    headers = {}
    for line in lines[1:]:
        name, value = line.split(":", 1)
        name = name.strip().lower()
        if name in headers:
            raise RequestError("duplicate request header")
        headers[name] = value.strip()
    body = bytes(data[marker + 4:])
    if method in ("POST", "DELETE") and "content-length" not in headers:
        raise RequestError("content length required")
    return method, target.split("?", 1)[0], headers, body


def _decode_form_component(value):
    output = bytearray()
    index = 0
    while index < len(value):
        char = value[index]
        if char == 43:
            output.append(32)
            index += 1
        elif char == 37:
            if index + 2 >= len(value):
                raise RequestError("invalid form escape")
            try:
                output.append(int(bytes(value[index + 1:index + 3]), 16))
            except ValueError:
                raise RequestError("invalid form escape") from None
            index += 3
        else:
            output.append(char)
            index += 1
    try:
        return output.decode("utf-8")
    except UnicodeError:
        raise RequestError("invalid form text") from None


def parse_form(body):
    result = {}
    if not body:
        return result
    for item in body.split(b"&"):
        parts = item.split(b"=", 1)
        if len(parts) != 2:
            raise RequestError("invalid form field")
        name = _decode_form_component(parts[0])
        if not name or name in result:
            raise RequestError("duplicate form field")
        result[name] = _decode_form_component(parts[1])
    return result


def _escape(value):
    return (str(value).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _response(status, body=b"", content_type="text/plain; charset=utf-8",
              headers=None):
    if isinstance(body, str):
        body = body.encode()
    reason = {
        200: "OK", 204: "No Content", 302: "Found", 400: "Bad Request",
        404: "Not Found", 409: "Conflict", 413: "Content Too Large",
        415: "Unsupported Media Type",
    }.get(status, "Error")
    values = [
        "HTTP/1.1 %d %s" % (status, reason),
        "Content-Length: %d" % len(body),
        "Content-Type: " + content_type,
        "Cache-Control: no-store",
        "Connection: close",
        "X-Content-Type-Options: nosniff",
    ]
    for name, value in (headers or {}).items():
        values.append(name + ": " + value)
    return ("\r\n".join(values) + "\r\n\r\n").encode() + body


class SetupHttpServer:
    def __init__(self, socket_module, nonce, networks=None, port=80):
        self.socket_module = socket_module
        self.nonce = nonce
        self.networks = list(networks or ())
        self.port = port
        self.listener = None
        self.client = None
        self.input = bytearray()
        self.output = None
        self.sent = 0
        self.client_started = None
        self.last_activity = None
        self.action = None
        self.action_ready = False
        self.status = ""
        self.buffer = bytearray(512)
        self.view = memoryview(self.buffer)

    def start(self, now):
        self.listener = self.socket_module.socket(
            self.socket_module.AF_INET, self.socket_module.SOCK_STREAM
        )
        self.listener.setblocking(False)
        self.listener.setsockopt(
            self.socket_module.SOL_SOCKET, self.socket_module.SO_REUSEADDR, 1
        )
        self.listener.bind(("0.0.0.0", self.port))
        self.listener.listen(1)
        self.last_activity = now

    def set_networks(self, networks):
        self.networks = list(networks)

    def set_status(self, status):
        self.status = status

    def pop_action(self):
        if not self.action_ready:
            return None
        action = self.action
        self.action = None
        self.action_ready = False
        return action

    def _page(self):
        options = ['<option value="">Other network...</option>']
        removals = []
        for item in self.networks:
            label = _escape(item["ssid"])
            if item["rssi"] is not None:
                label += " (%d dBm)" % item["rssi"]
            options.append(
                '<option value="%s">%s - %s</option>' % (
                    _escape(item["ssidHex"]), label, _escape(item["security"])
                )
            )
            if item["savedId"]:
                removals.append(
                    '<form method="post" action="/setup/v1/remove">'
                    '<input type="hidden" name="nonce" value="%s">'
                    '<input type="hidden" name="network_id" value="%s">'
                    '<button type="submit">Forget %s</button></form>' % (
                        _escape(self.nonce), _escape(item["savedId"]),
                        _escape(item["ssid"])
                    )
                )
        status = "<p>%s</p>" % _escape(self.status) if self.status else ""
        return (
            '<!doctype html><meta name="viewport" content="width=device-width">'
            '<title>Underhive Wi-Fi</title>'
            '<style>body{font:16px sans-serif;max-width:32rem;margin:2rem auto;'
            'padding:0 1rem;background:#0d1117;color:#f0f6fc}'
            'input,select,button{font:inherit;width:100%;padding:.7rem;margin:.3rem 0;'
            'box-sizing:border-box}button{background:#d3fa37;border:0;color:#0d1117}'
            '</style><h1>Underhive Wi-Fi</h1>' + status +
            '<form method="post" action="/setup/v1/apply">'
            '<input type="hidden" name="nonce" value="%s">'
            '<label>Visible network<select name="ssid_hex">%s</select></label>'
            '<label>Other or hidden network<input name="ssid" maxlength="32"></label>'
            '<label>Password<input type="password" name="password" maxlength="64"></label>'
            '<label><input style="width:auto" type="checkbox" name="hidden" value="1">'
            ' Hidden network</label><button type="submit">Save and connect</button>'
            '</form>%s<form method="post" action="/setup/v1/cancel">'
            '<input type="hidden" name="nonce" value="%s">'
            '<button type="submit">Cancel setup</button></form>' % (
                _escape(self.nonce), "".join(options), "".join(removals),
                _escape(self.nonce)
            )
        ).encode()

    def _json_networks(self):
        public = []
        for item in self.networks:
            public.append({
                "ssid": item["ssid"],
                "ssidHex": item["ssidHex"],
                "security": item["security"],
                "rssi": item["rssi"],
                "savedId": item["savedId"],
            })
        return json.dumps({"schema": 1, "networks": public})

    def handle(self, raw, defer_action=False):
        try:
            method, path, headers, body = parse_request(raw)
            if path in ("/generate_204", "/hotspot-detect.html", "/ncsi.txt",
                        "/connecttest.txt", "/redirect"):
                return _response(302, b"", headers={"Location": "/"})
            if method == "GET" and path == "/":
                return _response(200, self._page(), "text/html; charset=utf-8")
            if method == "GET" and path == "/setup/v1/networks":
                return _response(200, self._json_networks(), "application/json")
            if method == "GET" and path == "/setup/v1/status":
                return _response(
                    200, json.dumps({"schema": 1, "status": self.status}),
                    "application/json"
                )
            if method not in ("POST", "DELETE"):
                return _response(404, "Not found")
            content_type = headers.get("content-type", "")
            if content_type.split(";", 1)[0].strip() != "application/x-www-form-urlencoded":
                return _response(415, "Use form encoding")
            fields = parse_form(body)
            if fields.get("nonce") != self.nonce:
                return _response(400, "Setup session expired")
            if self.action is not None:
                return _response(409, "Another setup action is pending")
            if path == "/setup/v1/apply":
                allowed = {"nonce", "ssid_hex", "ssid", "password", "hidden"}
                if any(name not in allowed for name in fields):
                    raise RequestError("unknown form field")
                self.action = {
                    "type": "apply",
                    "ssidHex": fields.get("ssid_hex", ""),
                    "ssid": fields.get("ssid", ""),
                    "password": fields.get("password", ""),
                    "hidden": fields.get("hidden") == "1",
                }
                self.action_ready = not defer_action
                return _response(200, "The badge is testing this network.")
            network_id = ""
            if path.startswith("/setup/v1/networks/"):
                network_id = path[len("/setup/v1/networks/"):]
            if path in ("/setup/v1/remove", "/setup/v1/networks") or network_id:
                allowed = {"nonce", "network_id"}
                if any(name not in allowed for name in fields):
                    raise RequestError("unknown form field")
                self.action = {
                    "type": "remove",
                    "networkId": network_id or fields.get("network_id", ""),
                }
                self.action_ready = not defer_action
                return _response(200, "The saved network was removed.")
            if path == "/setup/v1/cancel":
                if set(fields) != {"nonce"}:
                    raise RequestError("unknown form field")
                self.action = {"type": "cancel"}
                self.action_ready = not defer_action
                return _response(200, "Setup cancelled.")
            return _response(404, "Not found")
        except RequestError as error:
            return _response(400, str(error))

    def _close_client(self, abandon=False):
        if abandon and not self.action_ready:
            self.action = None
        if self.client is not None:
            self.client.close()
        self.client = None
        self.input[:] = b""
        self.output = None
        self.sent = 0
        self.client_started = None

    def update(self, now, ticks_diff):
        if self.listener is None:
            return
        if self.client is None:
            try:
                self.client, _address = self.listener.accept()
                self.client.setblocking(False)
                self.client_started = now
                self.last_activity = now
            except OSError as error:
                if not _would_block(error):
                    raise
                return
        if ticks_diff(now, self.client_started) >= SETUP_CLIENT_IDLE_MS:
            self._close_client(abandon=True)
            return
        try:
            if self.output is None:
                count = self.client.readinto(self.view)
                if count is None:
                    return
                if count <= 0:
                    self._close_client(abandon=True)
                    return
                self.input.extend(self.view[:count])
                self.last_activity = now
                expected = _request_length(self.input)
                if expected is None or len(self.input) < expected:
                    return
                if len(self.input) > expected:
                    raise RequestError("trailing request bytes")
                self.output = self.handle(bytes(self.input), defer_action=True)
            count = self.client.send(memoryview(self.output)[self.sent:])
            if count is None:
                return
            if count <= 0:
                self._close_client(abandon=True)
                return
            self.sent += count
            self.last_activity = now
            if self.sent == len(self.output):
                if self.action is not None:
                    self.action_ready = True
                self._close_client()
        except RequestError as error:
            self.output = _response(413, str(error))
            self.sent = 0
        except OSError as error:
            if not _would_block(error):
                self._close_client(abandon=True)

    def close(self):
        self._close_client(abandon=True)
        if self.listener is not None:
            self.listener.close()
            self.listener = None
        self.action = None
        self.action_ready = False
