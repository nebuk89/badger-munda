# Underhive Broadcast

A local television station for a GitHub Badger 2350 and a phone.
The Mac serves the content over Wi-Fi. The phone controls playback and previews videos independently.

## What it does

- Plays thirteen original animated adverts, plus videos you import.
- Provides phone controls for play, replay, pause, queue, and repeat.
- Shows temporary round and event broadcasts over the current programme.
- Dispatches six game-event videos that play once, then resume the interrupted advert.
- Serves 160x120 frames to the badge without a normal MP4 decoder.
- Shows device connections, acknowledged frames, and reported playback speed.
- Preserves the badge's existing apps through a paginated menu.

The phone preview shows the server's output, not a camera view of the badge.
Device acknowledgements show which frame the client reports as applied.
The system does not promise frame-accurate synchronisation between devices.

## Start the Mac station

Use Node.js 24 or newer.

```sh
npx --yes pnpm@10 install
npm run content
npm run build
npm start
```

The terminal shows a phone address and a six-digit pairing code.
Open that address on a phone that can reach the Mac on the local network.
Enter the code in the phone page.

The default address on the Mac is `http://localhost:8787`.
Keep the Mac awake while it serves the broadcast.
The phone can lock without stopping the badge.
No internet connection is needed after installation.

Use `PORT` to change the server port.
Use `DATA_DIR` to change the private data directory.
The defaults are port `8787` and `./data`.

## Development

Run the API server and Vite in separate terminals:

```sh
npm run server:dev
npm run dev
```

Vite forwards `/api` and `/media` to the server on port 8787.
The production server serves the built phone interface itself.
Restart `npm start` after a new production build.

## Hosted badge registry and device sync

The hosted controller uses one private administrator password.
The registry gives each badge a UUID and a separate 32-byte device secret.
The service returns a device secret only after badge creation or administrator rotation.
Save it then, and use the safe USB installer to provision the badge ID, service URL, and secret.
The service stores only keyed HMAC values for device secrets and claim codes.

Provision the hosted foundation while the badge is in USB Disk Mode:

```sh
BADGE_MODE=hosted \
BADGE_ID="<badge UUID>" \
BADGE_SECRET="<one-time 32-byte base64url secret>" \
npm run badge:install
```

The hosted service origin defaults to `https://badger-munda.vercel.app`.
The installer rejects all other origins.
It writes `/state/underhive/hosted.v1.json` and a separate trusted UTC seed.
It does not put hosted credentials in Wi-Fi state, logs, or error text.
It preserves an installed local `config.py`, Wi-Fi state, firmware, `main.py`, and unrelated files.
The badge uses these files to start protocol 2 sync after Wi-Fi connects.
Local mode still uses the existing Mac frame transport when hosted state is absent.

Set these hosted environment variables in addition to the database and administrator settings:

| Variable | Purpose |
|---|---|
| `CLAIM_CODE_HMAC_KEY` | Key for six-digit claim-code HMAC values |
| `DEVICE_SECRET_HMAC_KEY` | Key for badge-secret HMAC values |
| `CONTENT_CATALOG_URL` | Immutable public `catalog.json` URL under `content/v1/<sha256>/` |
| `CONTENT_BLOB_BASE_URL` | Allowlisted public Blob origin and path prefix |

Use a different random value for each key.
Run `npm run db:migrate` to apply `drizzle/0001_badge_registry.sql` and `drizzle/0002_device_sync.sql`.
The second migration adds bounded presence, latest receipts, content versions, credential use, and durable device limits.

An administrator can create, list, claim, rotate, and revoke badges.
Claim codes contain six digits, work once, and expire after ten minutes.
This layer stores and consumes claim rows, but it does not issue codes from badge runtime.
Secret rotation can overlap the old credential for no more than 24 hours.
Rotation still needs USB reprovisioning.
The server never sends a replacement secret to badge runtime.
The protocol 2 client sends `Authorization: Badge <badge-id>.<badge-secret>` to `POST /api/device/sync`.
The service checks a keyed HMAC value and accepts each active overlap credential until its expiry.
Revoked badges and revoked credentials fail with the same invalid-credential response.

