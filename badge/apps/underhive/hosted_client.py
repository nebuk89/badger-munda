"""Hosted protocol 2 sync and direct immutable Blob frame playback."""

try:
    import ujson as json
except ImportError:
    import json
try:
    import uhashlib as hashlib
except ImportError:
    import hashlib
import binascii

try:
    from .defaults import HOSTED_MAX_PNG
    from .hosted_config import validate_hosted_state
    from .hosted_protocol import (
        MAX_CATALOG_BYTES, MAX_SYNC_BYTES, HostedProtocolError, frame_url,
        parse_catalog, parse_sync_json, validate_blob_url,
        validate_frame_template,
    )
    from .hosted_transport import (
        HostedTransportError, VerifiedHttps, build_blob_request, build_request,
        open_response,
    )
    from .protocol import HEADER_SIZE, PNG, parse_frame_header
except ImportError:
    from defaults import HOSTED_MAX_PNG
    from hosted_config import validate_hosted_state
    from hosted_protocol import (
        MAX_CATALOG_BYTES, MAX_SYNC_BYTES, HostedProtocolError, frame_url,
        parse_catalog, parse_sync_json, validate_blob_url,
        validate_frame_template,
    )
    from hosted_transport import (
        HostedTransportError, VerifiedHttps, build_blob_request, build_request,
        open_response,
    )
    from protocol import HEADER_SIZE, PNG, parse_frame_header

MAX_FRAME_BYTES = HEADER_SIZE + HOSTED_MAX_PNG


