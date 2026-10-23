"""Observe supported writes while returning native Python file objects unchanged."""
import atexit
import builtins
import functools
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import sys
import time
import uuid
import weakref

# Preserve an existing sitecustomize outside this injected directory.
_here = os.path.realpath(os.path.dirname(__file__))
_other = importlib.machinery.PathFinder.find_spec("sitecustomize", [p for p in sys.path if os.path.realpath(p or os.curdir) != _here])
if _other and _other.loader:
    _module = importlib.util.module_from_spec(_other)
    _other.loader.exec_module(_module)

_open, _io_open = builtins.open, io.open
_os_open, _os_write, _os_close = os.open, os.write, os.close
_exit_code = 0
_changed, _fds, _handles = {}, {}, {}
_config, _log = None, None
_paused = False
_hash_reads = 0
_hashed_bytes = 0

# On Windows, CPython's st_ctime is creation time, not the NTFS change time.
# Include the native change counter so restoring mtime cannot disguise a writer.
if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    class _FileBasicInfo(ctypes.Structure):
        _fields_ = [(name, ctypes.c_longlong) for name in ("creation", "access", "write", "change")] + [("attributes", wintypes.DWORD)]
    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _create_file = _kernel.CreateFileW
    _create_file.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _create_file.restype = wintypes.HANDLE
    _get_info = _kernel.GetFileInformationByHandleEx
    _get_info.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _get_info.restype = wintypes.BOOL
    _close_handle = _kernel.CloseHandle
    _close_handle.argtypes = [wintypes.HANDLE]
    _close_handle.restype = wintypes.BOOL


