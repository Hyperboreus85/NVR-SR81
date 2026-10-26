"""Small, private, numeric-only telemetry history, independent of web sessions."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import math
import os
from pathlib import Path
import sqlite3
import stat
import threading
import time


INTERVAL_SECONDS = 30
RETENTION_SECONDS = 7 * 86400
MAX_POINTS = RETENTION_SECONDS // INTERVAL_SECONDS + 1
ALLOWED_HOURS = (1, 6, 24, 168)
APPLICATION_ID = 0x4E565248  # NVRH; never adopt an unrelated SQLite database.
SCHEMA_VERSION = 1
PRUNE_BATCH = 2048
SCOPES = {"machine", "container", "unknown"}
TEMPERATURE_SCOPES = {"machine", "host"}


def _number(value, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        if not math.isfinite(value) or minimum is not None and value < minimum or maximum is not None and value > maximum:
            return None
        return float(value)
    except OverflowError:
        return None


class TelemetryHistory:
    def __init__(self, data_dir, collector, *, wall_time=time.time, monotonic=time.monotonic,
                 interval_seconds=INTERVAL_SECONDS):
        interval = _number(interval_seconds, .01, 3600)
        if interval is None:
            raise ValueError("Invalid telemetry sampling interval.")
        self.data_dir = Path(data_dir).resolve()
        self.path = self.data_dir / "system-history.sqlite3"
        self.collector = collector
        self.interval_seconds = interval
        self._wall_time, self._monotonic = wall_time, monotonic
        self._lifecycle_lock, self._sample_lock = asyncio.Lock(), asyncio.Lock()
        self._state_lock = threading.Lock()
        self._token = threading.Event()
        self._wake = asyncio.Event()
        self._task = self._worker = None
        self._sampling_available = None

    @contextmanager
    def _connect(self, *, write=False):
        if write:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            try:
                descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
                os.close(descriptor)
            except FileExistsError:
                pass
        info = self.path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or self.path.is_symlink():
            raise OSError("History storage unavailable")
        database = sqlite3.connect(self.path.as_uri() + ("?mode=rw" if write else "?mode=ro"), uri=True, timeout=.25)
        database.row_factory = sqlite3.Row
        deadline = time.monotonic() + 1
        database.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        try:
            database.execute("PRAGMA busy_timeout=250")
            application_id = database.execute("PRAGMA application_id").fetchone()[0]
            version = database.execute("PRAGMA user_version").fetchone()[0]
            if write and application_id == 0 and not database.execute(
                    "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").fetchone():
                with database:
                    database.execute(f"PRAGMA application_id={APPLICATION_ID}")
                    database.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                    database.execute("""CREATE TABLE samples(
                        sampled_at REAL PRIMARY KEY NOT NULL,
                        cpu_percent REAL, memory_percent REAL, swap_percent REAL, temperature_celsius REAL,
                        scope TEXT NOT NULL, temperature_scope TEXT) WITHOUT ROWID""")
                application_id, version = APPLICATION_ID, SCHEMA_VERSION
            if application_id != APPLICATION_ID or version != SCHEMA_VERSION:
                raise sqlite3.DatabaseError("History storage unavailable")
            if write:
                if database.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
                    raise sqlite3.DatabaseError("History storage unavailable")
                database.execute("PRAGMA synchronous=NORMAL")
            yield database
        finally:
            database.close()

    def _sample_worker(self, token):
        if token.is_set():
            return False
        try:
            snapshot = self.collector.snapshot()
            sampled_at = _number(snapshot.get("sampled_at"), 0, 32503680000)
            if sampled_at is None or token.is_set():
                return False
            def metric(group, key, minimum=0, maximum=100):
                values = snapshot.get(group)
                return _number(values.get(key), minimum, maximum) if isinstance(values, dict) else None
            scope = snapshot.get("scope")
            scope = scope if scope in SCOPES else "unknown"
            cpu = snapshot.get("cpu")
            temperature_scope = cpu.get("temperature_scope") if isinstance(cpu, dict) else None
            temperature_scope = temperature_scope if temperature_scope in TEMPERATURE_SCOPES else None
            values = (sampled_at, metric("cpu", "percent"), metric("memory", "percent"), metric("swap", "percent"),
                      metric("cpu", "temperature_celsius", -50, 150), scope, temperature_scope)
            now = _number(self._wall_time(), 0, 32503680000)
            if now is None:
                return False
            with self._connect(write=True) as database:
                with database:
                    if token.is_set():
                        return False
                    database.execute("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?)", values)
                    database.execute("""DELETE FROM samples WHERE sampled_at IN
                        (SELECT sampled_at FROM samples WHERE sampled_at<? ORDER BY sampled_at LIMIT ?)""",
                        (now - RETENTION_SECONDS, PRUNE_BATCH))
                    database.execute("""DELETE FROM samples WHERE sampled_at IN
                        (SELECT sampled_at FROM samples ORDER BY sampled_at DESC LIMIT ? OFFSET ?)""",
                        (PRUNE_BATCH, MAX_POINTS))
                    if token.is_set():
                        database.rollback()
                        return False
            with self._state_lock:
                self._sampling_available = True
            return True
        except Exception:
            # A full/unavailable disk or collector error must never stop the NVR.
            # Do not retain exception text, paths, identity or arbitrary input.
            with self._state_lock:
                self._sampling_available = False
            return False

    @staticmethod
    async def _finish(task):
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # Cancelling an asyncio.to_thread await does not stop its thread.
            # Wait for bounded I/O to finish before releasing its lifecycle slot.
            await asyncio.shield(task)
            raise

    async def sample_once(self):
        """Attempt one sample; also a deterministic fixture hook without login."""
        if self._token.is_set() or self._sample_lock.locked():
            return False
        async with self._sample_lock:
            token = self._token
            self._worker = asyncio.create_task(asyncio.to_thread(self._sample_worker, token), name="system-history-write")
            try:
                return await self._finish(self._worker)
            finally:
                self._worker = None

    async def _run(self, token):
        due = self._monotonic()
        while not token.is_set():
            await self.sample_once()
            due += self.interval_seconds
            now = self._monotonic()
            if due <= now:
                due = now + self.interval_seconds  # no catch-up or fabricated samples
            try:
                await asyncio.wait_for(self._wake.wait(), max(.001, due - now))
            except asyncio.TimeoutError:
                pass

    async def start(self):
        async with self._lifecycle_lock:
            if self._task is not None and not self._task.done():
                return
            self._token, self._wake = threading.Event(), asyncio.Event()
            self._task = asyncio.create_task(self._run(self._token), name="system-history-sampler")

    async def stop(self):
        async with self._lifecycle_lock:
            self._token.set()
            self._wake.set()
            task, worker = self._task, self._worker
            if task is not None:
                await self._finish(task)
            if worker is not None:
                await self._finish(worker)
            self._task = None

    def read(self, hours=6):
        if type(hours) is not int or hours not in ALLOWED_HOURS:
            raise ValueError("History period must be 1, 6, 24 or 168 hours.")
        now = _number(self._wall_time(), 0, 32503680000)
        with self._state_lock:
            sampling_available = self._sampling_available
        result = {"window_seconds": hours * 3600, "interval_seconds": self.interval_seconds, "points": [],
                  "retention_seconds": RETENTION_SECONDS, "sampled_at": now, "available": False, "reason": "unavailable",
                  "sampling_available": sampling_available, "stale": True, "last_sampled_at": None,
                  "scope": None, "temperature_scope": None, "scopes": [], "temperature_scopes": []}
        if now is None:
            return result
        try:
            with self._connect() as database:
                rows = database.execute("""SELECT sampled_at,cpu_percent,memory_percent,swap_percent,temperature_celsius,
                    scope,temperature_scope FROM samples WHERE sampled_at>=? AND sampled_at<=?
                    ORDER BY sampled_at DESC LIMIT ?""", (now - hours * 3600, now, MAX_POINTS)).fetchall()
            points, scopes, temperature_scopes = [], set(), set()
            for row in reversed(rows):
                sampled_at = _number(row["sampled_at"], 0, 32503680000)
                if sampled_at is None:
                    continue
                points.append({"sampled_at": sampled_at, "cpu_percent": _number(row["cpu_percent"], 0, 100),
                               "memory_percent": _number(row["memory_percent"], 0, 100),
                               "swap_percent": _number(row["swap_percent"], 0, 100),
                               "temperature_celsius": _number(row["temperature_celsius"], -50, 150)})
                scope = row["scope"] if row["scope"] in SCOPES else "unknown"
                temperature_scope = row["temperature_scope"] if row["temperature_scope"] in TEMPERATURE_SCOPES else None
                scopes.add(scope)
                if temperature_scope is not None:
                    temperature_scopes.add(temperature_scope)
                result.update(scope=scope, temperature_scope=temperature_scope)
            latest = points[-1]["sampled_at"] if points else None
            result.update(points=points, available=True, reason=None, last_sampled_at=latest,
                          stale=latest is None or now - latest > max(65, self.interval_seconds * 2 + 5),
                          scopes=sorted(scopes), temperature_scopes=sorted(temperature_scopes))
        except (OSError, sqlite3.Error, ValueError, OverflowError):
            pass
        return result
