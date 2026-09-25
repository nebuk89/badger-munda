# Underhive badge client

This is the badge-side companion to the Mac broadcaster. Install
`apps/underhive/` as `/system/apps/underhive/` **only after backup and approval**.
The parent project handles installation, menu preservation/pagination, and
copy-specific configuration. The app and paginated menu are installed on the
desk badge. Its firmware and `main.py` remain unchanged.

## Evidence and current proof status

The upstream application reference is
[`badger/home` at `99f5552`](https://github.com/badger/home/tree/99f555209256dfe0e91fd62a699445942cb40838).
Stock software uses a **160 × 120** logical screen; the LCD itself is 320 × 240.

**The default is compressed PNG, wire format 4.** The Mac converts each frame
to a fixed 256-color RGB332 palette and compresses the PNG. The badge receives
it into RAM LittleFS and calls `screen.load_into()`. No frame writes go to
device flash. The optional RGB332 backend encodes PNG on the badge instead.

Do **not** infer support from today's Badgeware documentation:

* The historical PicoVector commit explicitly labelled
  [“Backport GH changes” (`00b8844`, 2025-11-13)](https://github.com/pimoroni/picovector/commit/00b88441848b31ebb46e943d90161b2c84ede234)
  has [`Image`'s C binding](https://github.com/pimoroni/picovector/blob/00b88441848b31ebb46e943d90161b2c84ede234/micropython/image.hpp#L339-L346)
  with **no buffer slot**. `load()` and `load_into()` accept paths, not bytes.
  Its constructor is not a safe basis for guessing a `from_buffer` API.
* Its [PNG callbacks](https://github.com/pimoroni/picovector/blob/00b88441848b31ebb46e943d90161b2c84ede234/micropython/image_png.hpp#L19-L69)
  call `mp_vfs_stat`, `mp_vfs_open`, native stream read, seek, and close. A native
  LittleFS file on a bytearray-backed block device satisfies this API without
  any flash frame writes. A plain Python object with a `read()` method would
  **not** be sufficient for these C stream callbacks.
* The published [MonaOS v4.03 factory UF2](https://github.com/badger/home/releases/tag/mona-os-v4.03)
  was downloaded to the workstation for static inspection, not installed.
  Its payload contains `VfsLfs2`, `mount`, `Image`, `load_into`, `SSLContext`,
  `CERT_REQUIRED`, `load_verify_locations`, and `ntptime` names.
  This corroborates availability; binary strings alone are not runtime proof.
* Modern [PicoVector](https://github.com/pimoroni/picovector/blob/main/micropython/image.cpp)
  does register an image buffer slot and wraps caller-supplied buffers. This is
  a different firmware generation. The optional RGBA backend must pass a
  writable `memoryview(screen)` length check and have its RGBA color ordering
  confirmed before selection.

**Verified:** host tests cover fragmented HTTP/frame parsing, complete-frame-only
commit and acknowledgements, bounded RAM-device behavior, PNG validation,
timeouts, reconnect, lifecycle import, tick wrap, and buffer reuse. The RAM VFS
path is source-backed, not a guessed `Image` API.
The RGB332 wrapper's output is also decoded with host zlib and compared
byte-for-byte with the original 19,200 pixel indices across fragmented inputs.

**Physical playback is live as of 8 September 2026.** The user saw the adverts
on the badge over Wi-Fi. The server received applied-frame acknowledgements
across all three clips. Five samples during an initial 25-second observation
reported 4.24-8.03 FPS. This is not a long-duration performance result.
The latest initialization reported 104,848 bytes free after transport setup.

The RAM LittleFS path and native PNG decoder also passed the color-bar probe.
The original contiguous 96 KiB allocation caused a `MemoryError` during app
startup. Sixteen separate 4 KiB blocks replaced it. Wi-Fi then needed a corrected
network name; the badge connected after the user selected a visible network.

Long-duration playback, battery life, connection recovery, and HOME during
decode still need physical checks. HOME uses the stock launcher handler.
There is no flash-download fallback.

## Wire contract

The stock configuration requests:

```http
GET /api/badge/frame?format=png&device=desk-badge HTTP/1.1
Authorization: Bearer DEVICE_TOKEN
Accept-Encoding: identity
Connection: close
```

The response is a normal HTTP 200 with an exact `Content-Length`. Chunked
transfer, compression, redirects, oversized headers, and error bodies are
rejected. Its body starts with this **20-byte little-endian** header:

```python
struct.pack("<4sHHBBHII", b"UBF1", 160, 120, format_code,
            flags, fps, sequence, payload_length)
```

| Field | Meaning |
|---|---|
| `format_code = 3` | RGB332, optional on-device PNG encoder |
| `format_code = 4` | **PNG**, default; Mac compresses each frame |
| `format_code = 1` | RGBA8888, only with supported writable screen buffer |
| `flags & 1` | Paused; all other flag bits must be zero |
| `fps` | 1–60; client requests at most 8 FPS |
| `sequence` | Unsigned 32-bit sequence, including wrap |
| PNG length | 57–32,768 bytes |
| RGBA length | Exactly 76,800 bytes |
| RGB332 length | Exactly 19,200 bytes |

The optional RGB332 backend uses red in bits 7–5, green in bits 4–2, and blue in bits 1–0. A
precomputed 256-color PNG palette expands each component back to 0–255. The
incremental encoder retains one 161-byte scanline, emits filter zero, and uses a
single uncompressed DEFLATE block with correct CRC32 and Adler32 checksums. Every
generated PNG is exactly **20,168 bytes**. No whole-frame Python allocation or
compression pass occurs per frame.

**Wire-PNG requirements:** exactly 160 × 120, 8-bit RGB, RGBA, or indexed color;
non-interlaced. A 256-color palette with `bitdepth: 8` is recommended. Do not let
an optimizer reduce indexed bit depth to 1, 2, or 4. CRCs, dimensions, chunk
lengths, allowed chunk types, and final IEND are checked before entering the old
native decoder. Allowed ancillary chunks are `tRNS`, `pHYs`, `sRGB`, `gAMA`, and
`cHRM`; strip embedded metadata. No APNG. Server output must stay below the
payload cap rather than asking the device to allocate more memory.

The **next** request reports `X-Badge-Frame` and `X-Badge-Fps` only after the
following app `update()`: the stock [`badgeware.run()`](https://github.com/pimoroni/tufty2350/blob/a66be6272cac9b9518c260f3d4bcf1593bb8b19a/modules/common/badgeware.py#L502-L518)
presents the display between app updates. This means “applied by software,” not
independent optical confirmation of the panel. Network last-seen is separate.
FPS counts newly presented sequence numbers, not duplicate polls.

## Hosted HTTPS foundation

Hosted configuration stays separate from Wi-Fi state:

```json
{
  "schema": 1,
  "mode": "hosted",
  "serviceOrigin": "https://badger-munda.vercel.app",
  "badgeId": "11111111-1111-4111-8111-111111111111",
  "badgeSecret": "<43-character base64url secret>"
}
```

The installer writes this format to the USB-visible
`/state/underhive/hosted.v1.json` path. MonaOS exposes that file at
`/system/state/underhive/hosted.v1.json` during runtime.
If all writable runtime copies are absent, the app validates the system seed
and atomically copies it to `/state/underhive/hosted.v1.json`.
Valid runtime primary, candidate, or backup state has priority.
Corrupt runtime state fails closed and does not fall back to the system seed.
An absent runtime file and absent system seed select local mode.
The validator accepts only the exact hosted origin, a canonical UUID, and a
32-byte base64url secret. It rejects paths, ports, credentials, IP addresses,
other Vercel hosts, non-HTTPS schemes, extra fields, and header characters.

`hosted_transport.py` forms `Authorization: Badge <badge-id>.<badge-secret>`.
It provides bounded request construction for later protocol 2 sync.
Errors use fixed messages, and the redaction helper removes the secret from
diagnostic text. Current code does not log request bytes or exception details.

`VerifiedHttps` uses `SSLContext`, `CERT_REQUIRED`, a CA file, and
`server_hostname`. It has no unverified mode and no fallback path.
MonaOS exposes the installed CA file at
`/system/apps/underhive/gts-roots.pem` during runtime.
The bundled CA file contains Google Trust Services Root R1 and R4 certificates
from the [Google Trust Services repository](https://pki.goog/repository/).
The live controller certificate used Root R1 during development.
A CA change outside these roots needs an app update.

TLS certificate checks need valid UTC. The installer writes a workstation UTC
seed to the USB-visible `/state/underhive/trusted-time.v1.json` path.
MonaOS exposes this seed at
`/system/state/underhive/trusted-time.v1.json` during runtime.
The app validates and copies it to writable runtime state when all runtime
copies are absent.
`TrustedClock` sets an old or reset RTC to that saved lower bound before TLS.
Only a later verified HTTPS response can advance this state in a later layer.
The client does not use unauthenticated NTP to bypass certificate time checks.
Missing, corrupt, backwards, unsupported, or out-of-range time fails closed.
USB reprovisioning refreshes the read-only system seed.
Remove the writable trusted-time runtime copies before restart when the badge
must import that newer seed.

The hosted client sends protocol 2 sync reports to
`https://badger-munda.vercel.app/api/device/sync`.
It accepts only protocol version 2 and monotonic station state.
It derives `catalog.json` from the immutable frame template and content hash.
The origin must match `*.public.blob.vercel-storage.com`.
The content path must match
`/content/v1/<catalog-hash>/clips/<clip-id>/frames/{frame}.ubf`.

The catalog parser reads at most 1,024 bytes from the response at one time.
It hashes a compact token stream that matches the server catalog identity.
It validates every clip and frame entry, but it retains only the active clip.
The active clip can contain at most 256 frames.
The current hosted package uses 64 frames per clip.

Each frame request goes directly to the approved public Blob origin.
The client checks the response length, catalog frame hash, frame ID, FPS,
UBF1 header, PNG payload bound, and PNG structure before display.
It never sends badge authorization to Blob.
TLS, authorization, protocol, origin, catalog, and frame failures do not start
an unverified or local fallback.

The client uses 1/2/4/8/16/30-second retry delays.
It uses a bounded `Retry-After` value for hosted rate limits.
Authentication failures use a 30-second retry delay.
It keeps the last complete frame during temporary network failures.
It rejects stale or conflicting revisions and fetches a new catalog after a
content version or clip change.
Wi-Fi setup closes the hosted client before it changes network state.
An absent hosted state still selects the existing local Mac transport.

An unclaimed badge shows the six-digit claim code and a minute-second expiry.
The client clears the code at expiry and immediately requests a new sync.
The screen never shows the badge secret.
After the launcher presents a complete frame, the next scheduled sync reports
the station revision, command sequence, playback generation, and frame ID.
The client keeps only the latest receipt and does not send a request per frame.
Presence reports include the boot ID, `MonaOS-4.03`, known station revision,
measured FPS, and one stable error code.

Hosted playback handles restart, Wi-Fi loss, stale content, server backoff,
paused stations, game-event interruption, and clip changes.
It keeps the last complete frame during temporary failures.
It clears only clip-specific catalog state after a clip change.
HOME and Wi-Fi setup close the transport and abort pending frame work.

## Memory and responsiveness

Default PNG mode uses **65,536 bytes** for LittleFS, split across sixteen
**4,096-byte** bytearrays with retained memoryviews. It also retains a
**4,096-byte** erased block, a **4,096-byte** transport buffer, a
**1,024-byte** PNG-validation buffer, and at most **2,048 bytes** of HTTP headers.
The optional RGB332 encoder adds a **161-byte** scanline and a PNG prefix of
approximately **832 bytes**. The existing screen is reused via `screen.load_into()`.

There is no large Python frame buffer in RGB332/PNG mode. The frame writer is opened
directly on the in-memory filesystem object, not through the global filesystem.
Only the verified mounted path `/underhive-ram/frame.png` is passed to the native
decoder. Mount failure is fatal; no directory is created on flash. LittleFS
files and native decoder caches have additional implementation-dependent memory.
Initialization requires at least RAM-device size plus 48 KiB free; this is a
guardrail, **not a measured sufficiency guarantee**.

RGBA mode has one retained 76,800-byte staging buffer plus the existing screen.
Network fragments never paint partial raw frames.

Hosted mode adds a 1,024-byte catalog read chunk, a 4,096-byte HTTPS read
chunk, and the active frame IDs and SHA-256 hashes.
The 256-frame cap bounds the retained catalog index.
The built-in 64-frame clips retain 64 integers and 64 hashes.
The client never retains a full catalog, clip, or contiguous frame payload in
one Python bytearray. The RAM LittleFS sink remains the largest fixed allocation.

Each app update performs at most two nonblocking 4 KiB socket reads. It uses a
numeric IPv4 address to avoid unbounded DNS resolution, a 1.2-second inactivity
deadline, a 3-second total request deadline, and 1/2/4/8/15-second retry backoff.
Wi-Fi association has a 30-second deadline and a 15-second retry delay.
A negative driver status ends an attempt after at least one second.
The app reads `/system/secrets.py` before the legacy `/secrets.py` copy or the factory secrets module.
The persistent file appears as `secrets.py` on the BADGER USB drive.
On a hardware reset, this badge restores `/secrets.py` from `/system/secrets.py`.
Changing only `/secrets.py` can work until that reset, then restore the old network name and password.
An existing connected WLAN can also be reused. The update loop yields for
one millisecond while Wi-Fi is disconnected; HTTP requests remain nonblocking.
Animated dots and elapsed seconds show that connection attempts remain active.
Notices distinguish a missing network, a rejected password, and a join timeout.
HOME stays owned by the stock launcher.

Native PNG decoding, incremental Adler32 calculation, and RAM LittleFS writes are synchronous and must be measured
on hardware. The stock loop also runs garbage collection each update. **8 FPS is
a target, not a promise.** RAM staging protects flash endurance but may be slower
than writable-framebuffer firmware. Errors show a built-in offline/unsupported
notice, never a secret-bearing server response or exception message.

## Configuration

Edit the installed copy's `config.py`:

```python
SERVER_URL = "http://MAC_LAN_IPV4:8787"
DEVICE_TOKEN = "<the private device token>"
DEVICE_ID = "desk-badge"
FRAME_FORMAT = "png"
TARGET_FPS = 8
DISPLAY_ROTATION = 180
```

The tabletop installation uses `DISPLAY_ROTATION = 180` for an upside-down badge.
Use `0` for the stock upright orientation. Older configurations without this field remain upright.
The app sets the native ST7789 orientation before it draws any connection notices.
This rotates all Underhive output, including pairing codes, adverts, and game events.
Phone previews stay upright. HOME resets the device and restores the stock launcher orientation.
No extra frame buffer, image conversion, or firmware change is needed.

The driver uses [MADCTL 0x90](https://github.com/pimoroni/tufty2350/blob/main/modules/c/st7789/st7789.cpp).
The upside-down setting uses 0x50 to reverse both axes without changing scan order.
The [Python command binding](https://github.com/pimoroni/tufty2350/blob/main/modules/c/st7789/st7789_bindings.cpp) needs a tuple of data bytes.

The committed token is intentionally empty. Device IDs allow ASCII letters,
digits, hyphens, and underscores only. Keep private settings out of Git. HTTP
bearer authentication is appropriate only on a trusted isolated LAN: it does
not encrypt the token or pixels. Do not port-forward the broadcaster.

Optional button-control POSTs are deliberately omitted; phone controls remain
authoritative.

## Installation and Wi-Fi setup

Start the Mac station before installation. Press RESET twice for USB Disk Mode.
Run the local installer from the repository root:

```sh
npm run badge:install
```

If the Mac has several LAN addresses, set `SERVER_URL` to the address the badge
can reach. The installer saves a private backup under `data/backups/`.
It writes the app, device configuration, and paginated menu.
New installations default to the upside-down tabletop orientation.
Set `BADGE_ROTATION=0` when you run the installer for an upright badge.
Eject BADGER safely before a normal RESET.

For hosted foundation provisioning, use the badge UUID and the one-time secret:

```sh
BADGE_MODE=hosted \
BADGE_ID="<badge UUID>" \
BADGE_SECRET="<one-time 32-byte base64url secret>" \
npm run badge:install
```

Do not put the secret on the command line as an argument.
The environment value does not appear in installer output.
Hosted provisioning preserves an existing local `config.py` and all Wi-Fi
state. It updates the shared app modules and CA file, then atomically replaces
each hosted state file. It writes trusted time before hosted credentials.
It removes stale hosted `.new` and `.bak` copies after replacement.
MonaOS exposes the USB files under `/system/state/underhive` at runtime.
The app imports valid hosted and trusted-time seeds into writable
`/state/underhive` state on its next start.
Wi-Fi profiles stay only in writable runtime state.
The installed app selects hosted playback on its next start.
To select local mode, remove the writable hosted runtime copies and the
USB-visible hosted seed.

### On-device Wi-Fi setup

Underhive can save up to five Wi-Fi networks in
`/state/underhive/wifi.v1.json`. The app checks this state before it uses the
existing `/system/secrets.py` fallback. It never changes the read-only
`/system` copy during normal runtime.

Hold A and C together for three seconds to start setup. The app closes the
frame transport, scans in station mode, then starts a WPA access point. The
badge shows:

* the temporary `UNDERHIVE-XXXX` network name;
* the random access-point password;
* the actual manual setup URL from the AP interface.

Join that network from a phone. Open the shown URL. Select or enter a network,
then enter its password. The badge stops AP mode and tests the submitted
network for 30 seconds. It saves the profile only after association succeeds.
If the test fails, the same setup access point starts again. Press B to cancel.
HOME still returns to the stock launcher.

The local HTTP server accepts one bounded request at a time. It rejects
chunked requests, duplicate fields, oversized requests, invalid lengths, and
mutations without the setup nonce. It never returns saved passwords.

The exact MonaOS v4.03 source proves the AP configuration, WPA key, channel,
scan, and `ifconfig()` APIs. A real badge must still prove DHCP and phone
association. The manual URL is the required path. Captive DNS is not enabled
until Android and iPhone hardware checks pass.

State replacement uses a checked `.new` file and keeps the prior valid `.bak`
copy. A corrupt primary file falls back to a valid candidate or backup. If no
state copy is valid, Underhive keeps the `/system/secrets.py` fallback.

The setup path does not change `SERVER_URL`, `DEVICE_TOKEN`, `DEVICE_ID`,
`hosted.v1.json`, the local Mac broadcaster, frame rendering, pairing cards,
or programme behavior.

Prepare the serial tools once:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r tools/requirements.txt
```

Set Wi-Fi from a local interactive terminal:

```sh
.venv/bin/python tools/configure-wifi.py
```

Both entries hide typing. The tool saves credentials in the persistent `/system/secrets.py` file.
It preserves a private `/system/secrets.py.before-underhive` backup, flushes the write, and checks the saved values.
It does not save credentials on the Mac.
This USB path remains the service and recovery fallback.
Use the exact network name, including case, for a visible 2.4 GHz network.
The Mac and phone can use 5 GHz on the same reachable LAN.
A new password does not fix `Wi-Fi network not found`.

After setup, press RESET once. Press a front button to pass the Universe splash.
From the initial menu selection, press A for Underhive on page two.
Press B to start it. Keep the Mac awake while it serves the broadcast.
Use a full hardware reset to check persistence; a serial soft reset alone does not cover the boot-copy behaviour.

## Safe probe, then hardware acceptance

Generate the exact MicroPython source without opening serial:

```sh
python3 tools/badge_probe.py --emit
python3 tools/badge_probe.py --emit --prove-display --format png
```

The coordinator must first approve stopping the running app and switching out of
USB Disk Mode. The tool refuses serial access while `/Volumes/BADGER` exists.
After approval, eject/leave Disk Mode using the agreed hardware procedure, then:

```sh
python3 tools/badge_probe.py --port /dev/cu.usbmodem12101 --allow-interrupt
python3 tools/badge_probe.py --port /dev/cu.usbmodem12101 \
  --allow-interrupt --prove-display --format png --iterations 10
```

`--allow-interrupt` is explicit authorization to enter raw REPL using Ctrl-C and
Ctrl-A. The probe does not switch USB mode, copy files,
import secrets, or alter firmware. It executes in RAM and returns to normal REPL,
not automatically to the launcher. `--soft-reset` resets MicroPython first;
it is not the default. The display test writes only the block-backed
RAM filesystem, exercises the PNG decoder, and shows
red/green/blue/white/black bars. Only prefixed capability
results and error **types** are printed; other serial output is suppressed.
The older probe serial helper can fail when the badge resets USB.
The Wi-Fi tools use `badge_connection.py`, which retries after USB reconnects.

Acceptance checklist:

1. Confirm `width=160`, `height=120`, `load_into=True`, `vfs_lfs2=True`.
2. Confirm `ram_block_bytes=65536`, ten displayed frames, no proof error, and
   visually correct color bars. Record free-memory minimum and elapsed time.
3. Verify continuous wireless playback and reported applied sequences. Measure
   sustained FPS; the local color-bar loop is not a Wi-Fi throughput benchmark.
4. Stop the Mac server and Wi-Fi independently: the app must show an offline
   notice, recover, and never show a partially received frame.
5. Test HOME while connecting, receiving, and decoding. Its IRQ-based reset is
   provided by stock `main.py`; avoid assuming native decode is preemptible.
6. Compare parent-owned before/after device backups to confirm flash changes are
   limited to the intentional one-time installation/configuration.
7. On MonaOS v4.03, prove that `SSLContext` loads the bundled roots, checks the
   live hostname, and completes a handshake within the memory limit.
8. Remove power long enough to reset RTC state. Prove that USB-seeded time
   restores certificate validation without NTP or an unverified TLS attempt.

### Hosted layer acceptance

Run the hardware-free soak test first:

```sh
npm run badge:soak
```

The command runs 20,000 deterministic update cycles.
It checks claim expiry, receipt bounds, Wi-Fi loss, server backoff, stale state,
pause, event clip changes, cleanup, and retained-memory growth.

Use MonaOS v4.03 for the physical checks below.
Do not flash firmware as part of these checks.

1. Record free memory before display setup and after hosted transport setup.
   Compare both values with the local PNG baseline.
   Confirm that playback does not raise `memory_low` during a 30-minute run.
2. Start hosted mode with the bundled GTS roots.
   Confirm a verified handshake to the configured hostname.
   Confirm that no unverified TLS path or NTP request occurs.
3. Run one normal clip for 30 minutes.
   Record the minimum, median, and maximum reported FPS.
   Confirm that the badge keeps the latest complete frame if it misses a frame.
4. Remove Wi-Fi for 60 seconds.
   Restore Wi-Fi.
   Confirm `wifi_unavailable`, bounded retries, automatic recovery, and no partial frame.
5. Stop the hosted service long enough to reach the 30-second retry cap.
   Start the service.
   Confirm automatic recovery without a badge reset.
6. Pause the station, dispatch a game event, replace it with another event,
   then clear the event.
   Confirm each clip switch starts the correct immutable content.
   Confirm that the paused advert resumes at its saved position.
7. Press HOME while the badge connects, downloads a frame, decodes PNG, and shows playback.
   Confirm return to the stock launcher each time.
   Confirm that the transport and RAM sink close without a credential log.
8. Remove power long enough to lose RTC state.
   Start hosted mode offline, then restore the network.
   Confirm that the USB-seeded lower bound restores verified TLS.
9. Compare the parent-owned backup from before installation with a new backup.
   Confirm changes only in the approved app, menu, hosted state, trusted time, and Wi-Fi state files.
10. Remove `hosted.v1.json` from a test copy.
    Confirm that Underhive starts the existing local Mac mode with the same rotation and Wi-Fi setup behavior.

Host validation:

```sh
python3 -m unittest discover -s badge/tests -v
```
