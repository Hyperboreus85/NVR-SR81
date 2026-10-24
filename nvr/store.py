"""SQLite index and encrypted stream credentials, all on local storage."""
from contextlib import contextmanager
from pathlib import Path
import os
import sqlite3
import time
import uuid

from cryptography.fernet import Fernet


class Store:
    def __init__(self, data_dir: Path):
        self.db_path = data_dir / "nvr.sqlite3"
        key_path = data_dir / "credentials.key"
        # Exclusive create prevents two simultaneous starts overwriting a key.
        if not key_path.exists():
            try:
                fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(Fernet.generate_key())
            except FileExistsError:
                pass
        self.cipher = Fernet(key_path.read_bytes())
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS cameras (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
                    preview_url TEXT NOT NULL, enabled INTEGER NOT NULL,
                    audio_mode TEXT NOT NULL, retention_days INTEGER NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recordings (
                    id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, path TEXT UNIQUE NOT NULL,
                    started_at REAL NOT NULL, duration REAL NOT NULL, size INTEGER NOT NULL,
                    video_codec TEXT NOT NULL, audio_codec TEXT
                );
                CREATE INDEX IF NOT EXISTS recordings_time ON recordings(camera_id, started_at);
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _decrypt_camera(self, row):
        if row is None:
            return None
        result = dict(row)
        for key in ("url", "preview_url"):
            result[key] = self.cipher.decrypt(result[key].encode()).decode()
        result["enabled"] = bool(result["enabled"])
        return result

    def list_cameras(self):
        with self.connect() as db:
            return [self._decrypt_camera(row) for row in db.execute("SELECT * FROM cameras ORDER BY created_at")]

    def get_camera(self, camera_id):
        with self.connect() as db:
            return self._decrypt_camera(db.execute("SELECT * FROM cameras WHERE id=?", (camera_id,)).fetchone())

    def save_camera(self, camera, camera_id=None):
        camera_id = camera_id or uuid.uuid4().hex
        values = dict(camera)
        for key in ("url", "preview_url"):
            values[key] = self.cipher.encrypt(values[key].encode()).decode()
        with self.connect() as db:
            db.execute("""INSERT INTO cameras VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,
                preview_url=excluded.preview_url,enabled=excluded.enabled,
                audio_mode=excluded.audio_mode,retention_days=excluded.retention_days""",
                (camera_id, values["name"], values["url"], values["preview_url"],
                 values["enabled"], values["audio_mode"], values["retention_days"], time.time()))
        return self.get_camera(camera_id)

    def delete_camera(self, camera_id):
        with self.connect() as db:
            db.execute("DELETE FROM cameras WHERE id=?", (camera_id,))

    def add_recording(self, camera_id, path, started_at, duration, size, video_codec, audio_codec=None):
        recording_id = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO recordings VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       (recording_id, camera_id, str(path), started_at, duration, size, video_codec, audio_codec))
            return db.execute("SELECT id FROM recordings WHERE path=?", (str(path),)).fetchone()["id"]

    def list_recordings(self, camera_id=None, start=None, end=None, limit=2000):
        clauses, args = [], []
        if camera_id is not None:
            clauses.append("camera_id=?")
            args.append(camera_id)
        if start is not None:
            clauses.append("started_at + duration > ?")
            args.append(start)
        if end is not None:
            clauses.append("started_at < ?")
            args.append(end)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self.connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM recordings" + where + " ORDER BY started_at LIMIT ?", (*args, limit))]

    def get_recording(self, recording_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM recordings WHERE id=?", (recording_id,)).fetchone()
            return dict(row) if row else None

    def delete_recording(self, recording_id):
        with self.connect() as db:
            db.execute("DELETE FROM recordings WHERE id=?", (recording_id,))

    def recording_bytes(self):
        with self.connect() as db:
            return db.execute("SELECT COALESCE(SUM(size), 0) FROM recordings").fetchone()[0]

    def meta_get(self, key):
        with self.connect() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
            return row[0] if row else None

    def meta_set(self, key, value):
        with self.connect() as db:
            db.execute("INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def meta_delete(self, key):
        with self.connect() as db:
            db.execute("DELETE FROM metadata WHERE key=?", (key,))