def _native_change_time(file):
    if os.name != "nt":
        return None
    handle = _create_file(file, 0x80, 7, None, 3, 0, None)  # read attributes; share read/write/delete
    if handle == wintypes.HANDLE(-1).value:
        raise OSError("File metadata unavailable")
    try:
        info = _FileBasicInfo()
        if not _get_info(handle, 0, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError("File metadata unavailable")
        return info.change
    finally:
        _close_handle(handle)

try:
    with _open(os.environ["KB_TRACE_CONFIG"], encoding="utf-8") as _f:
        _config = json.load(_f)
    _runtime = str(os.getpid()) + "-" + str(uuid.uuid4())
    _log = os.path.join(os.path.dirname(os.environ["KB_TRACE_CONFIG"]), _runtime + ".jsonl")
except Exception:
    pass


def _emit(item):
    try:
        if item.get("kind") in ("write", "conflict") and not _active():
            return
        item.update(runtime=_runtime, pid=os.getpid())
        item.setdefault("time", int(time.time() * 1000))
        with _open(_log, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(item, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _active():
    global _paused
    if _paused:
        return False
    try:
        with _open(_config["gateFile"], encoding="utf-8") as stream:
            gate = json.load(stream)
        control = {"enabled": True, "revision": "initial"}
        if os.path.exists(_config["controlFile"]):
            with _open(_config["controlFile"], encoding="utf-8") as stream:
                control = json.load(stream)
        if gate.get("available") and gate.get("epoch") == _config["epoch"] and gate.get("leaseUntil", 0) >= time.time() * 1000 and control.get("enabled") and control.get("revision") == _config["controlRevision"]:
            return True
    except Exception:
        pass
    _paused = True
    _emit({"kind": "paused"})
    return False


def _within(root, file):
    try:
        return os.path.normcase(os.path.commonpath([root, file])) == os.path.normcase(root)
    except (ValueError, TypeError):
        return False


def _path(value):
    if not _active():
        return None
    try:
        if isinstance(value, int):
            return None
        file = os.path.realpath(os.path.abspath(os.fsdecode(value)))
        root = os.path.realpath(_config["root"])
        if not _within(root, file) or any(_within(os.path.realpath(p), file) for p in _config["excludeRoots"]):
            return None
        if any(re.match(_config.get("excludedPattern", r"^$"), part, re.IGNORECASE) for part in os.path.relpath(file, root).split(os.sep)):
            return None
        return file
    except Exception:
        return None


def _stamp(stat, file):
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, _native_change_time(file))


def _fingerprint(file, expected=None):
    global _hash_reads, _hashed_bytes
    if not _active():
        return None
    try:
        stat = os.stat(file)
        stamp = _stamp(stat, file)
        if not os.path.isfile(file) or expected is not None and stamp != expected:
            return None
        if stat.st_size > _config["maxBytes"]:
            return "oversize"
        digest = hashlib.sha256()
        with _open(file, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                _hashed_bytes += len(chunk)
        _hash_reads += 1
        return digest.hexdigest() if _stamp(os.stat(file), file) == stamp else None
    except Exception:
        return None


def _before(value):
    try:
        file = _path(value)
        if not file:
            return None
        previous = _changed.get(file)
        return (file, previous["before"] if previous else _fingerprint(file))
    except Exception:
        return None


def _mark(item):
    try:
        if item and _active():
            file, before = item
            previous = _changed.get(file)
            _changed[file] = {"before": previous["before"] if previous else before,
                              "expected": _stamp(os.stat(file), file), "time": int(time.time() * 1000)}
    except Exception:
        pass  # Observation errors must never replace the user's result/exception.


def _observe_buffered(handle, item, mode):
    # No proxy objects, subclasses, forced flushes, or extra ownership of handles.
    # Native descriptors (e.g. io.TextIOWrapper.write) keep accepting the object.
    # Observe the raw I/O reached by buffered writes, including descriptor calls.
    try:
        buffer = handle.buffer if type(handle) is io.TextIOWrapper else handle
        if type(buffer) not in (io.BufferedWriter, io.BufferedRandom):
            return  # Unbuffered/custom streams retain their original behavior.
        raw = buffer.raw
        if type(raw) is not io.FileIO or any(name in raw.__dict__ for name in ("write", "truncate")):
            return
        reference = weakref.ref(raw)
        for name in ("write", "truncate"):
            native = getattr(io.FileIO, name)
            def observed(*args, _native=native, **kwargs):
                result = _native(reference(), *args, **kwargs)
                _mark(item)
                return result
            setattr(raw, name, observed)
        _handles.setdefault(item[0], []).append(reference)
        if any(flag in str(mode) for flag in "wx") or "a" in str(mode) and item[1] is None:
            _mark(item)
    except Exception:
        pass


def _wrap_open(original):
    @functools.wraps(original)
    def tracked(file, mode="r", *args, **kwargs):
        item = _before(file) if kwargs.get("opener") is None and any(flag in str(mode) for flag in "wax+") else None
        handle = original(file, mode, *args, **kwargs)
        if item:
            _observe_buffered(handle, item, mode)
        return handle
    return tracked


def _track_os_open(file, flags, *args, **kwargs):
    item = _before(file) if kwargs.get("dir_fd") is None and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC) else None
    fd = _os_open(file, flags, *args, **kwargs)
    if item:
        _fds[fd] = item
        if flags & os.O_TRUNC or flags & os.O_CREAT and item[1] is None:
            _mark(item)
    return fd


def _track_os_write(fd, data):
    result = _os_write(fd, data)
    if result:
        _mark(_fds.get(fd))
    return result


def _track_os_close(fd):
    result = _os_close(fd)
    _fds.pop(fd, None)
    return result


def _finish():
    # No flushing/closing user-owned streams. Unfinished output is not archived.
    for file, record in list(_changed.items()):
        try:
            streams = [ref() for ref in _handles.get(file, [])]
            open_buffer = any(stream is not None and not stream.closed for stream in streams)
            open_fd = any(item[0] == file for item in _fds.values())
            after = None if open_buffer or open_fd else _fingerprint(file, record["expected"])
            if after and after != "oversize":
                _emit(dict(kind="write", path=file, before=record["before"], sha256=after, time=record["time"]))
            elif not after and _active():
                _emit(dict(kind="conflict", path=file, time=record["time"]))
        except Exception:
            _emit(dict(kind="conflict", path=file, time=record["time"]))
    _emit(dict(kind="end", exitCode=_exit_code, hashReads=_hash_reads, hashedBytes=_hashed_bytes))


if _config:
    builtins.open = _wrap_open(_open)
    io.open = _wrap_open(_io_open)
    os.open, os.write, os.close = _track_os_open, _track_os_write, _track_os_close
    for _name in ("rename", "replace"):
        _original = getattr(os, _name)
        def _rename(src, dst, *args, _fn=_original, **kwargs):
            item = _before(dst) if kwargs.get("dst_dir_fd") is None else None
            result = _fn(src, dst, *args, **kwargs)
            _mark(item)
            return result
        setattr(os, _name, _rename)
    _exception_hook = sys.excepthook
    def _exception(*args):
        global _exit_code
        _exit_code = 1
        return _exception_hook(*args)
    sys.excepthook = _exception
    _sys_exit = sys.exit
    def _exit(code=0):
        global _exit_code
        _exit_code = code if isinstance(code, int) else (0 if code is None else 1)
        return _sys_exit(code)
    sys.exit = _exit
    _emit(dict(kind="start", language="python"))
    atexit.register(_finish)
