"""Bounded, non-AI frame differences for a selected completed recording."""
from __future__ import annotations

import math
from typing import Any

from .config import MAX_SEGMENT_SECONDS


WIDTH, HEIGHT = 160, 90
FRAME_BYTES = WIDTH * HEIGHT
SAMPLE_SECONDS = 0.5
MAX_DURATION = MAX_SEGMENT_SECONDS + 60  # a segment closes at the next video keyframe
MERGE_GAP_SECONDS = 1.0
# Pixel intensity difference (0..255), followed by minimum changed image area.
# These are deliberately simple presets, rather than object classification.
SENSITIVITIES = {"low": (30, 0.015), "medium": (20, 0.006), "high": (12, 0.002)}


def motion_timeout(duration: float) -> float:
    return max(60.0, min(duration / 2, 3600.0))


class MotionAnalyzer:
    """Consume one grayscale frame at a time; retain only the previous frame."""

    def __init__(self, duration: float, sensitivity: str = "medium"):
        if sensitivity not in SENSITIVITIES:
            raise ValueError("Invalid motion sensitivity.")
        if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
            raise ValueError("Motion analysis requires a recording of up to 2 hours, plus a short keyframe overrun.")
        self.duration, self.sensitivity = float(duration), sensitivity
        self.threshold, area = SENSITIVITIES[sensitivity]
        self.minimum_pixels = math.ceil(FRAME_BYTES * area)
        self.max_frames = math.ceil(self.duration / SAMPLE_SECONDS) + 2
        self.frames = 0
        self.previous: bytes | None = None
        self.events: list[dict[str, float]] = []

    def push(self, frame: bytes) -> None:
        if len(frame) != FRAME_BYTES:
            raise ValueError("Motion analysis received an incomplete video frame.")
        if self.frames >= self.max_frames:
            raise ValueError("Video duration does not match the recording.")
        previous, self.previous = self.previous, frame
        index = self.frames
        self.frames += 1
        if previous is None:
            return
        changed = sum(abs(current - old) >= self.threshold for current, old in zip(frame, previous))
        if changed < self.minimum_pixels:
            return
        start = max(0.0, (index - 1) * SAMPLE_SECONDS)
        end = min(self.duration, index * SAMPLE_SECONDS)
        if start >= end:
            return
        score = round(changed / FRAME_BYTES, 4)
        if self.events and start - self.events[-1]["end"] <= MERGE_GAP_SECONDS:
            event = self.events[-1]
            event["end"], event["score"] = end, max(event["score"], score)
        else:
            self.events.append({"start": start, "end": end, "score": score})

    def result(self) -> dict[str, Any]:
        return {"duration": self.duration, "sample_seconds": SAMPLE_SECONDS,
                "sensitivity": self.sensitivity, "events": [dict(event) for event in self.events],
                "method": "frame-difference"}
