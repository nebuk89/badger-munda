"""Verified HTTPS primitives for hosted protocol and Blob requests."""

try:
    from .defaults import HOSTED_CA_FILE, HOSTED_TLS_TIMEOUT_SECONDS
    from .hosted_config import (
        validate_hosted_state, validate_https_origin, validate_service_origin,
    )
except ImportError:
    from defaults import HOSTED_CA_FILE, HOSTED_TLS_TIMEOUT_SECONDS
    from hosted_config import (
        validate_hosted_state, validate_https_origin, validate_service_origin,
    )


class HostedTransportError(OSError):
    def __init__(self, message, status=None, retry_after_ms=None):
        super().__init__(message)
        self.status = status
        self.retry_after_ms = retry_after_ms


MAX_HTTPS_HEADER = 2048
READ_CHUNK = 4096


def redact_secret(value, secret):
    text = str(value)
    if isinstance(secret, str) and secret:
        text = text.replace(secret, "[REDACTED]")
    return text


def badge_authorization(settings):
    settings = validate_hosted_state(settings)
    badge_id = settings["badgeId"]
    secret = settings["badgeSecret"]
    return "Badge " + badge_id + "." + secret


def build_request(settings, method, path, body=b""):
    settings = validate_hosted_state(settings)
    _host, _port, authority = validate_service_origin(
        settings["serviceOrigin"]
    )
    if method not in ("GET", "POST"):
        raise ValueError("unsupported HTTPS method")
    if (not isinstance(path, str) or not path.startswith("/")
            or any(char in path for char in "\r\n ")
            or not path.startswith("/api/")):
        raise ValueError("invalid hosted request path")
    if not isinstance(body, (bytes, bytearray, memoryview)) or len(body) > 8192:
        raise ValueError("invalid hosted request body")
    authorization = (
        "Badge " + settings["badgeId"] + "." + settings["badgeSecret"]
    )
    headers = (
        "%s %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Authorization: %s\r\n"
        "Accept-Encoding: identity\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n\r\n"
    ) % (method, path, authority, authorization, len(body))
    return headers.encode() + bytes(body)


def build_blob_request(authority, path):
    if (not isinstance(authority, str) or not authority
            or any(char in authority for char in "\r\n /@:")
            or not isinstance(path, str) or not path.startswith("/")
            or any(char in path for char in "\r\n ?#")):
        raise ValueError("invalid Blob request")
    return (
        "GET %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Accept-Encoding: identity\r\n"
        "Connection: close\r\n\r\n"
    ) % (path, authority)


class VerifiedHttps:
    def __init__(self, origin, allowed_hosts, clock, socket_module, ssl_module,
                 ca_file=HOSTED_CA_FILE,
                 timeout_seconds=HOSTED_TLS_TIMEOUT_SECONDS):
        self.host, self.port, self.authority = validate_https_origin(
            origin, allowed_hosts
        )
        self.clock = clock
        self.socket_module = socket_module
        self.ssl_module = ssl_module
        self.ca_file = ca_file
        self.timeout_seconds = timeout_seconds

    def _context(self):
        protocol = getattr(
            self.ssl_module, "PROTOCOL_TLS_CLIENT",
            getattr(self.ssl_module, "PROTOCOL_TLS", None),
        )
        if protocol is None:
            raise HostedTransportError("TLS API unavailable")
        try:
            context = self.ssl_module.SSLContext(protocol)
            context.verify_mode = self.ssl_module.CERT_REQUIRED
            context.load_verify_locations(cafile=self.ca_file)
        except (AttributeError, OSError, TypeError, ValueError):
            raise HostedTransportError("TLS verification unavailable") from None
        if context.verify_mode != self.ssl_module.CERT_REQUIRED:
            raise HostedTransportError("TLS verification unavailable")
        return context

    def connect(self):
        self.clock.bootstrap()
        context = self._context()
        raw = None
        try:
            addresses = self.socket_module.getaddrinfo(
                self.host, self.port, 0, self.socket_module.SOCK_STREAM
            )
            if not addresses:
                raise OSError("DNS failed")
            address = addresses[0]
            raw = self.socket_module.socket(
                address[0], address[1], address[2]
            )
            raw.settimeout(self.timeout_seconds)
            raw.connect(address[-1])
            secured = context.wrap_socket(
                raw, server_hostname=self.host
            )
            raw = None
            return secured
        except (AttributeError, OSError, TypeError, ValueError):
            if raw is not None:
                raw.close()
            raise HostedTransportError("verified HTTPS failed") from None