Protocol 2 reports a boot ID, a firmware version, an optional known station revision, an optional last receipt, FPS, and a safe error code.
An unclaimed badge receives one six-digit claim code with a ten-minute expiry.
A claimed badge receives the server time, station and command revisions, playback generation, pause state, clip timing, FPS, frame count, and a public Blob `{frame}` URL template.
The service stores one presence row and one latest receipt row for each badge.
The badge derives the immutable catalog URL from the approved Blob frame URL.
It streams and hashes the catalog, and it retains only the active clip index.
It fetches each immutable `UBF1` indexed-PNG frame directly from Blob.
The Vercel Function does not proxy frames or send a long frame stream.
The badge checks protocol versions, revisions, catalog identity, frame paths,
frame IDs, hashes, UBF1 headers, response lengths, and PNG bounds.
It rejects non-Vercel Blob origins and content paths outside the active catalog.
The client supports at most 256 frames in one active clip to keep memory bounded.
This layer does not show claim codes or send playback receipts.

| Endpoint | Purpose | Authentication |
|---|---|---|
| `GET /api/badges` | List badge identities and claim status | Administrator cookie |
| `POST /api/badges` | Create a badge and show its secret once | Cookie and CSRF |
| `POST /api/badges/claim` | Consume a six-digit claim code | Cookie and CSRF |
| `POST /api/badges/:badgeId/rotate-secret` | Create a secret for USB reprovisioning | Cookie and CSRF |
| `POST /api/badges/:badgeId/revoke` | Revoke a badge and its credentials | Cookie and CSRF |

Do not put passwords, hashes, credentials, codes, or the database URL in URLs or logs.

## Content

`npm run content` creates thirteen original Underhive adverts and notices, plus six game-event videos.
The first pack contains Ration Works, Curfew Signal, and Sump Tavern.
The expansion adds ten designs for utilities, shops, transport, housing, and local notices.
Each advert has browser video, a poster, and raw badge frames.
The generator preserves existing complete clips.

Restart the Mac station after you generate new clips while it is running.
The badge reconnects automatically. The phone needs the same pairing code again.
This restart is not needed for clips that you upload through the controller.

### Downloadable samples

The repository includes all thirteen adverts and six game events as ready-to-use MP4s with PNG posters.
Each video is silent, eight seconds long, and 640x480 at 8 FPS.

| Advert | Video | Poster |
|---|---|---|
| Ration Works | [MP4](samples/ration-works/video.mp4) | [PNG](samples/ration-works/poster.png) |
| Curfew Signal | [MP4](samples/curfew-signal/video.mp4) | [PNG](samples/curfew-signal/poster.png) |
| Sump Tavern | [MP4](samples/sump-tavern/video.mp4) | [PNG](samples/sump-tavern/poster.png) |
| Clean Air Club | [MP4](samples/clean-air/video.mp4) | [PNG](samples/clean-air/poster.png) |
| Second Hands | [MP4](samples/second-hands/video.mp4) | [PNG](samples/second-hands/poster.png) |
| Shaft Nine | [MP4](samples/shaft-nine/video.mp4) | [PNG](samples/shaft-nine/poster.png) |
| Guild Credit | [MP4](samples/guild-credit/video.mp4) | [PNG](samples/guild-credit/poster.png) |
| Salvage Union | [MP4](samples/salvage-union/video.mp4) | [PNG](samples/salvage-union/poster.png) |
| Ash Waste Tours | [MP4](samples/ash-waste-tours/video.mp4) | [PNG](samples/ash-waste-tours/poster.png) |
| Missing Servitor | [MP4](samples/missing-servitor/video.mp4) | [PNG](samples/missing-servitor/poster.png) |
| Power Co-op | [MP4](samples/power-coop/video.mp4) | [PNG](samples/power-coop/poster.png) |
| Sump Shuffle | [MP4](samples/sump-shuffle/video.mp4) | [PNG](samples/sump-shuffle/poster.png) |
| Hab Block 13 | [MP4](samples/hab-block-thirteen/video.mp4) | [PNG](samples/hab-block-thirteen/poster.png) |

