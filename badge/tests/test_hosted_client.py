import hashlib
import io
import json
import pathlib
import struct
import sys
import types
import unittest

APP = pathlib.Path(__file__).resolve().parents[1] / "apps/underhive"
sys.path.insert(0, str(APP))

from hosted_client import HostedClient
from hosted_protocol import (
    HostedProtocolError, parse_catalog, parse_sync_json, validate_frame_template,
)
from hosted_transport import HostedTransportError
from protocol import validate_config

ORIGIN = "https://badger-munda.vercel.app"
BLOB = "https://underhive.public.blob.vercel-storage.com"
BADGE_ID = "11111111-1111-4111-8111-111111111111"
BADGE_SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678"


def hosted_state():
    return {
        "schema": 1,
        "mode": "hosted",
        "serviceOrigin": ORIGIN,
        "badgeId": BADGE_ID,
        "badgeSecret": BADGE_SECRET,
    }


def clip_value(**overrides):
    value = {
        "id": "clip-one",
        "title": "Clip one",
        "subtitle": "Test signal",
        "category": "advert",
        "duration": 8,
        "fps": 8,
        "frameCount": 2,
        "width": 160,
        "height": 120,
        "accent": "#ffffff",
        "posterUrl": "clips/clip-one/poster.png",
        "videoUrl": "clips/clip-one/video.mp4",
        "frameIds": [1, 2],
        "framePaths": [
            "clips/clip-one/frames/0000.ubf",
            "clips/clip-one/frames/0001.ubf",
        ],
        "frameHashes": ["b" * 64, "c" * 64],
        "posterPath": "clips/clip-one/poster.png",
        "posterHash": "d" * 64,
        "videoPath": "clips/clip-one/video.mp4",
        "videoHash": "e" * 64,
    }
    value.update(overrides)
    return value


def catalog_bytes(clip=None):
    stable = {"version": 1, "clips": [clip or clip_value()]}
    compact = json.dumps(stable, separators=(",", ":")).encode()
    catalog_hash = hashlib.sha256(compact).hexdigest()
    value = dict(stable, catalogHash=catalog_hash)
    return (json.dumps(value, indent=2) + "\n").encode(), catalog_hash


def sync_value(revision=1, protocol=2, template=None):
    content_hash = "a" * 64
    return {
        "protocol": protocol,
        "mode": "play",
        "serverTimeMs": 1_790_265_600_000,
        "syncAfterMs": 1000,
        "stationRevision": revision,
        "commandSeq": revision,
        "playbackGeneration": revision,
        "contentVersion": content_hash,
        "paused": False,
        "clip": {
            "id": "clip-one",
            "startedAtMs": 1_790_265_600_000,
            "positionMs": 0,
            "durationMs": 8000,
            "fps": 8,
            "frameCount": 2,
            "frameNumberWidth": 4,
            "frameUrlTemplate": template or (
                BLOB + "/content/v1/" + content_hash
                + "/clips/clip-one/frames/{frame}.ubf"
            ),
        },
    }


class FakeBody:
    def __init__(self, data, length=None, fragment=4096):
        self.data = bytearray(data)
        self.length = len(data) if length is None else length
        self.fragment = fragment
        self.closed = False

    def read(self, count=4096):
        count = min(count, self.fragment, len(self.data))
        result = bytes(self.data[:count])
        del self.data[:count]
        return result

    def finish(self):
        if self.data:
            raise HostedTransportError("body remains")

    def close(self):
        self.closed = True


class FakeSink:
    format_code = 4
    format_name = "png"

    def __init__(self):
        self.data = bytearray()
        self.commits = 0
        self.aborts = 0

    def begin(self, length):
        self.length = length
        self.data.clear()

    def write(self, data):
        self.data.extend(data)

    def commit(self):
        self.commits += 1

    def abort(self):
        self.aborts += 1


class FakeClock:
    def __init__(self):
        self.values = []
        self.current = 1_790_265_600
        self.time = types.SimpleNamespace(time=lambda: self.current)

    def bootstrap(self):
        return 1_790_265_600

    def observe(self, seconds):
        self.values.append(seconds)


