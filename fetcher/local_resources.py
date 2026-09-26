"""Small host/container resource probes shared by local import CLIs."""

from __future__ import annotations

import os
from pathlib import Path


def available_cpu_count() -> int:
    """Return the smaller of process CPU affinity and the cgroup CPU quota."""

    try:
        affinity = max(1, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        affinity = max(1, os.cpu_count() or 1)

    quota_cpus: int | None = None
    try:
        quota_text, period_text = Path("/sys/fs/cgroup/cpu.max").read_text(
            encoding="ascii"
        ).split()
        period = int(period_text)
        if quota_text != "max" and period > 0:
            quota_cpus = max(1, int(quota_text) // period)
    except (OSError, ValueError):
        try:
            quota = int(
                Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text(
                    encoding="ascii"
                )
            )
            period = int(
                Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text(
                    encoding="ascii"
                )
            )
            if quota > 0 and period > 0:
                quota_cpus = max(1, quota // period)
        except (OSError, ValueError):
            pass
    return min(affinity, quota_cpus) if quota_cpus is not None else affinity