| Game event | Video | Poster |
|---|---|---|
| Failed Jump | [MP4](samples/event-failed-jump/video.mp4) | [PNG](samples/event-failed-jump/poster.png) |
| Fatality | [MP4](samples/event-fatality/video.mp4) | [PNG](samples/event-fatality/poster.png) |
| Dice Fail | [MP4](samples/event-dice-fail/video.mp4) | [PNG](samples/event-dice-fail/poster.png) |
| Critical Hit | [MP4](samples/event-critical-hit/video.mp4) | [PNG](samples/event-critical-hit/poster.png) |
| Ammo Jam | [MP4](samples/event-ammo-jam/video.mp4) | [PNG](samples/event-ammo-jam/poster.png) |
| Bottled It | [MP4](samples/event-bottled-it/video.mp4) | [PNG](samples/event-bottled-it/poster.png) |

Download an MP4 from its GitHub file page to use it elsewhere.
To import one into a station, select **Upload clip** in the controller.
Select the downloaded MP4, then select **Import clip**.
The clip stays off air until you select **Play on badge**.

For this station's complete starter pack, run `npm run content`.
That command creates the individual 160x120 PNG and RGBA frames under `data/library/`.
An eight-second advert has 64 frames at 8 FPS.
These files are a rebuildable frame cache, separate from the sample MP4s.
The repository excludes the cache, private settings, and device backups.
Use `npm run content` for the game-event controls; normal uploads become custom clips, not game-event presets.

### Package the built-in content

`npm run content:hosted` packages the nineteen built-in clips for a hosted content store.
The package contains 1,216 complete `UBF1` frames with indexed PNG payloads, plus the sample posters and videos.
Each frame keeps a stable catalog-wide frame ID from 1 through 1,216.
The command writes the package under `generated/hosted/content/v1/<catalog-hash>/`.
The catalog hash depends only on the packaged content, so the same inputs make the same package.
The repository excludes the generated package.

Run a credentials-free package and upload check:

```sh
npm run content:hosted
npm run content:upload:check
```

Link the local directory to the Vercel project and pull its environment:

```sh
npx vercel link
npx vercel env pull .env.local
set -a
. ./.env.local
set +a
pnpm content:upload
```

The uploader uses OIDC when `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID` are set.
In this mode, it does not pass `BLOB_READ_WRITE_TOKEN`, including Vercel's protected `[SENSITIVE]` placeholder.
If OIDC is not available, set a valid `BLOB_READ_WRITE_TOKEN` before you run the upload.
The uploader uses public Blob objects, fixed content paths, no random suffix, no overwrite, and a one-year cache lifetime.
It uploads `catalog.json`, complete `UBF1` indexed-PNG frames, posters, and MP4 previews.
It rejects raw RGBA files, changed hashes, missing files, extra files, and unsupported file types.
Set `CONTENT_CATALOG_URL` to the uploaded content-addressed catalog URL.
Set `CONTENT_BLOB_BASE_URL` to its allowlisted public Blob root.

### Dispatch a game event

The **Game events** section contains six illustrated controls for moments during a game.
Select **Preview** to watch a video on the phone without changing the broadcast.
Select **Dispatch event** to send it to the broadcast.
Each eight-second video plays once, then the advert resumes from the exact position where it stopped.
The queue, repeat setting, and previous pause state stay unchanged.
An event still plays when the advert is paused.

A new dispatch replaces the current event and starts the new video from its first frame.
The advert stays at its original position until the event ends or you cancel it.
Game events never enter automatic advert rotation or the queue.
The existing Power failure, Toxic leak, Lockdown, and round controls remain separate text notices.

### Import your own clips

The phone interface imports MP4, MOV, WebM, and MKV files up to 40 MB.
The converter uses the first 30 seconds and removes audio.
It preserves the source aspect ratio with black borders where needed.
It creates an 8 FPS, 160x120 badge version and a 640x480 browser version.
The uploaded source file is removed after conversion.
Import only media that you own or have permission to use.

New clips appear after conversion finishes.
The server converts one upload at a time.
It does not stop the current broadcast during an import.

## Private configuration

