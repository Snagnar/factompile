"""Facto compiler service with streaming output and direct compilation."""

import asyncio
import base64
import json
import logging
import re
import time
import uuid
import zlib
from pathlib import Path
from typing import AsyncGenerator, Callable
from dataclasses import dataclass
from enum import Enum
from logging.handlers import TimedRotatingFileHandler

from dsl_compiler.cli import compile_dsl_source

from config import get_settings
from stats import get_stats

settings = get_settings()

# Setup logging with hourly rotation
logger = logging.getLogger("facto_compiler")
logger.setLevel(logging.INFO if not settings.debug_mode else logging.DEBUG)

# Create logs directory if it doesn't exist
log_dir = Path("logs")
log_dir.mkdir(exist_ok=True)

# Hourly rotating file handler
file_handler = TimedRotatingFileHandler(
    log_dir / "facto_backend.log",
    when="H",  # Rotate hourly
    interval=1,
    backupCount=24 * 7,  # Keep 7 days of logs
    encoding="utf-8",
)
file_handler.setFormatter(
    logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
)
logger.addHandler(file_handler)

# Console handler for debug mode
if settings.debug_mode:
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    logger.addHandler(console_handler)


class OutputType(str, Enum):
    LOG = "log"
    BLUEPRINT = "blueprint"
    JSON = "json"
    ERROR = "error"
    STATUS = "status"
    QUEUE = "queue"  # For queue position updates


def json_to_blueprint(json_data: dict | str) -> str:
    """Convert JSON data to Factorio blueprint string."""
    if isinstance(json_data, dict):
        json_str = json.dumps(json_data, separators=(',', ':'))
    else:
        json_str = json_data
    
    json_bytes = json_str.encode('utf-8')
    compressed = zlib.compress(json_bytes, level=9)
    encoded = base64.b64encode(compressed).decode('ascii')
    return '0' + encoded


@dataclass
class CompilerOptions:
    """Options passed to the Facto compiler."""

    power_poles: str | None = None  # small, medium, big, substation
    name: str | None = None  # Blueprint name
    no_optimize: bool = False
    json_output: bool = False
    log_level: str = "info"  # debug, info, warning, error

    def __post_init__(self):
        """Validate and sanitize options after initialization."""
        # Validate log level
        valid_log_levels = {"debug", "info", "warning", "error"}
        if self.log_level not in valid_log_levels:
            self.log_level = "info"

        # Validate power poles
        valid_poles = {None, "small", "medium", "big", "substation"}
        if self.power_poles not in valid_poles:
            self.power_poles = None

        # Sanitize blueprint name
        if self.name is not None:
            self.name = sanitize_blueprint_name(self.name)


def sanitize_blueprint_name(name: str | None) -> str | None:
    """
    Sanitize blueprint name to only allow safe characters.
    Prevents command injection and path traversal.
    """
    if name is None:
        return None

    # Only allow alphanumeric, spaces, hyphens, underscores
    sanitized = re.sub(r"[^a-zA-Z0-9\s\-_]", "", name)

    # Trim and limit length
    sanitized = sanitized.strip()[:100]

    return sanitized if sanitized else None


# ==================== Compilation Queue ====================


class CompilationQueue:
    """
    A queue that ensures only one compilation runs at a time.
    Tracks queue position for waiting clients.
    """

    def __init__(self, max_size: int = 10):
        self._lock = asyncio.Lock()
        self._queue: list[str] = []  # List of request IDs in queue
        self._current: str | None = None  # Currently compiling request ID
        self._events: dict[str, asyncio.Event] = {}  # Events for each waiting request
        self._max_size = max_size

    @property
    def queue_length(self) -> int:
        """Number of requests waiting in queue (not including current)."""
        return len(self._queue)

    @property
    def is_full(self) -> bool:
        """Check if queue is at capacity."""
        return len(self._queue) >= self._max_size

    def get_position(self, request_id: str) -> int:
        """Get position in queue (0 = currently compiling, 1+ = waiting)."""
        if self._current == request_id:
            return 0
        try:
            return self._queue.index(request_id) + 1
        except ValueError:
            return -1  # Not in queue

    async def acquire(
        self, request_id: str, position_callback: Callable[[int], None] | None = None
    ) -> tuple[bool, str | None]:
        """
        Wait for turn to compile.
        Returns (True, None) when acquired, (False, error_message) on failure.
        position_callback is called with queue position updates.
        """
        event = asyncio.Event()

        async with self._lock:
            # If nothing is compiling and queue is empty, start immediately
            if self._current is None and len(self._queue) == 0:
                self._current = request_id
                return True, None

            # Check queue capacity
            if len(self._queue) >= self._max_size:
                return False, "Server is busy. Please try again later."

            # Add to queue
            self._queue.append(request_id)
            self._events[request_id] = event
            position = len(self._queue)

        # Notify initial position
        if position_callback:
            position_callback(position)

        # Wait for our turn with position updates
        while True:
            try:
                # Wait with timeout to periodically update position
                await asyncio.wait_for(event.wait(), timeout=1.0)
                break  # Event was set, we can proceed
            except asyncio.TimeoutError:
                # Update position
                pos = self.get_position(request_id)
                if pos == 0:
                    break  # We're up!
                if pos == -1:
                    return False, "Removed from queue"
                if position_callback:
                    position_callback(pos)

        return True, None

    async def release(self, request_id: str):
        """Release the compilation slot and notify next in queue."""
        async with self._lock:
            if self._current == request_id:
                self._current = None

                # Notify next in queue
                if self._queue:
                    next_id = self._queue.pop(0)
                    self._current = next_id
                    if next_id in self._events:
                        self._events[next_id].set()
                        del self._events[next_id]
            elif request_id in self._queue:
                # Request cancelled while waiting
                self._queue.remove(request_id)
                if request_id in self._events:
                    del self._events[request_id]