class HttpsBody:
    """Exact-length response body with bounded socket reads."""

    def __init__(self, socket, length, initial=b""):
        self.socket = socket
        self.length = length
        self.initial = initial
        self.offset = 0
        self.received = 0
        if len(initial) > length:
            raise HostedTransportError("HTTPS response overflow")

    def read(self, count=READ_CHUNK):
        if count <= 0 or self.received >= self.length:
            return b""
        count = min(count, READ_CHUNK, self.length - self.received)
        if self.offset < len(self.initial):
            end = min(len(self.initial), self.offset + count)
            data = self.initial[self.offset:end]
            self.offset = end
        else:
            read = getattr(self.socket, "read", None)
            data = read(count) if callable(read) else self.socket.recv(count)
            if data is None:
                data = b""
        if not data:
            raise HostedTransportError("truncated HTTPS response")
        self.received += len(data)
        return data

    def finish(self):
        if self.received != self.length:
            raise HostedTransportError("truncated HTTPS response")

    def close(self):
        self.socket.close()


def _send_all(socket, request):
    view = memoryview(request)
    sent = 0
    while sent < len(view):
        count = socket.send(view[sent:])
        if count is None or count <= 0:
            raise HostedTransportError("HTTPS request failed")
        sent += count


def open_response(connection, request, maximum_length):
    socket = connection.connect()
    try:
        _send_all(socket, request)
        header = bytearray()
        remainder = b""
        while True:
            read = getattr(socket, "read", None)
            data = read(READ_CHUNK) if callable(read) else socket.recv(READ_CHUNK)
            if not data:
                raise HostedTransportError("truncated HTTPS headers")
            header.extend(data)
            marker = header.find(b"\r\n\r\n")
            if marker >= 0:
                if marker + 4 > MAX_HTTPS_HEADER:
                    raise HostedTransportError("HTTPS headers too large")
                remainder = bytes(header[marker + 4:])
                del header[marker + 4:]
                break
            if len(header) > MAX_HTTPS_HEADER:
                raise HostedTransportError("HTTPS headers too large")
        lines = bytes(header).split(b"\r\n")
        status = lines[0].split(b" ")
        if (len(status) < 2 or status[0] not in (b"HTTP/1.0", b"HTTP/1.1")
                or len(status[1]) != 3
                or any(char < 48 or char > 57 for char in status[1])):
            raise HostedTransportError("invalid HTTPS status")
        status_code = int(status[1])
        length = None
        retry_after_ms = None
        for line in lines[1:]:
            if not line:
                continue
            parts = line.split(b":", 1)
            if len(parts) != 2:
                raise HostedTransportError("invalid HTTPS header")
            name, value = parts[0].lower(), parts[1].strip()
            if name == b"content-length":
                if (length is not None or not value
                        or any(char < 48 or char > 57 for char in value)):
                    raise HostedTransportError("invalid HTTPS length")
                length = int(value)
            elif name == b"transfer-encoding":
                raise HostedTransportError("chunked HTTPS unsupported")
            elif name == b"content-encoding" and value.lower() != b"identity":
                raise HostedTransportError("encoded HTTPS unsupported")
            elif name == b"retry-after":
                if (not value or any(char < 48 or char > 57 for char in value)):
                    raise HostedTransportError("invalid HTTPS retry")
                retry_after_ms = min(60000, max(1000, int(value) * 1000))
        if status_code != 200:
            raise HostedTransportError(
                "HTTPS request rejected", status_code, retry_after_ms
            )
        if length is None or not 1 <= length <= maximum_length:
            raise HostedTransportError("invalid HTTPS length")
        return HttpsBody(socket, length, remainder)
    except Exception:
        socket.close()
        raise
