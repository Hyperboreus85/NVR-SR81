"""Persisted recorder preferences, independent of the process environment."""
import logging

from .config import SEGMENT_MINUTE_CHOICES


SEGMENT_PREFERENCE_KEY = "recording.segment_seconds.v1"


def restore_recording_preferences(store, settings) -> None:
    raw = store.meta_get(SEGMENT_PREFERENCE_KEY)
    if raw is None or raw == "":
        return
    try:
        seconds = int(raw)
        if seconds not in {minutes * 60 for minutes in SEGMENT_MINUTE_CHOICES}:
            raise ValueError
    except (TypeError, ValueError):
        logging.getLogger(__name__).warning("Invalid saved recording duration; using startup configuration")
        return
    settings.segment_seconds = seconds


def recording_preferences(settings) -> dict:
    seconds = settings.segment_seconds
    return {"segment_seconds": seconds, "segment_minutes": seconds / 60,
            "allowed_minutes": list(SEGMENT_MINUTE_CHOICES), "recommended_minutes": 30,
            "scope": "all_cameras"}
