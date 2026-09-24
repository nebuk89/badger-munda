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
    pass


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
