"""Memory-only rendering; no device-flash path or download fallback exists."""

import struct
import binascii

WIDTH = 160
HEIGHT = 120
MAX_PNG = 32768
RAM_BYTES = 16 * 4096
MOUNT = "/underhive-ram"


class UnsupportedFirmware(RuntimeError):
    pass


class RamBlockDevice:
    """The only backing store supplied to LittleFS is this retained bytearray."""

    BLOCK_SIZE = 4096

    def __init__(self, byte_length=RAM_BYTES):
        if (type(byte_length) is not int or byte_length < 4 * self.BLOCK_SIZE
                or byte_length % self.BLOCK_SIZE):
            raise ValueError("invalid RAM device size")
        self.blocks = [
            bytearray(self.BLOCK_SIZE)
            for _ in range(byte_length // self.BLOCK_SIZE)
        ]
        self.views = [memoryview(block) for block in self.blocks]
        self.byte_length = byte_length
        self.erased = b"\xff" * self.BLOCK_SIZE

    def readblocks(self, block, buf, offset=0):
        start = block * self.BLOCK_SIZE + offset
        target = memoryview(buf)
        used = 0
        while used < len(buf):
            index, within = divmod(start + used, self.BLOCK_SIZE)
            count = min(len(buf) - used, self.BLOCK_SIZE - within)
            target[used:used + count] = self.views[index][within:within + count]
            used += count
        return 0

    def writeblocks(self, block, buf, offset=None):
        start = block * self.BLOCK_SIZE
        if offset is None:
            for index in range(block, block + (len(buf) + self.BLOCK_SIZE - 1) // self.BLOCK_SIZE):
                self.views[index][:] = self.erased
            offset = 0
        source = memoryview(buf)
        used = 0
        while used < len(buf):
            index, within = divmod(start + offset + used, self.BLOCK_SIZE)
            count = min(len(buf) - used, self.BLOCK_SIZE - within)
            self.views[index][within:within + count] = source[used:used + count]
            used += count
        return 0

    def ioctl(self, op, arg):
        if op in (1, 2, 3):
            return 0
        if op == 4:
            return self.byte_length // self.BLOCK_SIZE
        if op == 5:
            return self.BLOCK_SIZE
        if op == 6:
            self.views[arg][:] = self.erased
            return 0
        return None


def validate_png(stream, length, scratch):
    """Reject malformed/wrong-size PNGs before the old unchecked C decoder."""
    stream.seek(0)
    header = stream.read(33)
    if len(header) != 33 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("invalid PNG")
    if header[8:16] != b"\x00\x00\x00\rIHDR":
        raise ValueError("invalid IHDR")
    w, h, depth, color, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", header[16:29]
    )
    if (w, h) != (WIDTH, HEIGHT) or depth != 8 or color not in (2, 3, 6):
        raise ValueError("unsupported PNG dimensions or color")
    if compression or filtering or interlace:
        raise ValueError("interlaced PNG unsupported")
    if binascii.crc32(header[12:29]) & 0xffffffff != struct.unpack(">I", header[29:33])[0]:
        raise ValueError("PNG CRC")
    used, palette, image_data, ended = 33, 0, False, False
    seen_transparency = False
    while used < length:
        chunk = stream.read(8)
        if len(chunk) != 8:
            raise ValueError("truncated PNG chunk")
        size, kind = struct.unpack(">I4s", chunk)
        if used + size + 12 > length or kind == b"IHDR":
            raise ValueError("PNG chunk size")
        if kind not in (b"PLTE", b"tRNS", b"IDAT", b"IEND", b"pHYs", b"sRGB", b"gAMA", b"cHRM"):
            raise ValueError("unsupported PNG chunk")
        if kind == b"PLTE":
            if palette or image_data or not size or size > 768 or size % 3:
                raise ValueError("invalid PNG palette")
            palette = size // 3
        if kind == b"tRNS":
            if seen_transparency or image_data or color == 6:
                raise ValueError("invalid PNG transparency")
            if (color == 3 and not 1 <= size <= palette) or (color == 2 and size != 6):
                raise ValueError("invalid PNG transparency length")
            seen_transparency = True
        expected_size = {b"pHYs": 9, b"sRGB": 1, b"gAMA": 4, b"cHRM": 32}.get(kind)
        if expected_size is not None and size != expected_size:
            raise ValueError("invalid PNG ancillary chunk")
        if kind == b"IDAT":
            if color == 3 and not palette:
                raise ValueError("missing PNG palette")
            image_data = True
        if kind == b"IEND":
            if size or not image_data or used + 12 != length:
                raise ValueError("invalid PNG ending")
            ended = True
        crc, remaining = binascii.crc32(kind), size
        while remaining:
            count = min(remaining, len(scratch))
            view = scratch[:count]
            if stream.readinto(view) != count:
                raise ValueError("truncated PNG data")
            crc = binascii.crc32(view, crc)
            remaining -= count
        expected = stream.read(4)
        if len(expected) != 4 or crc & 0xffffffff != struct.unpack(">I", expected)[0]:
            raise ValueError("PNG CRC")
        used += size + 12
    if not ended:
        raise ValueError("missing PNG ending")


class RamPngSink:
    format_code = 4
    format_name = "png"

    def __init__(self, screen, vfs_module, free_memory=None,
                 ram_bytes=RAM_BYTES, max_png=MAX_PNG):
        if (screen.width, screen.height) != (WIDTH, HEIGHT):
            raise UnsupportedFirmware("screen dimensions")
        if not callable(getattr(screen, "load_into", None)):
            raise UnsupportedFirmware("screen.load_into absent")
        if not all(hasattr(vfs_module, name) for name in ("VfsLfs2", "mount", "umount")):
            raise UnsupportedFirmware("RAM LittleFS unavailable")
        if (type(ram_bytes) is not int or type(max_png) is not int
                or not 57 <= max_png <= ram_bytes):
            raise ValueError("invalid RAM PNG capacity")
        if free_memory is not None and free_memory < ram_bytes + 49152:
            raise MemoryError("insufficient free RAM")
        self.screen = screen
        self.vfs = vfs_module
        self.writer = None
        self.mounted = False
        self.path = MOUNT + "/frame.png"
        self.max_png = max_png
        self.device = RamBlockDevice(ram_bytes)
        self.scratch = memoryview(bytearray(1024))
        vfs_module.VfsLfs2.mkfs(self.device)
        self.fs = vfs_module.VfsLfs2(self.device)
        # No mkdir: MicroPython mounts are virtual. Mount failure is fatal;
        # opening the frame path is impossible until mounting has succeeded.
        vfs_module.mount(self.fs, MOUNT)
        self.mounted = True
        self.length = 0
        self.written = 0

    def begin(self, length):
        self.abort()
        if not self.mounted or not 57 <= length <= self.max_png:
            raise ValueError("invalid RAM PNG frame")
        self.length = length
        self.written = 0
        try:
            self.fs.remove("/frame.png")
        except OSError as error:
            if not error.args or error.args[0] != 2:
                raise
        # Direct filesystem-object open, not global open, cannot resolve flash.
        self.writer = self.fs.open("/frame.png", "wb")

    def write(self, data):
        if self.writer is None or self.written + len(data) > self.length:
            raise ValueError("RAM frame overflow")
        if self.writer.write(data) != len(data):
            raise OSError("short RAM write")
        self.written += len(data)

    def commit(self):
        if self.written != self.length or self.writer is None:
            raise ValueError("incomplete RAM frame")
        self.writer.close()
        self.writer = None
        with self.fs.open("/frame.png", "rb") as stream:
            validate_png(stream, self.length, self.scratch)
        self.screen.load_into(self.path)

    def abort(self):
        if self.writer is not None:
            self.writer.close()
            self.writer = None

    def close(self):
        self.abort()
        if self.mounted:
            self.vfs.umount(MOUNT)
            self.mounted = False
        self.fs = None
        self.device = None


class Rgb332Encoder:
    """Stream RGB332 into one valid PNG/zlib stored block, one row at a time."""

    ROW_BYTES = WIDTH + 1
    SCAN_BYTES = ROW_BYTES * HEIGHT
    PNG_LENGTH = 20168

    @staticmethod
    def _chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff))

    def __init__(self, write):
        self.output = write
        self.row = bytearray(self.ROW_BYTES)
        self.row_view = memoryview(self.row)
        palette = bytearray(768)
        for value in range(256):
            offset = value * 3
            palette[offset] = (value >> 5) * 255 // 7
            palette[offset + 1] = ((value >> 2) & 7) * 255 // 7
            palette[offset + 2] = (value & 3) * 85
        ihdr = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 3, 0, 0, 0)
        self.zlib_header = b"\x78\x01\x01" + struct.pack(
            "<HH", self.SCAN_BYTES, self.SCAN_BYTES ^ 0xffff
        )
        self.prefix = (
            b"\x89PNG\r\n\x1a\n" + self._chunk(b"IHDR", ihdr)
            + self._chunk(b"PLTE", palette)
            + struct.pack(">I", len(self.zlib_header) + self.SCAN_BYTES + 4)
            + b"IDAT" + self.zlib_header
        )
        self.ending = self._chunk(b"IEND", b"")
        self.used = 1
        self.received = 0

    def begin(self):
        self.used = 1
        self.received = 0
        self.a, self.b = 1, 0
        self.crc = binascii.crc32(self.zlib_header, binascii.crc32(b"IDAT"))
        self.output(self.prefix)

    def write(self, data):
        if self.received + len(data) > WIDTH * HEIGHT:
            raise ValueError("RGB332 frame overflow")
        self.received += len(data)
        offset = 0
        while offset < len(data):
            count = min(self.ROW_BYTES - self.used, len(data) - offset)
            self.row_view[self.used:self.used + count] = data[offset:offset + count]
            self.used += count
            offset += count
            if self.used == self.ROW_BYTES:
                # Row zero is PNG's "None" filter byte. Modulo once per row
                # keeps intermediate values inside MicroPython's small ints.
                a, b = self.a, self.b
                for value in self.row:
                    a += value
                    b += a
                self.a, self.b = a % 65521, b % 65521
                self.crc = binascii.crc32(self.row_view, self.crc)
                self.output(self.row_view)
                self.used = 1

    def finish(self):
        if self.received != WIDTH * HEIGHT or self.used != 1:
            raise ValueError("incomplete RGB332 frame")
        adler = struct.pack(">I", (self.b << 16) | self.a)
        self.crc = binascii.crc32(adler, self.crc)
        self.output(adler)
        self.output(struct.pack(">I", self.crc & 0xffffffff))
        self.output(self.ending)


