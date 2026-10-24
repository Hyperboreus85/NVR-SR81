"""Local configuration. No external services or automatic update calls."""
from dataclasses import dataclass, field
import os
from pathlib import Path


MIN_SEGMENT_SECONDS = 60
MAX_SEGMENT_SECONDS = 7200
SEGMENT_MINUTE_CHOICES = (1, 2, 3, 4, 5, *range(10, 121, 5))


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("NVR_DATA_DIR", "./data")))
    recordings_dir: Path = field(default_factory=lambda: Path(os.getenv("NVR_RECORDINGS_DIR", "./recordings")))
    ffmpeg: str = field(default_factory=lambda: os.getenv("NVR_FFMPEG", "ffmpeg"))
    ffprobe: str = field(default_factory=lambda: os.getenv("NVR_FFPROBE", "ffprobe"))
    segment_seconds: int = field(default_factory=lambda: int(os.getenv("NVR_SEGMENT_SECONDS", "1800")))
    min_free_bytes: int = field(default_factory=lambda: int(float(os.getenv("NVR_MIN_FREE_GB", "5")) * 1_000_000_000))
    password: str = field(default_factory=lambda: os.getenv("NVR_ADMIN_PASSWORD", ""))
    secure_cookie: bool = field(default_factory=lambda: os.getenv("NVR_SECURE_COOKIE", "0") == "1")
    live_max_streams: int = field(default_factory=lambda: int(os.getenv("NVR_LIVE_MAX_STREAMS", "16")))
    live_max_transcodes: int = field(default_factory=lambda: int(os.getenv("NVR_LIVE_MAX_TRANSCODES", "2")))
    cache_dir: Path | None = field(default_factory=lambda: Path(value) if (value := os.getenv("NVR_CACHE_DIR")) else None)

    def __post_init__(self):
        self.data_dir = self.data_dir.resolve()
        self.recordings_dir = self.recordings_dir.resolve()
        self.cache_dir = (self.cache_dir or self.data_dir / "cache").resolve()
        if (self.cache_dir in {self.data_dir, self.recordings_dir, Path(self.cache_dir.anchor)}
                or (self.cache_dir.is_relative_to(self.recordings_dir)
                    and not self.cache_dir.is_relative_to(self.recordings_dir / ".cache"))):
            raise ValueError("NVR_CACHE_DIR must use a dedicated directory; inside the archive use .cache.")
        if type(self.segment_seconds) is not int or not MIN_SEGMENT_SECONDS <= self.segment_seconds <= MAX_SEGMENT_SECONDS:
            raise ValueError("NVR_SEGMENT_SECONDS must be an integer between 60 and 7200")
        if self.min_free_bytes < 0:
            raise ValueError("NVR_MIN_FREE_GB cannot be negative")
        if not 1 <= self.live_max_streams <= 32:
            raise ValueError("NVR_LIVE_MAX_STREAMS must be between 1 and 32")
        if not 0 <= self.live_max_transcodes <= 4:
            raise ValueError("NVR_LIVE_MAX_TRANSCODES must be between 0 and 4")
        for path in (self.data_dir, self.recordings_dir, self.cache_dir):
            path.mkdir(parents=True, exist_ok=True)

