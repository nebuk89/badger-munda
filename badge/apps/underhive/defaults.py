"""Non-secret bounds for Underhive state and Wi-Fi setup."""

STATE_DIR = "/state/underhive"
STATE_SEED_DIR = "/system/state/underhive"
WIFI_STATE_FILE = "wifi.v1.json"
HOSTED_STATE_FILE = "hosted.v1.json"
TRUSTED_TIME_FILE = "trusted-time.v1.json"
STATE_SCHEMA = 1
MAX_STATE_BYTES = 8192
MAX_SAVED_NETWORKS = 5

HOSTED_SERVICE_ORIGIN = "https://badger-munda.vercel.app"
HOSTED_CA_FILE = "/apps/underhive/gts-roots.pem"
HOSTED_TLS_TIMEOUT_SECONDS = 8

SETUP_HOLD_MS = 3000
SETUP_IDLE_MS = 10 * 60 * 1000
SETUP_TOTAL_MS = 15 * 60 * 1000
SETUP_JOIN_MS = 30000
SETUP_ERROR_MIN_MS = 1000
SETUP_HTTP_PORT = 80
SETUP_MAX_REQUEST = 8192
SETUP_CLIENT_IDLE_MS = 5000
SETUP_CHANNEL = 6
