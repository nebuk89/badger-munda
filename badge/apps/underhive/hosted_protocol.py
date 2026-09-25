"""Bounded hosted protocol 2 and immutable catalog validation."""

try:
    import uhashlib as hashlib
except ImportError:
    import hashlib
try:
    import ujson as json
except ImportError:
    import json
import binascii

PROTOCOL_VERSION = 2
CATALOG_VERSION = 1
MAX_SYNC_BYTES = 8192
MAX_CATALOG_BYTES = 512 * 1024
MAX_TOKEN_BYTES = 1024
MAX_CLIPS = 1000
MAX_FRAMES = 10000
MAX_ACTIVE_FRAMES = 256
_HEX = "0123456789abcdef"
_BLOB_SUFFIX = ".public.blob.vercel-storage.com"


class HostedProtocolError(ValueError):
    pass


def _integer(value, minimum, maximum, name):
    if type(value) is not int or not minimum <= value <= maximum:
        raise HostedProtocolError("invalid " + name)
    return value


def _number(value, minimum, maximum, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HostedProtocolError("invalid " + name)
    if not minimum <= value <= maximum:
        raise HostedProtocolError("invalid " + name)
    return value


def _text(value, minimum, maximum, name):
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        raise HostedProtocolError("invalid " + name)
    return value


def _hash(value, name):
    _text(value, 64, 64, name)
    if any(char not in _HEX for char in value):
        raise HostedProtocolError("invalid " + name)
    return value


def validate_sync_response(value):
    if not isinstance(value, dict):
        raise HostedProtocolError("invalid sync response")
    if value.get("protocol") != PROTOCOL_VERSION:
        raise HostedProtocolError("unsupported hosted protocol")
    mode = value.get("mode")
    _integer(value.get("serverTimeMs"), 1, 4102444800000, "server time")
    _integer(value.get("syncAfterMs"), 250, 60000, "sync interval")
    if mode == "claim":
        if set(value) != {
            "protocol", "mode", "serverTimeMs", "syncAfterMs",
            "claimCode", "claimExpiresAtMs",
        }:
            raise HostedProtocolError("invalid claim response")
        code = value.get("claimCode")
        if (not isinstance(code, str) or len(code) != 6
                or any(char < "0" or char > "9" for char in code)):
            raise HostedProtocolError("invalid claim response")
        _integer(
            value.get("claimExpiresAtMs"),
            value["serverTimeMs"] + 1,
            4102444800000,
            "claim expiry",
        )
        return {
            "mode": "claim",
            "serverTimeMs": value["serverTimeMs"],
            "syncAfterMs": value["syncAfterMs"],
            "claimCode": code,
            "claimExpiresAtMs": value["claimExpiresAtMs"],
        }
    if mode != "play" or set(value) != {
        "protocol", "mode", "serverTimeMs", "syncAfterMs",
        "stationRevision", "commandSeq", "playbackGeneration",
        "contentVersion", "paused", "clip",
    }:
        raise HostedProtocolError("invalid playback response")
    if type(value.get("paused")) is not bool:
        raise HostedProtocolError("invalid paused state")
    clip = value.get("clip")
    if not isinstance(clip, dict) or set(clip) != {
        "id", "startedAtMs", "positionMs", "durationMs", "fps",
        "frameCount", "frameNumberWidth", "frameUrlTemplate",
    }:
        raise HostedProtocolError("invalid playback clip")
    clip_id = _text(clip.get("id"), 1, 80, "clip ID")
    if (clip_id[0] < "a" or clip_id[0] > "z"
            or any(not (char.isdigit() or "a" <= char <= "z" or char == "-")
                   for char in clip_id)):
        raise HostedProtocolError("invalid clip ID")
    result = {
        "mode": "play",
        "serverTimeMs": value["serverTimeMs"],
        "syncAfterMs": value["syncAfterMs"],
        "stationRevision": _integer(
            value.get("stationRevision"), 0, 2147483647, "station revision"
        ),
        "commandSeq": _integer(
            value.get("commandSeq"), 0, 2147483647, "command sequence"
        ),
        "playbackGeneration": _integer(
            value.get("playbackGeneration"), 0, 2147483647,
            "playback generation",
        ),
        "contentVersion": _hash(
            value.get("contentVersion"), "content version"
        ),
        "paused": value["paused"],
        "clip": {
            "id": clip_id,
            "startedAtMs": _integer(
                clip.get("startedAtMs"), 0, 4102444800000, "clip start"
            ),
            "positionMs": _integer(
                clip.get("positionMs"), 0, 300000, "clip position"
            ),
            "durationMs": _integer(
                clip.get("durationMs"), 1, 300000, "clip duration"
            ),
            "fps": _integer(clip.get("fps"), 1, 60, "clip FPS"),
            "frameCount": _integer(
                clip.get("frameCount"), 1, MAX_ACTIVE_FRAMES, "frame count"
            ),
            "frameNumberWidth": _integer(
                clip.get("frameNumberWidth"), 4, 4, "frame number width"
            ),
            "frameUrlTemplate": _text(
                clip.get("frameUrlTemplate"), 1, 512, "frame URL template"
            ),
        },
    }
    if result["clip"]["positionMs"] > result["clip"]["durationMs"]:
        raise HostedProtocolError("invalid clip position")
    return result


def parse_sync_json(data):
    if not isinstance(data, (bytes, bytearray)) or len(data) > MAX_SYNC_BYTES:
        raise HostedProtocolError("invalid sync response length")
    try:
        value = json.loads(bytes(data).decode())
    except (TypeError, ValueError, UnicodeError):
        raise HostedProtocolError("invalid sync JSON") from None
    return validate_sync_response(value)


def _split_https_url(value):
    if not isinstance(value, str) or not value.startswith("https://"):
        raise HostedProtocolError("asset URL must use HTTPS")
    rest = value[8:]
    slash = rest.find("/")
    if slash < 1:
        raise HostedProtocolError("asset URL must include a path")
    authority, path = rest[:slash], rest[slash:]
    if (authority != authority.lower() or ":" in authority or "@" in authority
            or "?" in path or "#" in path or "\\" in path):
        raise HostedProtocolError("invalid asset URL")
    if not authority.endswith(_BLOB_SUFFIX):
        raise HostedProtocolError("asset origin is not approved")
    store = authority[:-len(_BLOB_SUFFIX)]
    if (not store or store.startswith(".") or store.endswith(".")
            or any(not (
                "0" <= char <= "9"
                or "a" <= char <= "z"
                or "A" <= char <= "Z"
                or char in "-."
            ) for char in store)):
        raise HostedProtocolError("invalid asset origin")
    return authority, path


def validate_frame_template(template, content_hash, clip_id):
    authority, path = _split_https_url(template)
    expected = (
        "/content/v1/" + content_hash + "/clips/" + clip_id
        + "/frames/{frame}.ubf"
    )
    if path != expected:
        raise HostedProtocolError("invalid frame URL template")
    origin = "https://" + authority
    root = origin + "/content/v1/" + content_hash + "/"
    return {
        "origin": origin,
        "host": authority,
        "root": root,
        "catalogUrl": root + "catalog.json",
        "template": template,
    }


def frame_url(location, frame_index):
    if type(frame_index) is not int or not 0 <= frame_index < MAX_FRAMES:
        raise HostedProtocolError("invalid frame index")
    return location["template"].replace(
        "{frame}", ("%04d" % frame_index)
    )


def validate_blob_url(url, expected_origin, expected_root):
    authority, path = _split_https_url(url)
    if "https://" + authority != expected_origin:
        raise HostedProtocolError("asset origin changed")
    if (not url.startswith(expected_root) or path.startswith("//")
            or any(part in ("", ".", "..") for part in path[1:].split("/"))):
        raise HostedProtocolError("asset path is not approved")
    return authority, path


class _TokenStream:
    def __init__(self, reader, maximum=MAX_CATALOG_BYTES):
        self.reader = reader
        self.maximum = maximum
        self.buffer = b""
        self.offset = 0
        self.total = 0
        self.pushed = None

    def _byte(self):
        if self.offset >= len(self.buffer):
            self.buffer = self.reader.read(1024)
            self.offset = 0
            if not self.buffer:
                return None
            self.total += len(self.buffer)
            if self.total > self.maximum:
                raise HostedProtocolError("catalog is too large")
        value = self.buffer[self.offset]
        self.offset += 1
        return value

    def _push(self, value):
        self.pushed = value

    def token(self):
        value = self.pushed
        self.pushed = None
        if value is None:
            value = self._byte()
        while value in (9, 10, 13, 32):
            value = self._byte()
        if value is None:
            return None
        if value in b"{}[]:,":
            raw = bytes((value,))
            return raw.decode(), None, raw
        if value == 34:
            raw = bytearray((value,))
            escaped = False
            while True:
                value = self._byte()
                if value is None or len(raw) >= MAX_TOKEN_BYTES:
                    raise HostedProtocolError("invalid catalog string")
                raw.append(value)
                if value < 32:
                    raise HostedProtocolError("invalid catalog string")
                if escaped:
                    escaped = False
                elif value == 92:
                    escaped = True
                elif value == 34:
                    break
            try:
                decoded = json.loads(bytes(raw).decode())
            except (TypeError, ValueError, UnicodeError):
                raise HostedProtocolError("invalid catalog string") from None
            return "string", decoded, bytes(raw)
        if value == 45 or 48 <= value <= 57:
            raw = bytearray((value,))
            while True:
                value = self._byte()
                if value is None or value not in b"0123456789+-.eE":
                    self._push(value)
                    break
                if len(raw) >= 32:
                    raise HostedProtocolError("invalid catalog number")
                raw.append(value)
            text = bytes(raw).decode()
            try:
                number = float(text) if any(c in text for c in ".eE") else int(text)
            except ValueError:
                raise HostedProtocolError("invalid catalog number") from None
            return "number", number, bytes(raw)
        raise HostedProtocolError("invalid catalog token")


class _CatalogParser:
    def __init__(self, reader, expected_hash, active_clip):
        self.tokens = _TokenStream(reader)
        self.expected_hash = _hash(expected_hash, "catalog identity")
        self.active_clip = active_clip
        self.digest = hashlib.sha256()
        self.last_frame_id = 0
        self.clip_count = 0

    def _next(self, kind=None, value=None, hashed=True):
        token = self.tokens.token()
        if token is None:
            raise HostedProtocolError("truncated catalog")
        if kind is not None and token[0] != kind:
            raise HostedProtocolError("invalid catalog structure")
        if value is not None and token[1] != value:
            raise HostedProtocolError("invalid catalog value")
        if hashed:
            self.digest.update(token[2])
        return token[1]

    def _key(self, name):
        self._next("string", name)
        self._next(":")

    def _string(self, minimum, maximum, name):
        return _text(self._next("string"), minimum, maximum, name)

    def _number(self, minimum, maximum, name):
        return _number(self._next("number"), minimum, maximum, name)

    def _int(self, minimum, maximum, name):
        return _integer(self._next("number"), minimum, maximum, name)

    def _simple_array(self, item, expected_length, retain):
        result = [] if retain else None
        self._next("[")
        count = 0
        while True:
            token = self.tokens.token()
            if token is None:
                raise HostedProtocolError("truncated catalog")
            if token[0] == "]":
                self.digest.update(token[2])
                break
            if count:
                if token[0] != ",":
                    raise HostedProtocolError("invalid catalog array")
                self.digest.update(token[2])
                token = self.tokens.token()
                if token is None:
                    raise HostedProtocolError("truncated catalog")
            self.digest.update(token[2])
            value = item(token, count)
            if retain:
                result.append(value)
            count += 1
            if count > expected_length:
                raise HostedProtocolError("catalog array is too long")
        if count != expected_length:
            raise HostedProtocolError("incomplete catalog array")
        return result

    @staticmethod
    def _safe_path(value):
        if (not value or value.startswith("/") or "\\" in value
                or ":" in value
                or any(part in ("", ".", "..") for part in value.split("/"))):
            raise HostedProtocolError("unsafe catalog asset path")
        return value

    def _clip(self):
        self._next("{")
        self._key("id")
        clip_id = self._string(1, 80, "catalog clip ID")
        if (clip_id[0] < "a" or clip_id[0] > "z"
                or any(not (char.isdigit() or "a" <= char <= "z" or char == "-")
                       for char in clip_id)):
            raise HostedProtocolError("invalid catalog clip ID")
        retain = clip_id == self.active_clip
        self._next(",")
        self._key("title")
        self._string(1, 120, "catalog title")
        self._next(",")
        self._key("subtitle")
        self._string(0, 240, "catalog subtitle")
        self._next(",")
        self._key("category")
        if self._string(1, 16, "catalog category") not in (
            "advert", "notice", "event", "custom"
        ):
            raise HostedProtocolError("invalid catalog category")
        self._next(",")
        self._key("duration")
        duration = self._number(0.001, 300, "catalog duration")
        self._next(",")
        self._key("fps")
        fps = self._int(1, 60, "catalog FPS")
        self._next(",")
        self._key("frameCount")
        frame_count = self._int(1, MAX_FRAMES, "catalog frame count")
        self._next(",")
        self._key("width")
        width = self._int(1, 4096, "catalog width")
        self._next(",")
        self._key("height")
        height = self._int(1, 4096, "catalog height")
        if (width, height) != (160, 120):
            raise HostedProtocolError("unsupported catalog dimensions")
        self._next(",")
        self._key("accent")
        self._string(1, 40, "catalog accent")
        self._next(",")
        self._key("posterUrl")
        poster_url = self._safe_path(
            self._string(1, 240, "catalog poster URL")
        )
        self._next(",")
        self._key("videoUrl")
        video_url = self._safe_path(
            self._string(1, 240, "catalog video URL")
        )
        self._next(",")
        self._key("frameIds")

        def frame_id(token, _index):
            if token[0] != "number":
                raise HostedProtocolError("invalid catalog frame ID")
            value = _integer(token[1], 1, 4294967295, "catalog frame ID")
            if value <= self.last_frame_id:
                raise HostedProtocolError("catalog frame IDs are not unique")
            self.last_frame_id = value
            return value

        frame_ids = self._simple_array(frame_id, frame_count, retain)
        self._next(",")
        self._key("framePaths")

        def frame_path(token, index):
            if token[0] != "string":
                raise HostedProtocolError("invalid catalog frame path")
            value = self._safe_path(token[1])
            expected = "clips/%s/frames/%04d.ubf" % (clip_id, index)
            if value != expected:
                raise HostedProtocolError("invalid catalog frame path")
            return value

        self._simple_array(frame_path, frame_count, False)
        self._next(",")
        self._key("frameHashes")

        def frame_hash(token, _index):
            if token[0] != "string":
                raise HostedProtocolError("invalid catalog frame hash")
            return _hash(token[1], "catalog frame hash")

        frame_hashes = self._simple_array(frame_hash, frame_count, retain)
        self._next(",")
        self._key("posterPath")
        poster_path = self._safe_path(
            self._string(1, 240, "catalog poster path")
        )
        self._next(",")
        self._key("posterHash")
        _hash(self._string(64, 64, "catalog poster hash"), "catalog poster hash")
        self._next(",")
        self._key("videoPath")
        video_path = self._safe_path(
            self._string(1, 240, "catalog video path")
        )
        self._next(",")
        self._key("videoHash")
        _hash(self._string(64, 64, "catalog video hash"), "catalog video hash")
        self._next("}")
        if poster_url != poster_path or video_url != video_path:
            raise HostedProtocolError("mutable catalog preview URL")
        if not retain:
            return None
        return {
            "id": clip_id,
            "durationMs": int(duration * 1000 + 0.5),
            "fps": fps,
            "frameCount": frame_count,
            "frameIds": frame_ids,
            "frameHashes": frame_hashes,
        }

    def parse(self):
        self._next("{")
        self._key("version")
        self._next("number", CATALOG_VERSION)
        self._next(",")
        self._key("clips")
        self._next("[")
        active = None
        while True:
            token = self.tokens.token()
            if token is None:
                raise HostedProtocolError("truncated catalog")
            if token[0] == "]":
                self.digest.update(token[2])
                break
            if self.clip_count:
                if token[0] != ",":
                    raise HostedProtocolError("invalid catalog clips")
                self.digest.update(token[2])
                token = self.tokens.token()
                if token is None:
                    raise HostedProtocolError("truncated catalog")
            self.tokens.pushed = token[2][0]
            clip = self._clip()
            if clip is not None:
                if active is not None:
                    raise HostedProtocolError("duplicate active clip")
                active = clip
            self.clip_count += 1
            if self.clip_count > MAX_CLIPS:
                raise HostedProtocolError("catalog has too many clips")
        if not self.clip_count or active is None:
            raise HostedProtocolError("active clip is absent from catalog")
        self.digest.update(b"}")
        self._next(",", hashed=False)
        self._next("string", "catalogHash", hashed=False)
        self._next(":", hashed=False)
        catalog_hash = self._next("string", hashed=False)
        self._next("}", hashed=False)
        if self.tokens.token() is not None:
            raise HostedProtocolError("trailing catalog data")
        actual = binascii.hexlify(self.digest.digest()).decode()
        if catalog_hash != self.expected_hash or actual != self.expected_hash:
            raise HostedProtocolError("catalog hash mismatch")
        return active


def parse_catalog(reader, expected_hash, active_clip):
    return _CatalogParser(reader, expected_hash, active_clip).parse()
