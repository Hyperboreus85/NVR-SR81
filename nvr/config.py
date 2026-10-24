"""Local configuration. No external services or automatic update calls."""
from dataclasses import dataclass, field
import os
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("NVR_DATA_DIR", "./data")))
    recordings_dir: Path = field(default_factory=lambda: Path(os.getenv("NVR_RECORDINGS_DIR", "./recordings")))
    ffmpeg: str = field(default_factory=lambda: os.getenv("NVR_FFMPEG", "ffmpeg"))
    ffprobe: str = field(default_factory=lambda: os.getenv("NVR_FFPROBE", "ffprobe"))
    segment_seconds: int = field(default_factory=lambda: int(os.getenv("NVR_SEGMENT_SECONDS", "60")))
    min_free_bytes: int = field(default_factory=lambda: int(float(os.getenv("NVR_MIN_FREE_GB", "5")) * 1_000_000_000))
    password: str = field(default_factory=lambda: os.getenv("NVR_ADMIN_PASSWORD", ""))
    secure_cookie: bool = field(default_factory=lambda: os.getenv("NVR_SECURE_COOKIE", "0") == "1")
    live_max_streams: int = field(default_factory=lambda: int(os.getenv("NVR_LIVE_MAX_STREAMS", "16")))
    live_max_transcodes: int = field(default_factory=lambda: int(os.getenv("NVR_LIVE_MAX_TRANSCODES", "2")))
    cache_dir: Path = field(init=False)

    def __post_init__(self):
        self.data_dir = self.data_dir.resolve()
        self.recordings_dir = self.recordings_dir.resolve()
        self.cache_dir = self.data_dir / "cache"
        if not 5 <= self.segment_seconds <= 600:
            raise ValueError("NVR_SEGMENT_SECONDS deve essere fra 5 e 600")
        if self.min_free_bytes < 0:
            raise ValueError("NVR_MIN_FREE_GB non può essere negativo")
        if not 1 <= self.live_max_streams <= 32:
            raise ValueError("NVR_LIVE_MAX_STREAMS deve essere fra 1 e 32")
        if not 0 <= self.live_max_transcodes <= 4:
            raise ValueError("NVR_LIVE_MAX_TRANSCODES deve essere fra 0 e 4")
        for path in (self.data_dir, self.recordings_dir, self.cache_dir):
            path.mkdir(parents=True, exist_ok=True)

