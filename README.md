# Underhive Broadcast

A local television station for a GitHub Badger 2350 and a phone.
The Mac serves the content over Wi-Fi. The phone controls playback and previews videos independently.

## What it does

- Plays three original animated adverts, plus videos you import.
- Provides phone controls for play, replay, pause, queue, and repeat.
- Shows temporary round and event broadcasts over the current programme.
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

## Content

`npm run content` creates the original Ration Works, Curfew Signal, and Sump Tavern adverts.
Each advert has browser video, a poster, and raw badge frames.
The generator preserves existing complete clips.

### Downloadable samples

The repository includes the three original adverts as ready-to-use MP4s with PNG posters.
Each video is silent, eight seconds long, and 640x480 at 8 FPS.

| Advert | Video | Poster |
|---|---|---|
| Ration Works | [MP4](samples/ration-works/video.mp4) | [PNG](samples/ration-works/poster.png) |
| Curfew Signal | [MP4](samples/curfew-signal/video.mp4) | [PNG](samples/curfew-signal/poster.png) |
| Sump Tavern | [MP4](samples/sump-tavern/video.mp4) | [PNG](samples/sump-tavern/poster.png) |

Download an MP4 from its GitHub file page to use it elsewhere.
To import one into a station, select **Upload clip** in the controller.
Select the downloaded MP4, then select **Import clip**.
The clip stays off air until you select **Play on badge**.

For this station's complete starter pack, run `npm run content`.
That command creates the individual 160x120 PNG and RGBA frames under `data/library/`.
An eight-second advert has 64 frames at 8 FPS.
These files are a rebuildable frame cache, separate from the sample MP4s.
The repository excludes the cache, private settings, and device backups.

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
A public deployment needs HTTPS and a separate deployment design.

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

## Playback behaviour

The server owns the current clip and playback position.
The badge requests the current frame rather than a backlog of old frames.
Slow clients therefore drop frames instead of accumulating delay.
The nominal output rate is 8 FPS; the actual badge rate depends on its firmware and network.

Queue entries take priority when the current clip finishes.
With repeat enabled, the selected clip repeats after any queued entries.
Otherwise, playback advances through the library.
An event overlays the programme for its selected duration.
The programme's timeline continues underneath the event.

## HTTP interface

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

The binary frame begins with a 20-byte little-endian `UBF1` header.
Its fields are magic, width, height, format, flags, nominal FPS, frame ID, and payload length.
The corresponding Python format is `<4sHHBBHII`.
Format 1 is RGBA8888, format 2 is little-endian RGB565, format 3 is RGB332, and format 4 is PNG.
The installed badge requests `format=png`.
Flag bit 0 marks paused playback.
The device reports a rendered frame through `X-Badge-Frame` on its next request.
It can report measured speed through `X-Badge-Fps`.

## Checks

```sh
npm test
npm run build
npm run lint
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
