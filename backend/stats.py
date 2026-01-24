"""Simple statistics collection for Facto web compiler."""

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml


# How many recent compilation times to keep for statistics
MAX_RECENT_TIMES = 100

# Default stats file location (in data/ subdirectory)
DEFAULT_STATS_DIR = Path(__file__).parent / "data"
DEFAULT_STATS_FILE = DEFAULT_STATS_DIR / "stats.yaml"


class Stats:
    """
    Simple statistics tracker that persists to a YAML file.
    Thread-safe for async operations.
    """

    def __init__(self, stats_file: Path | str | None = None):
        if stats_file is None:
            stats_file = DEFAULT_STATS_FILE

        self._file_path = Path(stats_file).resolve()

        # Ensure parent directory exists
        self._file_path.parent.mkdir(parents=True, exist_ok=True)

        self._lock = asyncio.Lock()
        self._data: dict[str, Any] = self._load_or_init()

    def _load_or_init(self) -> dict[str, Any]:
        """Load existing stats or initialize new ones."""
        if self._file_path.exists():
            try:
                with open(self._file_path, "r") as f:
                    data = yaml.safe_load(f) or {}
                    # Ensure all required fields exist
                    self._ensure_fields(data)
                    return data
            except Exception:
                pass

        return self._create_initial_data()

    def _create_initial_data(self) -> dict[str, Any]:
        """Create initial stats structure."""
        return {
            "created_at": datetime.utcnow().isoformat(),
            "last_updated": datetime.utcnow().isoformat(),
            "unique_sessions": 0,
            "total_compilations": 0,
            "successful_compilations": 0,
            "failed_compilations": 0,
            "compilation_times": [],  # Recent times in seconds for computing stats
            "avg_compilation_time_seconds": 0.0,
            "median_compilation_time_seconds": 0.0,
            "min_compilation_time_seconds": 0.0,
            "max_compilation_time_seconds": 0.0,
            # Queue metrics
            "current_queue_length": 0,
            "max_queue_length_seen": 0,
            "total_queued_requests": 0,
            "queue_wait_times": [],  # Recent wait times
            "avg_queue_wait_seconds": 0.0,
            "median_queue_wait_seconds": 0.0,
            "min_queue_wait_seconds": 0.0,
            "max_queue_wait_seconds": 0.0,
            # Total time (queue + compilation)
            "total_request_times": [],  # Recent total times
            "avg_total_request_seconds": 0.0,
            "median_total_request_seconds": 0.0,
            "min_total_request_seconds": 0.0,
            "max_total_request_seconds": 0.0,
        }

    def _ensure_fields(self, data: dict[str, Any]):
        """Ensure all required fields exist in loaded data."""
        defaults = self._create_initial_data()
        for key, value in defaults.items():
            if key not in data:
                data[key] = value

    async def _save(self):
        """Save stats to YAML file."""
        self._data["last_updated"] = datetime.utcnow().isoformat()
        try:
            with open(self._file_path, "w") as f:
                yaml.dump(self._data, f, default_flow_style=False, sort_keys=False)
        except Exception as e:
            print(f"Warning: Could not save stats: {e}")

    async def record_session(self):
        """Record a new session (frontend connect)."""
        async with self._lock:
            self._data["unique_sessions"] = self._data.get("unique_sessions", 0) + 1
            await self._save()

    async def record_compilation_start(self):
        """Record start of a compilation."""
        async with self._lock:
            self._data["total_compilations"] = (
                self._data.get("total_compilations", 0) + 1
            )
            await self._save()

    async def record_compilation_success(self, duration_seconds: float):
        """Record successful compilation with timing."""
        async with self._lock:
            self._data["successful_compilations"] = (
                self._data.get("successful_compilations", 0) + 1
            )
            self._record_compilation_time(duration_seconds)
            await self._save()

    async def record_compilation_failure(self, duration_seconds: float):
        """Record failed compilation with timing."""
        async with self._lock:
            self._data["failed_compilations"] = (
                self._data.get("failed_compilations", 0) + 1
            )
            self._record_compilation_time(duration_seconds)
            await self._save()

    def _record_compilation_time(self, duration: float):
        """Record a compilation time and update statistics."""
        times = self._data.get("compilation_times", [])
        times.append(round(duration, 3))

        # Keep only recent times
        if len(times) > MAX_RECENT_TIMES:
            times = times[-MAX_RECENT_TIMES:]

        self._data["compilation_times"] = times

        # Update time statistics
        if times:
            sorted_times = sorted(times)
            self._data["avg_compilation_time_seconds"] = round(
                sum(times) / len(times), 3
            )
            self._data["min_compilation_time_seconds"] = sorted_times[0]
            self._data["max_compilation_time_seconds"] = sorted_times[-1]

            # Median
            n = len(sorted_times)
            if n % 2 == 0:
                median = (sorted_times[n // 2 - 1] + sorted_times[n // 2]) / 2
            else:
                median = sorted_times[n // 2]
            self._data["median_compilation_time_seconds"] = round(median, 3)

    def _compute_time_stats(self, times_list: list[float], prefix: str):
        """Compute and update statistics for a time series."""
        if not times_list:
            return
        
        sorted_times = sorted(times_list)
        n = len(sorted_times)
        
        self._data[f"avg_{prefix}_seconds"] = round(sum(sorted_times) / n, 3)
        self._data[f"min_{prefix}_seconds"] = round(sorted_times[0], 3)
        self._data[f"max_{prefix}_seconds"] = round(sorted_times[-1], 3)
        
        # Median
        if n % 2 == 0:
            median = (sorted_times[n // 2 - 1] + sorted_times[n // 2]) / 2
        else:
            median = sorted_times[n // 2]
        self._data[f"median_{prefix}_seconds"] = round(median, 3)

    async def record_queue_wait(self, wait_time: float):
        """Record time spent waiting in queue."""
        async with self._lock:
            self._data["total_queued_requests"] = (
                self._data.get("total_queued_requests", 0) + 1
            )
            
            wait_times = self._data.get("queue_wait_times", [])
            wait_times.append(round(wait_time, 3))
            
            if len(wait_times) > MAX_RECENT_TIMES:
                wait_times = wait_times[-MAX_RECENT_TIMES:]
            
            self._data["queue_wait_times"] = wait_times
            self._compute_time_stats(wait_times, "queue_wait")
            await self._save()

    async def record_total_request_time(self, total_time: float):
        """Record total request time (queue wait + compilation)."""
        async with self._lock:
            total_times = self._data.get("total_request_times", [])
            total_times.append(round(total_time, 3))
            
            if len(total_times) > MAX_RECENT_TIMES:
                total_times = total_times[-MAX_RECENT_TIMES:]
            
            self._data["total_request_times"] = total_times
            self._compute_time_stats(total_times, "total_request")
            await self._save()

    async def update_queue_length(self, queue_length: int):
        """Update current queue length."""
        async with self._lock:
            self._data["current_queue_length"] = queue_length
            
            # Track maximum queue length seen
            max_seen = self._data.get("max_queue_length_seen", 0)
            if queue_length > max_seen:
                self._data["max_queue_length_seen"] = queue_length
            
            await self._save()

    def get_stats(self) -> dict[str, Any]:
        """Get current statistics (excluding raw times lists)."""
        result = dict(self._data)
        # Don't expose the raw times lists
        result.pop("compilation_times", None)
        result.pop("queue_wait_times", None)
        result.pop("total_request_times", None)
        return result


# Global stats instance
_stats: Stats | None = None


def get_stats() -> Stats:
    """Get the global stats instance."""
    global _stats
    if _stats is None:
        _stats = Stats()
    return _stats