def client():
    return HostedClient(
        FakeSink(), hosted_state(), FakeClock(), object(), object(),
        lambda a, b: a - b, lambda a, b: a + b,
        "boot-id-1234", "MonaOS-4.03",
    )


class SyncProtocolTests(unittest.TestCase):
    def test_sync_parser_rejects_protocol_mismatch_and_malformed_shapes(self):
        with self.assertRaisesRegex(HostedProtocolError, "unsupported"):
            parse_sync_json(json.dumps(sync_value(protocol=3)).encode())
        malformed = sync_value()
        malformed["clip"]["frameCount"] = 0
        with self.assertRaises(HostedProtocolError):
            parse_sync_json(json.dumps(malformed).encode())
        oversized = sync_value()
        oversized["clip"]["frameCount"] = 257
        with self.assertRaisesRegex(HostedProtocolError, "frame count"):
            parse_sync_json(json.dumps(oversized).encode())

    def test_claim_response_is_validated_for_a_later_display_layer(self):
        result = parse_sync_json(json.dumps({
            "protocol": 2,
            "mode": "claim",
            "serverTimeMs": 1_790_265_600_000,
            "syncAfterMs": 3000,
            "claimCode": "123456",
            "claimExpiresAtMs": 1_790_266_200_000,
        }).encode())
        self.assertEqual(result["mode"], "claim")
        self.assertEqual(result["claimCode"], "123456")
        self.assertEqual(result["claimExpiresAtMs"], 1_790_266_200_000)

    def test_blob_origin_and_immutable_template_are_restricted(self):
        value = sync_value()
        location = validate_frame_template(
            value["clip"]["frameUrlTemplate"],
            value["contentVersion"],
            value["clip"]["id"],
        )
        self.assertEqual(
            location["catalogUrl"],
            BLOB + "/content/v1/" + value["contentVersion"] + "/catalog.json",
        )
        for template in (
            value["clip"]["frameUrlTemplate"].replace(BLOB, "https://attacker.example"),
            value["clip"]["frameUrlTemplate"].replace(
                "underhive.public.blob.vercel-storage.com",
                "underhive.public.blob.vercel-storage.com.attacker.example",
            ),
            value["clip"]["frameUrlTemplate"].replace("/content/v1/", "/mutable/"),
        ):
            with self.subTest(template=template), self.assertRaises(HostedProtocolError):
                validate_frame_template(
                    template, value["contentVersion"], value["clip"]["id"]
                )


class CatalogTests(unittest.TestCase):
    def test_streaming_catalog_retains_only_active_clip_metadata(self):
        data, catalog_hash = catalog_bytes()
        parsed = parse_catalog(io.BytesIO(data), catalog_hash, "clip-one")
        self.assertEqual(parsed["durationMs"], 8000)
        self.assertEqual(parsed["frameIds"], [1, 2])
        self.assertEqual(parsed["frameHashes"], ["b" * 64, "c" * 64])
        self.assertNotIn("title", parsed)
        self.assertLess(parsed.__sizeof__(), len(data))

    def test_catalog_rejects_identity_hash_paths_and_frame_ids(self):
        data, catalog_hash = catalog_bytes()
        with self.assertRaisesRegex(HostedProtocolError, "hash mismatch"):
            parse_catalog(io.BytesIO(data), "f" * 64, "clip-one")
        bad_path, bad_path_hash = catalog_bytes(clip_value(
            framePaths=[
                "clips/clip-one/frames/0001.ubf",
                "clips/clip-one/frames/0000.ubf",
            ],
        ))
        with self.assertRaisesRegex(HostedProtocolError, "frame path"):
            parse_catalog(io.BytesIO(bad_path), bad_path_hash, "clip-one")
        bad_ids, bad_ids_hash = catalog_bytes(clip_value(frameIds=[2, 1]))
        with self.assertRaisesRegex(HostedProtocolError, "not unique"):
            parse_catalog(io.BytesIO(bad_ids), bad_ids_hash, "clip-one")


