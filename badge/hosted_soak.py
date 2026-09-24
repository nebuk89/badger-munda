#!/usr/bin/env python3
"""Deterministic hosted-client soak test that needs no badge hardware."""

import argparse
import gc
import json
import pathlib
import sys
import tracemalloc
import types

APP = pathlib.Path(__file__).resolve().parent / "apps" / "underhive"
sys.path.insert(0, str(APP))

from hosted_client import HostedClient
from hosted_protocol import HostedProtocolError
from hosted_transport import HostedTransportError

ORIGIN = "https://badger-munda.vercel.app"
BADGE_ID = "11111111-1111-4111-8111-111111111111"
BADGE_SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678"


class Sink:
    def __init__(self):
        self.aborts = 0
        self.commits = 0

    def abort(self):
        self.aborts += 1

    def close(self):
        pass


class Clock:
    def __init__(self):
        self.current = 1_790_265_600.0
        self.time = types.SimpleNamespace(time=lambda: self.current)

    def observe(self, _seconds):
        pass


class SoakClient(HostedClient):
    def __init__(self, sink, clock, claims):
        super().__init__(
            sink,
            {
                "schema": 1,
                "mode": "hosted",
                "serviceOrigin": ORIGIN,
                "badgeId": BADGE_ID,
                "badgeSecret": BADGE_SECRET,
            },
            clock,
            object(),
            object(),
            lambda a, b: a - b,
            lambda a, b: a + b,
            "soak-boot-id",
            "MonaOS-4.03",
            claim_handler=claims.append,
        )
        self.sync_count = 0
        self.switches = 0
        self.pauses = 0
        self.backoffs = 0
        self.protocol_failures = 0
        self.network_failures = 0

    def _sync(self, now):
        self.sync_count += 1
        if self.sync_count == 1:
            self.claim = {
                "code": "123456",
                "expiresAtMs": int(self.clock.time.time() * 1000) + 2000,
            }
            self.claim_handler(self.claim)
            self.status = "Badge not claimed"
            self.sync_due = self.add(now, 5000)
            return
        if self.sync_count % 29 == 0:
            self.backoffs += 1
            raise HostedTransportError(
                "HTTPS request rejected", status=429, retry_after_ms=3000
            )
        if self.sync_count % 31 == 0:
            self.protocol_failures += 1
            raise HostedProtocolError("stale station revision")
        if self.sync_count % 37 == 0:
            self.network_failures += 1
            raise OSError("offline")
        revision = self.sync_count - 1
        clip_id = "event-clip" if revision % 13 in (0, 1) else "main-clip"
        paused = revision % 17 == 0
        if paused:
            self.pauses += 1
        if self.plan is not None and self.plan["clip"]["id"] != clip_id:
            self.switches += 1
            self.catalog = None
            self.last_frame_index = None
        self.plan = {
            "stationRevision": revision,
            "commandSeq": revision,
            "playbackGeneration": revision,
            "paused": paused,
            "clip": {
                "id": clip_id,
                "startedAtMs": int(self.clock.time.time() * 1000),
                "positionMs": revision % 8000,
                "durationMs": 8000,
                "fps": 8,
                "frameCount": 64,
            },
        }
        self.last_revision = revision
        self.catalog = None if self.catalog is None else self.catalog
        self.sync_due = self.add(now, 1000)
        self.status = "Syncing hosted content"

    def _load_catalog(self):
        self.catalog = {"frameIds": tuple(range(1, 65))}
        self.status = "Hosted content ready"

    def _load_frame(self, index):
        frame_id = self.catalog["frameIds"][index]
        self.pending = {
            "stationRevision": self.plan["stationRevision"],
            "commandSeq": self.plan["commandSeq"],
            "playbackGeneration": self.plan["playbackGeneration"],
            "frameId": frame_id,
        }
        self.last_frame_index = index
        self.status = "Paused" if self.plan["paused"] else "Live"


def run(cycles, max_growth):
    sink = Sink()
    clock = Clock()
    claims = []
    client = SoakClient(sink, clock, claims)
    wifi_losses = 0
    tracemalloc.start()
    for cycle in range(cycles):
        now = cycle * 125
        clock.current = 1_790_265_600.0 + now / 1000
        connected = cycle % 401 not in range(20)
        if not connected:
            wifi_losses += 1
        client.confirm_presented(now)
        client.update(now, connected)
        if cycle == 1000:
            gc.collect()
            baseline, _peak = tracemalloc.get_traced_memory()
    gc.collect()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    growth = current - baseline
    report = json.loads(client._report())
    client.close()
    checks = {
        "claim_shown": bool(claims and claims[0]["code"] == "123456"),
        "claim_cleared": None in claims,
        "receipt_bounded": set(report.get("lastReceipt", ())) == {
            "stationRevision", "commandSeq", "playbackGeneration", "frameId",
        },
        "clip_switches": client.switches > 0,
        "paused_states": client.pauses > 0,
        "server_backoffs": client.backoffs > 0,
        "protocol_failures": client.protocol_failures > 0,
        "network_failures": client.network_failures > 0,
        "wifi_losses": wifi_losses > 0,
        "cleanup": client.closed and client.pending is None and sink.aborts > 0,
        "memory_growth": growth <= max_growth,
    }
    result = {
        "cycles": cycles,
        "syncs": client.sync_count,
        "switches": client.switches,
        "wifiLossCycles": wifi_losses,
        "memoryGrowthBytes": growth,
        "peakBytes": peak,
        "checks": checks,
    }
    print(json.dumps(result, sort_keys=True))
    if not all(checks.values()):
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=20000)
    parser.add_argument("--max-growth", type=int, default=262144)
    args = parser.parse_args()
    if not 1001 <= args.cycles <= 1_000_000:
        parser.error("--cycles must be between 1001 and 1000000")
    if not 0 <= args.max_growth <= 16 * 1024 * 1024:
        parser.error("--max-growth must be between 0 and 16777216")
    run(args.cycles, args.max_growth)


if __name__ == "__main__":
    main()