The first start creates `data/config.json` with a controller code and a separate badge token.
Do not commit or share this file.
The repository ignores `data/`, Wi-Fi secrets, and local badge configuration.

Controller sessions use HTTP-only, same-site cookies.
Device requests use a separate bearer token.
Pairing attempts have a rate limit, and the server checks request hosts and origins.
Uploaded videos use fixed decoder formats and cannot select arbitrary network protocols.

**Use a trusted local network.**
The initial local setup uses HTTP, not HTTPS.
Someone who can observe that network traffic can observe credentials and media.
Do not expose port 8787 to the internet.
The hosted foundation uses strict HTTPS and separate badge credentials.
The local bearer token never becomes a hosted credential.

Pairing sessions expire after seven days or a server restart.
The controller code and badge token survive a restart.
Round, queue, clip selection, and pause state also survive a restart.
Temporary events do not replay after a restart.

## Badge installation

The app targets the colour Universe 2025 / Tufty Badger 2350 with MonaOS.
It does not target the older e-ink badge.
See `badge/README.md` for the client, supported firmware APIs, and network setup.

The installer backs up the USB-visible files before it changes the app or menu.
It does not flash firmware or replace `main.py`.
The menu retains the six original apps and puts the billboard on another page.
HOME retains its original return-to-menu behaviour.

The badge uses its battery during wireless play.
USB is needed for installation and charging, not for frame delivery.
Wi-Fi must use a network supported by the badge's 2.4 GHz radio.
The Mac and phone can use another band on the same reachable local network.
The physical badge now receives and shows the adverts over Wi-Fi.
It uses compressed PNG frames in a 64 KiB RAM filesystem, not flash downloads.

### Pair from the badge

After Wi-Fi connects and the badge reaches the Mac, its first authenticated frame shows
**WI-FI CONNECTED**, the Mac's numeric address and port, and a large six-digit pairing code.
On a phone on the same reachable network, open the displayed `http://` address and enter the code.
The card stays visible until a phone pairs successfully; it is not a timed splash.
If a controller already has a valid paired session, a connecting badge goes straight to playback.

Pairing automatically releases every waiting badge into the current broadcast.
The card does not pause or replace the programme, change its queue/repeat settings, or dispatch an event.
It appears even when the programme is paused; afterwards, the normal pause state applies,
including game-event videos playing over a paused advert.
Logging out does not interrupt badges already playing.
A new badge, or one reconnecting after eight seconds without a frame request, asks for pairing
again only when no unexpired controller sessions remain.

The address comes from the Mac's side of that badge's connection, not an unrelated network interface
or a supplied Host header, and retains the configured server port.
An IPv6-only connection without an IPv4 address reports an explicit error; use the Mac's LAN IPv4 address.
The card is delivered only through the bearer-authenticated badge frame endpoint, entirely in RAM.
It is never the phone preview or a media asset, and the code is not included in setup or state responses.
Device state reports `awaitingPairing` without publishing the code.

## Playback behaviour

The server owns the current clip and playback position.
The badge requests the current frame rather than a backlog of old frames.
Slow clients therefore drop frames instead of accumulating delay.
The nominal output rate is 8 FPS; the actual badge rate depends on its firmware and network.

Queue entries take priority when the current clip finishes.
With repeat enabled, the selected clip repeats after any queued entries.
Otherwise, playback advances through the library, except for clips in the `event` category.
A text notice overlays the programme for its selected duration.
The programme's timeline continues underneath a text notice.
A game-event video freezes the programme's position until it ends or you cancel it.
Replacing a game video with a text or round notice resumes the programme's timeline immediately.
Explicit play, next, previous, or replay commands cancel a game video.
The physical badge buttons retain those commands.
A pause command during a game video changes the programme's pause state, not the video.
The controller disables those transport controls during game videos to avoid accidental changes.

## HTTP interface

The local Mac station keeps the interface below.

