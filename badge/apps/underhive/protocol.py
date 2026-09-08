"""Bounded UBF1 and HTTP parsing, shared by MicroPython and host tests."""

import struct

WIDTH = 160
HEIGHT = 120
HEADER_SIZE = 20
RGBA = 1
RGB332 = 3
PNG = 4
MAX_PNG = 32768
MAX_HTTP_HEADER = 2048


class ProtocolError(ValueError):
    pass


def parse_frame_header(data, expected_format):
    if len(data) != HEADER_SIZE:
        raise ProtocolError("frame header length")
    magic, width, height, fmt, flags, fps, sequence, length = struct.unpack(
        "<4sHHBBHII", data
    )
    if magic != b"UBF1" or (width, height) != (WIDTH, HEIGHT):
        raise ProtocolError("frame dimensions or magic")
    if fmt != expected_format or flags & ~1 or not 1 <= fps <= 60:
        raise ProtocolError("frame format, flags or fps")
    if fmt == RGBA and length != WIDTH * HEIGHT * 4:
        raise ProtocolError("RGBA length")
    if fmt == RGB332 and length != WIDTH * HEIGHT:
        raise ProtocolError("RGB332 length")
    if fmt == PNG and not 57 <= length <= MAX_PNG:
        raise ProtocolError("PNG length")
    if fmt not in (RGBA, RGB332, PNG):
        raise ProtocolError("unsupported format")
    return (sequence, fps, flags, length)


def parse_http_header(data):
    lines = bytes(data).split(b"\r\n")
    status = lines[0].split(b" ")
    if len(status) < 2 or status[0] not in (b"HTTP/1.0", b"HTTP/1.1"):
        raise ProtocolError("HTTP status")
    if status[1] != b"200":
        # Do not echo error bodies, which can contain credentials or URLs.
        raise ProtocolError("HTTP non-200")
    length = None
    for line in lines[1:]:
        if not line:
            continue
        parts = line.split(b":", 1)
        if len(parts) != 2:
            raise ProtocolError("HTTP header")
        name, value = parts[0].lower(), parts[1].strip()
        if name == b"content-length":
            if length is not None or not value or not all(48 <= c <= 57 for c in value):
                raise ProtocolError("HTTP content length")
            length = int(value)
        if name == b"transfer-encoding":
            raise ProtocolError("chunked transfer unsupported")
        if name == b"content-encoding" and value.lower() != b"identity":
            raise ProtocolError("content encoding unsupported")
    if length is None or not HEADER_SIZE + 57 <= length <= HEADER_SIZE + WIDTH * HEIGHT * 4:
        raise ProtocolError("HTTP body length")
    return length


def validate_config(url, token, device_id):
    if not isinstance(url, str) or not url.startswith("http://"):
        raise ValueError("use HTTP with a numeric LAN IPv4 address")
    authority = url[7:].rstrip("/")
    if "/" in authority or "@" in authority:
        raise ValueError("server URL must be an origin")
    parts = authority.split(":")
    if len(parts) > 2:
        raise ValueError("IPv4 address required")
    octets = parts[0].split(".")
    if len(octets) != 4 or any(
        not p or not all("0" <= c <= "9" for c in p) or not 0 <= int(p) <= 255
        for p in octets
    ):
        raise ValueError("IPv4 address required")
    port = int(parts[1]) if len(parts) == 2 else 80
    if not 1 <= port <= 65535:
        raise ValueError("invalid port")
    if not isinstance(token, str) or not 16 <= len(token) <= 256:
        raise ValueError("device token required")
    if any(not (33 <= ord(c) <= 126) for c in token):
        raise ValueError("invalid token")
    safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
    if not isinstance(device_id, str) or not 1 <= len(device_id) <= 64:
        raise ValueError("invalid device ID")
    if any(c not in safe for c in device_id):
        raise ValueError("invalid device ID")
    return parts[0], port, authority


class FrameParser:
    """Feed arbitrary fragments; commit only one fully validated response."""

    def __init__(self, sink):
        self.sink = sink
        self.http = bytearray()
        self.header = bytearray(HEADER_SIZE)
        self.reset()

    def reset(self):
        self.http[:] = b""
        self.state = "http"
        self.http_length = None
        self.header_used = 0
        self.received = 0
        self.meta = None
        self.done = False

    def feed(self, data):
        offset = 0
        while offset < len(data):
            if self.state == "http":
                self.http.append(data[offset])
                offset += 1
                if len(self.http) > MAX_HTTP_HEADER:
                    raise ProtocolError("HTTP headers too large")
                if self.http[-4:] == b"\r\n\r\n":
                    self.http_length = parse_http_header(self.http)
                    self.state = "header"
            elif self.state == "header":
                count = min(HEADER_SIZE - self.header_used, len(data) - offset)
                self.header[self.header_used:self.header_used + count] = data[offset:offset + count]
                self.header_used += count
                offset += count
                if self.header_used == HEADER_SIZE:
                    self.meta = parse_frame_header(self.header, self.sink.format_code)
                    if self.http_length != HEADER_SIZE + self.meta[3]:
                        raise ProtocolError("HTTP/frame length mismatch")
                    self.sink.begin(self.meta[3])
                    self.state = "body"
            elif self.state == "body":
                count = min(self.meta[3] - self.received, len(data) - offset)
                self.sink.write(data[offset:offset + count])
                self.received += count
                offset += count
                if self.received == self.meta[3]:
                    self.state = "complete"
            else:
                raise ProtocolError("trailing response bytes")
        if self.state == "complete" and not self.done:
            self.sink.commit()
            self.done = True

    def eof(self):
        if not self.done:
            raise ProtocolError("truncated response")
