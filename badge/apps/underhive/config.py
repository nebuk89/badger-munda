"""Copy-specific settings. Never put Wi-Fi credentials in this file."""

SERVER_URL = ""
DEVICE_TOKEN = ""
DEVICE_ID = "desk-badge"

# Stock MonaOS does not expose Image's buffer protocol. PNGs are staged only
# in a private RAM block device, never on the badge's flash filesystem.
FRAME_FORMAT = "png"
TARGET_FPS = 8
