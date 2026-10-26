"""One archive policy for recording, warnings, cache admission and headroom.

Percentages describe available filesystem bytes. Unknown measurements cannot
authorize deletion. The system disk is observable but is never overwritten.
"""
from __future__ import annotations

from collections.abc import Mapping
import math

WARNING_FREE_PERCENT = 10
OVERWRITE_FREE_PERCENT = 5


def _byte_count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return None
    return int(value) if value >= 0 else None


def archive_reserve_bytes(total):
    """Round upward so integer-byte thresholds never trigger later than 5%."""
    size = _byte_count(total)
    return (size * OVERWRITE_FREE_PERCENT + 99) // 100 if size else None


def disk_storage_status(disk, *, archive=False):
    def field(key):
        return disk.get(key) if isinstance(disk, Mapping) else getattr(disk, key, None)

    total, free = _byte_count(field("total")), _byte_count(field("free"))
    valid = total is not None and total > 0 and free is not None and free <= total
    warning = bool(valid and free * 100 < total * WARNING_FREE_PERCENT)
    critical = bool(valid and free * 100 < total * OVERWRITE_FREE_PERCENT)
    return {"warning_free_percent": WARNING_FREE_PERCENT,
            "overwrite_free_percent": OVERWRITE_FREE_PERCENT,
            "free_percent": free / total * 100 if valid else None,
            "reserve_bytes": archive_reserve_bytes(total) if archive and valid else None,
            "warning": warning, "overwrite_required": critical if archive else False,
            "state": "unavailable" if not valid else "critical" if critical else "warning" if warning else "normal"}


def archive_storage_status(disk):
    return disk_storage_status(disk, archive=True)


def storage_overview(disks):
    disks = disks if isinstance(disks, Mapping) else {}
    shared = disks.get("shared_filesystem")
    return {"archive": archive_storage_status(disks.get("recordings")),
            "system": None if shared is True else disk_storage_status(disks.get("root")),
            "shared_filesystem": shared if isinstance(shared, bool) else None}
