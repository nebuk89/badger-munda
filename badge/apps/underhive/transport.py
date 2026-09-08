"""Nonblocking, one-request-at-a-time HTTP transport with finite deadlines."""

import errno

try:
    from .protocol import FrameParser, ProtocolError, validate_config
except ImportError:
    from protocol import FrameParser, ProtocolError, validate_config


class Transport:
    def __init__(self, sink, url, token, device, socket_module, select_module,
                 ticks_diff, ticks_add, target_fps=8):
        host, port, authority = validate_config(url, token, device)
        self.address = (host, port)
        self.authority = authority
        self.token = token
        self.device_id = device
        self.socket_module = socket_module
        self.select_module = select_module
        self.diff = ticks_diff
        self.add = ticks_add
        self.sink = sink
        self.parser = FrameParser(sink)
        self.target_fps = max(1, min(8, target_fps))
        self.buffer = bytearray(4096)
        self.view = memoryview(self.buffer)
        self.socket = None
        self.poller = None
        self.state = "idle"
        self.status = "Waiting for Wi-Fi"
        self.error_type = None
        self.due = None
        self.failures = 0
        self.last_applied = None
        self.pending = None
        self.fps = 0.0
        self.fps_start = None
        self.fps_frames = 0
        self.closed = False

    def _request(self):
        headers = (
            "GET /api/badge/frame?format=%s&device=%s HTTP/1.1\r\n"
            "Host: %s\r\nAuthorization: Bearer %s\r\n"
            "Accept-Encoding: identity\r\nConnection: close\r\n"
        ) % (self.sink.format_name, self.device_id, self.authority, self.token)
        if self.last_applied is not None:
            headers += "X-Badge-Frame: %d\r\nX-Badge-Fps: %.2f\r\n" % (
                self.last_applied, self.fps
            )
        return (headers + "\r\n").encode()

    @staticmethod
    def _would_block(error):
        return bool(error.args) and error.args[0] in (
            errno.EAGAIN, getattr(errno, "EWOULDBLOCK", errno.EAGAIN),
            getattr(errno, "EINPROGRESS", 115), getattr(errno, "EALREADY", 114)
        )

    def _disconnect(self):
        if self.socket is not None:
            self.socket.close()
            self.socket = None
        self.poller = None
        self.request_view = None
        self.state = "idle"

    def _start(self, now):
        self.parser.reset()
        self.request_view = memoryview(self._request())
        self.sent = 0
        self.started = now
        self.progress = now
        self.socket = self.socket_module.socket(
            self.socket_module.AF_INET, self.socket_module.SOCK_STREAM
        )
        self.socket.setblocking(False)
        self.poller = self.select_module.poll()
        self.poller.register(self.socket, self.select_module.POLLOUT)
        self.state = "sending"
        try:
            self.socket.connect(self.address)
        except OSError as error:
            if not self._would_block(error):
                raise

    def _fail(self, now, error):
        self._disconnect()
        self.sink.abort()
        self.error_type = type(error).__name__
        self.status = "Broadcaster offline"
        self.failures = min(5, self.failures + 1)
        self.due = self.add(now, min(15000, 1000 * (2 ** (self.failures - 1))))

    def confirm_presented(self, now):
        # Called on the update AFTER decoding: badgeware's display.update()
        # occurs between these two calls. Never acknowledge partial frames.
        if self.pending is None:
            return
        sequence = self.pending
        self.pending = None
        if sequence != self.last_applied:
            if self.fps_start is None:
                self.fps_start = now
            self.fps_frames += 1
        self.last_applied = sequence
        elapsed = self.diff(now, self.fps_start) if self.fps_start is not None else 0
        if elapsed >= 2000:
            self.fps = self.fps_frames * 1000 / elapsed
            self.fps_frames = 0
            self.fps_start = now

    def update(self, now, connected=True):
        if self.closed:
            return
        try:
            if not connected:
                if self.socket is not None:
                    self._disconnect()
                    self.sink.abort()
                self.status = "Waiting for Wi-Fi"
                return
            if self.state == "idle":
                if self.due is None or self.diff(now, self.due) >= 0:
                    self._start(now)
                else:
                    return
            if self.diff(now, self.started) >= 3000 or self.diff(now, self.progress) >= 1200:
                raise OSError("request timeout")
            events = self.poller.poll(0)
            if not events:
                return
            flags = events[0][1]
            if flags & self.select_module.POLLERR:
                raise OSError("socket failure")
            if self.state == "sending":
                if flags & self.select_module.POLLHUP:
                    raise OSError("connection closed")
                count = self.socket.send(self.request_view[self.sent:])
                if count is None:
                    return
                if count <= 0:
                    raise OSError("send failed")
                self.sent += count
                self.progress = now
                if self.sent == len(self.request_view):
                    self.state = "reading"
                    self.poller.modify(self.socket, self.select_module.POLLIN)
                return
            # Two bounded reads per update; no frame-length blocking loop.
            for _ in range(2):
                count = self.socket.readinto(self.view)
                if count is None:
                    return
                if count == 0:
                    self.parser.eof()
                    break
                self.progress = now
                self.parser.feed(self.view[:count])
                if self.parser.done:
                    sequence, fps, flags, _length = self.parser.meta
                    self.pending = sequence
                    self.status = "Paused" if flags & 1 else "Live"
                    self.failures = 0
                    self.error_type = None
                    self.due = self.add(self.started, 1000 // min(self.target_fps, fps))
                    self._disconnect()
                    return
        except OSError as error:
            if not self._would_block(error):
                self._fail(now, error)
        except (ProtocolError, ValueError, MemoryError) as error:
            self._fail(now, error)

    def close(self):
        self.closed = True
        self._disconnect()
        self.sink.abort()
        self.token = None