class Rgb332Sink(RamPngSink):
    format_code = 3
    format_name = "rgb332"

    def __init__(self, screen, vfs_module, free_memory=None,
                 ram_bytes=RAM_BYTES, max_png=MAX_PNG):
        self.encoder = Rgb332Encoder(self._write_png)
        RamPngSink.__init__(
            self, screen, vfs_module, free_memory, ram_bytes, max_png
        )

    def _write_png(self, data):
        RamPngSink.write(self, data)

    def begin(self, length):
        if length != WIDTH * HEIGHT:
            raise ValueError("RGB332 length")
        RamPngSink.begin(self, Rgb332Encoder.PNG_LENGTH)
        self.encoder.begin()

    def write(self, data):
        self.encoder.write(data)

    def commit(self):
        self.encoder.finish()
        RamPngSink.commit(self)


class RawSink:
    format_code = 1
    format_name = "rgba"

    def __init__(self, screen):
        if (screen.width, screen.height) != (WIDTH, HEIGHT):
            raise UnsupportedFirmware("screen dimensions")
        try:
            self.target = memoryview(screen)
        except TypeError:
            raise UnsupportedFirmware("Image buffer protocol absent")
        if len(self.target) != WIDTH * HEIGHT * 4:
            raise UnsupportedFirmware("framebuffer byte length")
        try:
            self.target[:4] = self.target[:4]
        except (TypeError, ValueError):
            raise UnsupportedFirmware("framebuffer not writable")
        # A separate fixed staging buffer keeps partial network frames off-screen.
        self.buffer = bytearray(WIDTH * HEIGHT * 4)
        self.view = memoryview(self.buffer)
        self.offset = 0

    def begin(self, length):
        if length != len(self.buffer):
            raise ValueError("raw frame length")
        self.offset = 0

    def write(self, data):
        if self.offset + len(data) > len(self.buffer):
            raise ValueError("raw frame overflow")
        self.view[self.offset:self.offset + len(data)] = data
        self.offset += len(data)

    def commit(self):
        if self.offset != len(self.buffer):
            raise ValueError("incomplete raw frame")
        self.target[:] = self.view

    def abort(self):
        self.offset = 0

    def close(self):
        self.buffer = None
        self.view = None
        self.target = None
