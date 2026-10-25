"""Conservative archive-space estimates using recent completed recordings."""
from __future__ import annotations

import math
import sqlite3
import threading
import time

from .config import MAX_SEGMENT_SECONDS
from .storage_policy import archive_storage_status


SAMPLE_WINDOW_SECONDS = 86400
MAX_CAMERAS = 256
MAX_ESTIMATED_CAMERAS = 32
MAX_RECORDING_SECONDS = MAX_SEGMENT_SECONDS + 60
MAX_RECORDING_BYTES = 4 * 1024**4


class RecordingCapacity:
    def __init__(self, settings, store, media, *, wall_time=time.time, monotonic=time.monotonic):
        self.settings, self.store, self.media = settings, store, media
        self._wall_time, self._monotonic = wall_time, monotonic
        self._lock = threading.Lock()
        self._rates = {}
        self._active_ids = None
        self._sample_time = None
        self._sample_wall = None

    @staticmethod
    def _finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def invalidate(self):
        """Discard rates after explicit archive deletion."""
        with self._lock:
            self._rates = {}
            self._active_ids = self._sample_time = self._sample_wall = None

    def _rate(self, db, camera_id, now):
        rows = db.execute("""SELECT size,duration,started_at FROM recordings
            WHERE camera_id=? AND started_at>=? AND started_at<=?
            AND typeof(started_at) IN ('integer','real')
            AND typeof(size) IN ('integer','real') AND size>0 AND size<=?
            AND typeof(duration) IN ('integer','real') AND duration>=1 AND duration<=?
            ORDER BY started_at DESC LIMIT 3""",
            (camera_id, now - SAMPLE_WINDOW_SECONDS - MAX_RECORDING_SECONDS, now,
             MAX_RECORDING_BYTES, MAX_RECORDING_SECONDS)).fetchall()
        sizes = seconds = 0.0
        for row in rows:
            size, duration, started = row["size"], row["duration"], row["started_at"]
            if (not all(self._finite(value) for value in (size, duration, started)) or size <= 0 or size > MAX_RECORDING_BYTES
                    or not 1 <= duration <= MAX_RECORDING_SECONDS or started < 0):
                continue
            end = started + duration
            if end < now - SAMPLE_WINDOW_SECONDS or end > now + 60:
                continue
            sizes += size; seconds += duration
        return sizes / seconds if seconds > 0 else None

    def snapshot(self, disk):
        with self._lock:
            archive = disk.get("recordings") if isinstance(disk, dict) else None
            reserve = archive_storage_status(archive)["reserve_bytes"]
            free = archive.get("free") if isinstance(archive, dict) else None
            usable = max(0, int(free) - reserve) if reserve is not None else None
            result = {"active_cameras": 0, "estimated_cameras": 0, "bytes_per_second": None, "bytes_per_day": None,
                      "usable_free_bytes": usable, "reserve_bytes": reserve, "remaining_seconds": None,
                      "reason": "insufficient_data", "method": "recent_recordings",
                      "sample_window_seconds": SAMPLE_WINDOW_SECONDS, "retention_limited": False}
            try:
                with self.store.connect() as db:
                    cameras = db.execute("SELECT id,retention_days FROM cameras WHERE enabled=1 LIMIT ?", (MAX_CAMERAS + 1,)).fetchall()
                    if len(cameras) > MAX_CAMERAS:
                        result.update(active_cameras=None, reason="unsupported_capacity")
                        return result
                    active = []
                    for camera in cameras:
                        status = self.media.camera_status(camera["id"])
                        if not isinstance(status, dict):
                            return result
                        if status.get("state") == "recording":
                            active.append(camera)
                    result["active_cameras"] = len(active)
                    identities = tuple(sorted(camera["id"] for camera in active))
                    if identities != self._active_ids:
                        # An off/on transition must invalidate the previous rates
                        # even when both observations occur inside the 30s cache.
                        self._rates = {}
                        self._active_ids, self._sample_time, self._sample_wall = identities, None, None
                    if not active:
                        result.update(bytes_per_second=0.0, bytes_per_day=0.0, reason="no_active_recordings")
                        return result
                    if len(active) > MAX_ESTIMATED_CAMERAS:
                        return result
                    now, monotonic = self._wall_time(), self._monotonic()
                    if (self._sample_time is None or not 0 <= monotonic - self._sample_time < 30
                            or self._sample_wall is not None and now < self._sample_wall):
                        self._rates = {identity: self._rate(db, identity, now) for identity in identities}
                        self._active_ids, self._sample_time, self._sample_wall = identities, monotonic, now
                    rates = [self._rates.get(identity) for identity in identities]
                    result["estimated_cameras"] = sum(rate is not None for rate in rates)
                    if any(rate is None for rate in rates):
                        return result
                    rate = sum(rates)
                    if not math.isfinite(rate) or rate <= 0:
                        return result
                    result.update(bytes_per_second=round(rate, 3), bytes_per_day=round(rate * 86400, 1))
                    if usable is None:
                        result["reason"] = "disk_unavailable"
                        return result
                    remaining = usable / rate
                    result.update(remaining_seconds=round(remaining, 1), reason="storage_reserve_reached" if usable == 0 else None,
                                  retention_limited=any(self._finite(camera["retention_days"]) and camera["retention_days"] > 0 for camera in active))
            except (sqlite3.Error, OSError, KeyError, AttributeError, RuntimeError, TypeError, ValueError):
                result.update(reason="insufficient_data", remaining_seconds=None)
            return result