class HostedPlaybackTests(unittest.TestCase):
    def test_stale_revision_is_rejected_without_replacing_live_state(self):
        hosted = client()
        responses = [
            json.dumps(sync_value(revision=3)).encode(),
            json.dumps(sync_value(revision=2)).encode(),
        ]
        hosted._service_response = lambda body: FakeBody(responses.pop(0), fragment=17)
        hosted._sync(0)
        self.assertEqual(hosted.last_revision, 3)
        with self.assertRaisesRegex(HostedProtocolError, "stale"):
            hosted._sync(1000)
        self.assertEqual(hosted.last_revision, 3)

    def test_same_revision_accepts_fresh_server_timing(self):
        hosted = client()
        first = sync_value(revision=3)
        second = sync_value(revision=3)
        second["serverTimeMs"] += 1000
        second["clip"]["startedAtMs"] += 2
        second["clip"]["positionMs"] += 998
        responses = [json.dumps(first).encode(), json.dumps(second).encode()]
        hosted._service_response = lambda body: FakeBody(responses.pop(0))
        hosted._sync(0)
        hosted._sync(1000)
        self.assertEqual(
            hosted.plan["clip"]["positionMs"],
            second["clip"]["positionMs"],
        )

    def test_transport_failures_use_bounded_backoff(self):
        hosted = client()
        calls = []

        def fail(now):
            calls.append(now)
            raise HostedTransportError("offline")

        hosted._sync = fail
        hosted.update(0)
        self.assertEqual(hosted.due, 1000)
        self.assertEqual(hosted.status, "Hosted station offline")
        hosted.update(999)
        self.assertEqual(calls, [0])
        hosted.update(1000)
        self.assertEqual(calls, [0, 1000])
        self.assertEqual(hosted.due, 3000)

    def test_frame_download_checks_id_length_hash_and_commits_once(self):
        hosted = client()
        payload = b"x" * 57
        header = struct.pack("<4sHHBBHII", b"UBF1", 160, 120, 4, 0, 8, 7, len(payload))
        wire = header + payload
        hosted.location = {
            "origin": BLOB,
            "host": "underhive.public.blob.vercel-storage.com",
            "root": BLOB + "/content/v1/" + "a" * 64 + "/",
            "template": BLOB + "/content/v1/" + "a" * 64
                        + "/clips/clip-one/frames/{frame}.ubf",
        }
        hosted.plan = sync_value()
        hosted.catalog = {
            "fps": 8,
            "frameIds": [7, 8],
            "frameHashes": [hashlib.sha256(wire).hexdigest(), "f" * 64],
        }
        response = FakeBody(wire, fragment=13)
        hosted._blob_response = lambda url, maximum: response
        hosted._load_frame(0)
        self.assertEqual(hosted.sink.commits, 1)
        self.assertEqual(hosted.pending, {
            "stationRevision": 1,
            "commandSeq": 1,
            "playbackGeneration": 1,
            "frameId": 7,
        })
        self.assertTrue(response.closed)

        hosted._blob_response = lambda url, maximum: FakeBody(
            wire, length=len(wire) + 1
        )
        with self.assertRaisesRegex(HostedProtocolError, "metadata"):
            hosted._load_frame(0)
        self.assertGreaterEqual(hosted.sink.aborts, 1)

    def test_presented_frame_adds_one_bounded_receipt_to_later_syncs(self):
        hosted = client()
        hosted.last_revision = 12
        hosted.pending = {
            "stationRevision": 12,
            "commandSeq": 8,
            "playbackGeneration": 4,
            "frameId": 257,
        }
        hosted.confirm_presented(2000)
        report = json.loads(hosted._report())
        self.assertEqual(report, {
            "protocol": 2,
            "bootId": "boot-id-1234",
            "firmwareVersion": "MonaOS-4.03",
            "knownStationRevision": 12,
            "lastReceipt": {
                "stationRevision": 12,
                "commandSeq": 8,
                "playbackGeneration": 4,
                "frameId": 257,
            },
            "fps": 0.0,
            "errorCode": None,
        })
        self.assertLess(len(hosted._report()), 512)

    def test_claim_expiry_clears_the_code_and_requests_a_fresh_sync(self):
        claims = []
        hosted = HostedClient(
            FakeSink(), hosted_state(), FakeClock(), object(), object(),
            lambda a, b: a - b, lambda a, b: a + b,
            "boot-id-1234", "MonaOS-4.03", claim_handler=claims.append,
        )
        value = {
            "protocol": 2,
            "mode": "claim",
            "serverTimeMs": 1_790_265_600_000,
            "syncAfterMs": 3000,
            "claimCode": "123456",
            "claimExpiresAtMs": 1_790_265_605_000,
        }
        hosted._service_response = lambda body: FakeBody(json.dumps(value).encode())
        hosted._sync(0)
        self.assertEqual(hosted.claim_seconds(), 5)
        self.assertEqual(claims[-1]["code"], "123456")
        hosted.clock.current += 5
        hosted._service_response = lambda body: (_ for _ in ()).throw(
            HostedTransportError("offline")
        )
        hosted.update(5000)
        self.assertIsNone(hosted.claim)
        self.assertIsNone(claims[-1])
        self.assertEqual(hosted.error_code, "network_failed")

    def test_wifi_loss_keeps_the_last_frame_and_reports_a_stable_error(self):
        hosted = client()
        hosted.last_applied = 44
        hosted.update(1000, connected=False)
        self.assertEqual(hosted.last_applied, 44)
        self.assertEqual(hosted.status, "Waiting for Wi-Fi")
        self.assertEqual(hosted.error_code, "wifi_unavailable")

    def test_server_retry_after_and_auth_failures_override_fast_retries(self):
        hosted = client()
        hosted._fail(
            1000,
            HostedTransportError(
                "HTTPS request rejected", status=429, retry_after_ms=17000
            ),
        )
        self.assertEqual(hosted.error_code, "server_backoff")
        self.assertEqual(hosted.due, 18000)
        self.assertEqual(hosted.retry_seconds(2000), 16)
        hosted._fail(
            20000,
            HostedTransportError("HTTPS request rejected", status=401),
        )
        self.assertEqual(hosted.error_code, "auth_failed")
        self.assertEqual(hosted.due, 50000)

    def test_paused_timing_and_clip_switch_reset_only_clip_specific_state(self):
        hosted = client()
        paused = sync_value(revision=3)
        paused["paused"] = True
        paused["clip"]["positionMs"] = 1375
        hosted.plan = paused
        self.assertEqual(hosted._frame_index(), 1)
        hosted.catalog = {"old": True}
        hosted.last_frame_index = 1
        event = sync_value(revision=4)
        event["commandSeq"] = 4
        event["playbackGeneration"] = 4
        event["clip"]["id"] = "event-clip"
        event["clip"]["frameUrlTemplate"] = (
            BLOB + "/content/v1/" + event["contentVersion"]
            + "/clips/event-clip/frames/{frame}.ubf"
        )
        hosted._service_response = lambda body: FakeBody(json.dumps(event).encode())
        hosted.last_revision = 3
        hosted.last_signature = (
            3, 3, paused["contentVersion"], paused["clip"]["id"],
            paused["paused"], paused["clip"]["durationMs"],
            paused["clip"]["fps"], paused["clip"]["frameCount"],
        )
        hosted._sync(2000)
        self.assertEqual(hosted.plan["clip"]["id"], "event-clip")
        self.assertIsNone(hosted.catalog)
        self.assertIsNone(hosted.last_frame_index)
        self.assertEqual(hosted.last_revision, 4)

    def test_close_clears_claim_pending_work_and_aborts_the_sink(self):
        claims = []
        hosted = HostedClient(
            FakeSink(), hosted_state(), FakeClock(), object(), object(),
            lambda a, b: a - b, lambda a, b: a + b,
            "boot-id-1234", "MonaOS-4.03", claim_handler=claims.append,
        )
        hosted.claim = {"code": "123456", "expiresAtMs": 1_790_265_605_000}
        hosted.pending = {"frameId": 9}
        hosted.close()
        self.assertTrue(hosted.closed)
        self.assertIsNone(hosted.claim)
        self.assertIsNone(hosted.pending)
        self.assertIsNone(claims[-1])
        self.assertGreaterEqual(hosted.sink.aborts, 1)

    def test_local_transport_configuration_remains_accepted(self):
        self.assertEqual(
            validate_config(
                "http://192.168.1.2:8787", "x" * 32, "desk-badge"
            )[:2],
            ("192.168.1.2", 8787),
        )


if __name__ == "__main__":
    unittest.main()