# Global compilation queue (only 1 compilation at a time)
_compilation_queue: CompilationQueue | None = None


def get_compilation_queue() -> CompilationQueue:
    global _compilation_queue
    if _compilation_queue is None:
        _compilation_queue = CompilationQueue(max_size=settings.max_queue_size)
    return _compilation_queue


def sanitize_source(source: str) -> str:
    """
    Sanitize source code to prevent injection attacks.
    Returns cleaned source or raises ValueError.

    Only validates basic security without rejecting legitimate Facto code.
    """
    if not source or not source.strip():
        raise ValueError("Source code cannot be empty")

    if len(source) > settings.max_source_length:
        raise ValueError(
            f"Source code exceeds maximum length of {settings.max_source_length} characters"
        )

    # Remove null bytes only (they're never valid in text)
    if "\x00" in source:
        raise ValueError("Source code contains null bytes")

    # Simple check for obvious shell injection (bash-style)
    # These would never appear in Facto code which is Python-compiled
    dangerous_patterns = [
        r";\s*(rm|wget|curl)\s+-",  # Direct dangerous commands
        r"\$\(.*\bsh\b",  # $(sh ...) style
        r"`.*\bsh\b",  # `sh ...` style
    ]

    for pattern in dangerous_patterns:
        if re.search(pattern, source):
            raise ValueError("Source contains potentially dangerous patterns")

    logger.debug(f"Source validation passed ({len(source)} chars)")
    return source


async def compile_facto_direct(
    source: str, options: CompilerOptions
) -> AsyncGenerator[tuple[OutputType, str], None]:
    """
    Compile Facto source code directly using the in-process compiler.
    Yields tuples of (output_type, content) for streaming to frontend.

    Captures logging output in real-time and streams it to the client.
    """
    import io
    import logging as py_logging
    from logging import StreamHandler

    try:
        logger.info(
            f"Starting compilation with options: optimize={not options.no_optimize}, power_poles={options.power_poles}"
        )

        # Sanitize input first
        try:
            source = sanitize_source(source)
        except ValueError as e:
            logger.warning(f"Source validation failed: {e}")
            yield (OutputType.ERROR, str(e))
            return

        yield (OutputType.STATUS, "Compiling...")

        # Create a string buffer to capture log output
        log_stream = io.StringIO()
        log_handler = StreamHandler(log_stream)
        log_handler.setLevel(getattr(py_logging, options.log_level.upper()))
        log_handler.setFormatter(py_logging.Formatter("%(levelname)s: %(message)s"))

        # Get the dsl_compiler logger and add our handler
        dsl_logger = py_logging.getLogger("dsl_compiler")
        root_logger = py_logging.getLogger()

        # Store original level and add handler
        original_dsl_level = dsl_logger.level
        original_root_level = root_logger.level

        dsl_logger.addHandler(log_handler)
        root_logger.addHandler(log_handler)
        dsl_logger.setLevel(getattr(py_logging, options.log_level.upper()))
        root_logger.setLevel(getattr(py_logging, options.log_level.upper()))

        # Run compilation in executor to not block event loop
        # and allow us to capture logs progressively
        loop = asyncio.get_event_loop()

        def run_compile():
            # Always compile with JSON output to get the data structure
            return compile_dsl_source(
                source_code=source,
                source_name="<web>",
                program_name=options.name,
                optimize=not options.no_optimize,
                log_level=options.log_level,
                power_pole_type=options.power_poles,
                use_json=True,  # Always get JSON
            )

        # Run compilation in thread pool
        compile_task = loop.run_in_executor(None, run_compile)

        # Poll for log output while compilation runs
        last_pos = 0
        while not compile_task.done():
            await asyncio.sleep(0.1)  # Check every 100ms

            # Get new log content
            current_content = log_stream.getvalue()
            if len(current_content) > last_pos:
                new_logs = current_content[last_pos:]
                for line in new_logs.splitlines():
                    if line.strip():
                        yield (OutputType.LOG, line)
                last_pos = len(current_content)

        # Get final result
        success, result, diagnostics = await compile_task

        # Flush any remaining logs
        current_content = log_stream.getvalue()
        if len(current_content) > last_pos:
            new_logs = current_content[last_pos:]
            for line in new_logs.splitlines():
                if line.strip():
                    yield (OutputType.LOG, line)

        # Clean up logging handler
        dsl_logger.removeHandler(log_handler)
        root_logger.removeHandler(log_handler)
        dsl_logger.setLevel(original_dsl_level)
        root_logger.setLevel(original_root_level)
        log_handler.close()

        # Stream diagnostic messages as logs
        if diagnostics:
            for msg in diagnostics:
                if msg.strip():
                    yield (OutputType.LOG, msg)

        if success:
            logger.info("Compilation successful")
            yield (OutputType.STATUS, "Compilation successful!")
            
            # result is now JSON - ensure it's a string for SSE transmission
            if isinstance(result, dict):
                json_str = json.dumps(result)
            else:
                json_str = result
            
            # Yield JSON output
            yield (OutputType.JSON, json_str)
            
            # Convert to blueprint and yield
            try:
                if isinstance(result, dict):
                    json_data = result
                else:
                    json_data = json.loads(result)
                blueprint = json_to_blueprint(json_data)
                yield (OutputType.BLUEPRINT, blueprint)
            except Exception as e:
                logger.error(f"Failed to convert JSON to blueprint: {e}")
                yield (OutputType.ERROR, f"Blueprint conversion failed: {str(e)}")
        else:
            logger.warning(f"Compilation failed: {result}")
            yield (OutputType.STATUS, f"Compilation failed: {result}")
            yield (OutputType.ERROR, result)

    except Exception as e:
        logger.error(f"Compilation error: {e}", exc_info=True)
        yield (OutputType.ERROR, f"Internal compiler error: {str(e)}")
        yield (OutputType.STATUS, "Compilation failed")