class HostedClient:
    def __init__(self, sink, settings, clock, socket_module, ssl_module,
                 ticks_diff, ticks_add, boot_id, firmware_version,
                 target_fps=8, claim_handler=None):
        self.settings = validate_hosted_state(settings)
        self.sink = sink
        self.clock = clock
        self.socket_module = socket_module
        self.ssl_module = ssl_module
        self.diff = ticks_diff
        self.add = ticks_add
        self.boot_id = boot_id
        self.firmware_version = firmware_version
        self.target_fps = max(1, min(8, target_fps))
        self.claim_handler = claim_handler
        self.status = "Connecting hosted station"
        self.error_code = None
        self.failures = 0
        self.due = None
        self.sync_due = None
        self.plan = None
        self.catalog = None
        self.location = None
        self.last_revision = None
        self.last_signature = None
        self.last_frame_index = None
        self.pending = None
        self.last_applied = None
        self.last_receipt = None
        self.claim = None
        self.fps = 0.0
        self.fps_start = None
        self.fps_frames = 0
        self.closed = False

    def _connection(self, origin, hosts):
        return VerifiedHttps(
            origin, hosts, self.clock, self.socket_module, self.ssl_module
        )

    def _service_response(self, body):
        request = build_request(
            self.settings, "POST", "/api/device/sync", body
        )
        connection = self._connection(
            self.settings["serviceOrigin"],
            (self.settings["serviceOrigin"][8:],),
        )
        return open_response(connection, request, MAX_SYNC_BYTES)

    def _blob_response(self, url, maximum):
        authority, path = validate_blob_url(
            url, self.location["origin"], self.location["root"]
        )
        request = build_blob_request(authority, path).encode()
        connection = self._connection(
            self.location["origin"], (self.location["host"],)
        )
        return open_response(connection, request, maximum)

    @staticmethod
    def _read_all(response, maximum):
        output = bytearray()
        try:
            while len(output) < response.length:
                output.extend(response.read())
                if len(output) > maximum:
                    raise HostedProtocolError("response is too large")
            response.finish()
            return bytes(output)
        finally:
            response.close()

    def _report(self):
        report = {
            "protocol": 2,
            "bootId": self.boot_id,
            "firmwareVersion": self.firmware_version,
            "fps": self.fps,
            "errorCode": self.error_code,
        }
        if self.last_revision is not None:
            report["knownStationRevision"] = self.last_revision
        if self.last_receipt is not None:
            report["lastReceipt"] = self.last_receipt
        return json.dumps(report).encode()

    def _sync(self, now):
        response = self._service_response(self._report())
        result = parse_sync_json(self._read_all(response, MAX_SYNC_BYTES))
        self.clock.observe(result["serverTimeMs"] // 1000)
        self.sync_due = self.add(now, result["syncAfterMs"])
        if result["mode"] == "claim":
            self.plan = None
            self.catalog = None
            self.location = None
            self.last_frame_index = None
            self.status = "Badge not claimed"
            self.claim = {
                "code": result["claimCode"],
                "expiresAtMs": result["claimExpiresAtMs"],
            }
            if self.claim_handler is not None:
                self.claim_handler(self.claim)
            return
        if self.claim is not None:
            self.claim = None
            if self.claim_handler is not None:
                self.claim_handler(None)
        revision = result["stationRevision"]
        signature = (
            result["commandSeq"], result["playbackGeneration"],
            result["contentVersion"], result["clip"]["id"],
            result["paused"], result["clip"]["durationMs"],
            result["clip"]["fps"], result["clip"]["frameCount"],
        )
        if self.last_revision is not None:
            if revision < self.last_revision:
                raise HostedProtocolError("stale station revision")
            if revision == self.last_revision and signature != self.last_signature:
                raise HostedProtocolError("conflicting station revision")
            if (result["commandSeq"] < self.last_signature[0]
                    or result["playbackGeneration"] < self.last_signature[1]):
                raise HostedProtocolError("stale playback state")
        location = validate_frame_template(
            result["clip"]["frameUrlTemplate"],
            result["contentVersion"],
            result["clip"]["id"],
        )
        if (self.location is None
                or self.location["root"] != location["root"]
                or self.plan is None
                or self.plan["clip"]["id"] != result["clip"]["id"]):
            self.catalog = None
            self.last_frame_index = None
        self.location = location
        self.plan = result
        self.last_revision = revision
        self.last_signature = signature
        self.status = "Syncing hosted content"

    def _load_catalog(self):
        response = self._blob_response(
            self.location["catalogUrl"], MAX_CATALOG_BYTES
        )
        try:
            catalog = parse_catalog(
                response, self.plan["contentVersion"], self.plan["clip"]["id"]
            )
            response.finish()
        finally:
            response.close()
        clip = self.plan["clip"]
        if (catalog["durationMs"] != clip["durationMs"]
                or catalog["fps"] != clip["fps"]
                or catalog["frameCount"] != clip["frameCount"]):
            raise HostedProtocolError("sync and catalog metadata differ")
        self.catalog = catalog
        self.status = "Hosted content ready"

    def _frame_index(self):
        clip = self.plan["clip"]
        if self.plan["paused"]:
            position = clip["positionMs"]
        else:
            position = max(0, int(self.clock.time.time() * 1000)
                           - clip["startedAtMs"])
        position %= clip["durationMs"]
        return min(
            clip["frameCount"] - 1,
            int(position * clip["fps"] // 1000),
        )

    def _load_frame(self, index):
        expected_id = self.catalog["frameIds"][index]
        expected_hash = self.catalog["frameHashes"][index]
        response = self._blob_response(
            frame_url(self.location, index), MAX_FRAME_BYTES
        )
        digest = hashlib.sha256()
        header = bytearray()
        try:
            while len(header) < HEADER_SIZE:
                part = response.read(HEADER_SIZE - len(header))
                header.extend(part)
                digest.update(part)
            frame_id, fps, flags, length = parse_frame_header(header, PNG)
            if (frame_id != expected_id or fps != self.catalog["fps"]
                    or flags != 0 or response.length != HEADER_SIZE + length):
                raise HostedProtocolError("frame metadata mismatch")
            self.sink.begin(length)
            received = 0
            while received < length:
                part = response.read(min(4096, length - received))
                digest.update(part)
                self.sink.write(part)
                received += len(part)
            response.finish()
            actual_hash = binascii.hexlify(digest.digest()).decode()
            if actual_hash != expected_hash:
                raise HostedProtocolError("frame hash mismatch")
            self.sink.commit()
        except Exception:
            self.sink.abort()
            raise
        finally:
            response.close()
        self.pending = {
            "stationRevision": self.plan["stationRevision"],
            "commandSeq": self.plan["commandSeq"],
            "playbackGeneration": self.plan["playbackGeneration"],
            "frameId": expected_id,
        }
        self.last_frame_index = index
        self.status = "Paused" if self.plan["paused"] else "Live"

    def _fail(self, now, error):
        self.sink.abort()
        self.failures = min(6, self.failures + 1)
        if isinstance(error, HostedProtocolError):
            self.status = "Hosted content rejected"
            self.error_code = "protocol_invalid"
            self.plan = None
            self.catalog = None
            self.location = None
        elif isinstance(error, HostedTransportError):
            if error.status in (401, 403):
                self.status = "Badge credentials rejected"
                self.error_code = "auth_failed"
            elif error.status == 429:
                self.status = "Hosted station busy"
                self.error_code = "server_backoff"
            else:
                self.status = "Hosted station offline"
                self.error_code = "network_failed"
        elif isinstance(error, MemoryError):
            self.status = "Not enough free RAM"
            self.error_code = "memory_low"
        elif isinstance(error, OSError):
            self.status = "Hosted station offline"
            self.error_code = "network_failed"
        else:
            self.status = "Hosted playback failed"
            self.error_code = "client_failed"
        delay = min(30000, 1000 * (2 ** (self.failures - 1)))
        if isinstance(error, HostedTransportError):
            if error.status in (401, 403):
                delay = 30000
            elif error.retry_after_ms is not None:
                delay = error.retry_after_ms
        self.due = self.add(now, delay)

    def _expire_claim(self, now):
        if self.claim is None:
            return
        current = int(self.clock.time.time() * 1000)
        if current < self.claim["expiresAtMs"]:
            return
        self.claim = None
        self.status = "Claim code expired"
        self.error_code = "claim_expired"
        self.sync_due = now
        self.due = None
        if self.claim_handler is not None:
            self.claim_handler(None)

    def claim_seconds(self):
        if self.claim is None:
            return None
        remaining = self.claim["expiresAtMs"] - int(
            self.clock.time.time() * 1000
        )
        return max(0, (remaining + 999) // 1000)

    def retry_seconds(self, now):
        if self.due is None:
            return None
        remaining = self.diff(self.due, now)
        return max(0, (remaining + 999) // 1000)

    def confirm_presented(self, now):
        if self.pending is None:
            return
        receipt = self.pending
        self.pending = None
        frame_id = receipt["frameId"]
        if frame_id != self.last_applied:
            if self.fps_start is None:
                self.fps_start = now
            self.fps_frames += 1
        self.last_applied = frame_id
        self.last_receipt = receipt
        elapsed = self.diff(now, self.fps_start) if self.fps_start is not None else 0
        if elapsed >= 2000:
            self.fps = self.fps_frames * 1000 / elapsed
            self.fps_frames = 0
            self.fps_start = now

    def update(self, now, connected=True):
        if self.closed:
            return
        self._expire_claim(now)
        if not connected:
            self.status = "Waiting for Wi-Fi"
            self.error_code = "wifi_unavailable"
            return
        if self.due is not None and self.diff(now, self.due) < 0:
            return
        try:
            if (self.plan is None or self.sync_due is None
                    or self.diff(now, self.sync_due) >= 0):
                self._sync(now)
            elif self.catalog is None:
                self._load_catalog()
            else:
                index = self._frame_index()
                if index != self.last_frame_index:
                    self._load_frame(index)
            self.failures = 0
            self.error_code = None
            interval = 1000 // self.target_fps
            self.due = self.add(now, interval)
        except (HostedProtocolError, HostedTransportError, OSError,
                ValueError, MemoryError) as error:
            self._fail(now, error)

    def close(self):
        self.closed = True
        self.sink.abort()
        if self.claim_handler is not None and self.claim is not None:
            self.claim_handler(None)
        self.claim = None
        self.pending = None
        self.settings = None
        self.plan = None
        self.catalog = None
