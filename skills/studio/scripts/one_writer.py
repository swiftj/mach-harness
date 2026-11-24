"""One writer at a time for a Product Studio cache file (M8).

An exclusive advisory lock (fcntl.flock) on a sidecar file beside the cache, held from load to
save. A second command waits a few seconds and is then refused with Busy; it never hangs. The
lock is released when the holder exits, however it exits, so a crash leaves nothing to clean up.

Standard library only. Imported by requests_in.py; not a command of its own.
"""

import contextlib
import fcntl
import os
import time
from pathlib import Path
from typing import Iterator


class Busy(Exception):
    """Another command holds the file."""


@contextlib.contextmanager
def held(path: Path, wait_seconds: float) -> Iterator[None]:
    sidecar = path.with_name(path.name + ".lock")
    if sidecar.is_symlink():
        raise Busy(f"{sidecar} is a symbolic link.")
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(str(sidecar), os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Busy("another command holds it")
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        os.close(handle)