async def compile_facto(
    source: str, options: CompilerOptions
) -> AsyncGenerator[tuple[OutputType, str], None]:
    """
    Compile Facto source code and yield output as it becomes available.

    Yields tuples of (output_type, content) for streaming to frontend.
    Handles queuing and resource management.
    """
    queue = get_compilation_queue()
    request_id = str(uuid.uuid4())

    logger.info(f"New compilation request {request_id}")

    # Track queue position updates to yield
    position_updates: list[int] = []

    def on_position_update(pos: int):
        position_updates.append(pos)

    # Check initial queue length
    initial_queue_length = queue.queue_length
    if initial_queue_length > 0 or queue._current is not None:
        logger.info(
            f"Request {request_id} queued at position {initial_queue_length + 1}"
        )
        yield (OutputType.QUEUE, str(initial_queue_length + 1))
        yield (
            OutputType.STATUS,
            f"Waiting in queue (position {initial_queue_length + 1})...",
        )

    # Try to acquire slot with timeout
    try:
        acquire_task = asyncio.create_task(
            queue.acquire(request_id, on_position_update)
        )

        # Wait for slot with periodic position updates and overall timeout
        start_wait = time.perf_counter()
        while not acquire_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(acquire_task), timeout=1.0)
            except asyncio.TimeoutError:
                # Check overall queue timeout
                if time.perf_counter() - start_wait > settings.queue_timeout:
                    logger.warning(f"Request {request_id} timed out in queue")
                    await queue.release(request_id)
                    yield (
                        OutputType.ERROR,
                        "Queue timeout. Server is very busy. Please try again later.",
                    )
                    return
                # Yield any position updates
                while position_updates:
                    pos = position_updates.pop(0)
                    yield (OutputType.QUEUE, str(pos))
                    yield (OutputType.STATUS, f"Waiting in queue (position {pos})...")

        success, error_msg = acquire_task.result()
        if not success:
            logger.warning(f"Request {request_id} failed to acquire slot: {error_msg}")
            yield (OutputType.ERROR, error_msg or "Failed to acquire compilation slot")
            return

    except asyncio.TimeoutError:
        logger.warning(f"Request {request_id} timed out acquiring slot")
        yield (
            OutputType.ERROR,
            "Queue timeout. Server is very busy. Please try again later.",
        )
        await queue.release(request_id)
        return

    # Now we have the slot, yield position 0
    logger.info(f"Request {request_id} acquired compilation slot")
    yield (OutputType.QUEUE, "0")

    # Record compilation start
    stats = get_stats()
    await stats.record_compilation_start()
    compilation_success = False
    start_time = time.perf_counter()

    try:
        # Compile directly in-process
        async for output_type, content in compile_facto_direct(source, options):
            yield (output_type, content)
            if output_type == OutputType.BLUEPRINT:
                compilation_success = True

    except Exception as e:
        logger.error(f"Compilation failed for request {request_id}: {e}", exc_info=True)
        yield (OutputType.ERROR, f"Compilation error: {str(e)}")

    finally:
        # Record compilation result with timing
        duration = time.perf_counter() - start_time
        logger.info(
            f"Request {request_id} completed in {duration:.2f}s, success={compilation_success}"
        )

        if compilation_success:
            await stats.record_compilation_success(duration)
        else:
            await stats.record_compilation_failure(duration)
        await queue.release(request_id)