| Endpoint | Purpose | Authentication |
|---|---|---|
| `GET /api/setup` | Check whether this controller is paired | None |
| `POST /api/pair` | Pair with `{ "pin": "123456" }` | Pairing code |
| `POST /api/logout` | Remove this controller session | Controller cookie |
| `GET /api/state` | Library, playback, and device status | Controller cookie |
| `POST /api/command` | Play, replay, pause, queue, round, or event | Controller cookie |
| `GET /api/frame.png` | Current server output as a PNG | Controller cookie |
| `POST /api/library` | Import multipart `file` and optional `title` | Controller cookie |
| `GET /api/badge/frame` | Current binary frame | Badge bearer token |
| `POST /api/badge/control` | Physical button playback commands | Badge bearer token |

Each command needs a unique `requestId` of 8-100 characters.
Reusing that ID with the same command is safe for network retries.
Reusing it with a different command fails.
The server retains recent IDs for up to ten minutes, with a limit of 1,000 entries.

Dispatch a game event with this command:

```json
{ "action": "game-event", "eventId": "failed-jump", "requestId": "game-event-0001" }
```

The other preset IDs are `fatality`, `dice-fail`, `critical-hit`, `ammo-jam`, and `bottled-it`.
Use a new request ID to dispatch the same event again from its first frame.
Use `clear-event` to stop the current game video or text notice.
Game videos need their generated assets. The server reports an error if a preset video is unavailable.
Temporary events do not survive a restart; the saved advert resumes without replaying the event.

The binary frame begins with a 20-byte little-endian `UBF1` header.
Its fields are magic, width, height, format, flags, nominal FPS, frame ID, and payload length.
The corresponding Python format is `<4sHHBBHII`.
Format 1 is RGBA8888, format 2 is little-endian RGB565, format 3 is RGB332, and format 4 is PNG.
The installed badge requests `format=png`.
Flag bit 0 marks paused playback. It stays clear while a game video plays over a paused programme.
The device reports a rendered frame through `X-Badge-Frame` on its next request.
It can report measured speed through `X-Badge-Fps`.

### Hosted device sync

| Endpoint | Purpose | Authentication |
|---|---|---|
| `POST /api/device/sync` | Record presence and a receipt, then return claim or playback state | `Badge` authorization header |

The service applies a durable limit of 180 sync requests for each badge in two minutes.
The request body uses this shape:

```json
{
  "protocol": 2,
  "bootId": "boot-id-1234",
  "firmwareVersion": "2.0.0",
  "knownStationRevision": 12,
  "lastReceipt": {
    "stationRevision": 12,
    "commandSeq": 8,
    "playbackGeneration": 4,
    "frameId": 257
  },
  "fps": 7.8,
  "errorCode": null
}
```

The server accepts only an immutable catalog URL under `content/v1/<sha256>/catalog.json`.
All poster, preview, and frame paths must stay under that catalog directory and the allowlisted Blob root.
The sync response never contains a badge secret, claim-code HMAC, controller token, or Blob write token.

## Checks

GitHub Actions runs `.github/workflows/ci.yml` on pushes, pull requests, and manual runs.
The job uses GitHub's `ubuntu-24.04-arm` runner with ARM64 Node.js 24 and Python 3.12.
It runs lint, server and artwork tests, badge and setup tests, the production build, and desktop/phone browser tests.
The job generates its own sample frames and installs Chromium. It needs no badge, Wi-Fi credentials, or repository secrets.

```sh
npm test
npm run build
npm run lint
npm run content:hosted
npm run content:upload:check
python3 -m unittest discover -s device -p 'test_*.py'
python3 -m unittest discover -s badge/tests -p 'test_*.py'
npm run test:ui
```

The Node suite covers commands, pause/replay, queue behaviour, authentication, frame encoding, previews, and real FFmpeg conversion.
The Python menu suite covers pagination and access to the original apps.
The badge suite covers frame parsing, RAM storage, connection feedback, and transport recovery.
The browser suite covers desktop and phone controls with independent video previews.
Desktop results do not establish physical badge performance.

## Hardware references

- [Badger hardware page](https://badger.github.io/about-badge/)
- [Official badge apps and documentation](https://github.com/badger/home)
- [MonaOS image API](https://github.com/badger/home/blob/main/badgerware/Image.md)

The hardware page and the repository disagree on some specifications.
Use the actual device and its installed firmware when setting memory and performance limits.
