"""Per-command write observations. No directory scans or file contents in the journal."""
import atexit
import builtins
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

_open = builtins.open
_io_open = io.open
_os_open = os.open
_os_write = os.write
_os_close = os.close
_exit_code = 0
_changed = {}
_initial = {}
_dirty = set()
_fds = {}
_handles = []
_log = None
_config = None
_paused = False
try:
    with _open(os.environ["KB_TRACE_CONFIG"], encoding="utf-8") as _f:
        _config = json.load(_f)
    _runtime = str(os.getpid()) + "-" + str(uuid.uuid4())
    _log = os.path.join(os.path.dirname(os.environ["KB_TRACE_CONFIG"]), _runtime + ".jsonl")
except Exception:
    pass

def _emit(item):
    try:
        if item.get('kind') == 'write' and not _active():
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
        with _open(_config['gateFile'], encoding='utf-8') as f:
            gate = json.load(f)
        control = {'enabled': True, 'revision': 'initial'}
        if os.path.exists(_config['controlFile']):
            with _open(_config['controlFile'], encoding='utf-8') as f:
                control = json.load(f)
        if gate.get('available') and gate.get('epoch') == _config['epoch'] and gate.get('leaseUntil', 0) >= time.time() * 1000 and control.get('enabled') and control.get('revision') == _config['controlRevision']:
            return True
    except Exception:
        pass
    _paused = True
    _emit({'kind': 'paused'})
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

def _fingerprint(file):
    if not _active():
        return None
    try:
        if not os.path.isfile(file):
            return None
        size = os.path.getsize(file)
        if size > _config["maxBytes"]:
            return "oversize"
        with _open(file, "rb") as stream:
            return hashlib.sha256(stream.read()).hexdigest()
    except Exception:
        return None

def _before(value):
    file = _path(value)
    return (file, _fingerprint(file)) if file else None

def _mark(item):
    if item:
        _initial.setdefault(item[0], item[1])
        _dirty.add(item[0])

def _snapshot(item):
    if item and item[0] in _dirty:
        file = item[0]
        _changed[file] = (_initial[file], _fingerprint(file), int(time.time() * 1000))
        _dirty.discard(file)

class _TrackedFile:
    """File-like adapter that snapshots on real flush/close without retaining files."""
    def __init__(self, stream, item, owns=True):
        self._stream = stream
        self._item = item
        self._owns = owns
        self._children = {}
    @property
    def __class__(self):
        return self._stream.__class__
    def __getattr__(self, name):
        value = getattr(self._stream, name)
        if name in ("buffer", "raw"):
            if name not in self._children:
                self._children[name] = _TrackedFile(value, self._item, False)
            return self._children[name]
        return value
    def __enter__(self):
        self._stream.__enter__()
        return self
    def __exit__(self, *args):
        self.close()
        return False
    def __iter__(self):
        return self
    def __next__(self):
        return next(self._stream)
    def write(self, data):
        result = self._stream.write(data)
        _mark(self._item)
        return result
    def writelines(self, lines):
        result = self._stream.writelines(lines)
        _mark(self._item)
        return result
    def truncate(self, *args):
        result = self._stream.truncate(*args)
        _mark(self._item)
        return result
    def flush(self):
        result = self._stream.flush()
        _snapshot(self._item)
        return result
    def close(self):
        result = self._stream.close()
        _snapshot(self._item)
        return result
    def __del__(self):
        if self._owns:
            try:
                self.close()
            except Exception:
                pass

def _wrap_open(original):
    def tracked(file, mode="r", *args, **kwargs):
        item = _before(file) if any(c in str(mode) for c in "wax+") else None
        handle = original(file, mode, *args, **kwargs)
        if item:
            if any(c in str(mode) for c in "wx") or ("a" in str(mode) and item[1] is None):
                _mark(item)
                _snapshot(item)
            handle = _TrackedFile(handle, item)
            _handles.append(weakref.ref(handle))
        return handle
    return tracked

def _track_os_open(file, flags, *args, **kwargs):
    item = _before(file)
    fd = _os_open(file, flags, *args, **kwargs)
    if item:
        _fds[fd] = item
        if flags & os.O_TRUNC or (flags & os.O_CREAT and item[1] is None):
            _mark(item)
            _snapshot(item)
    return fd

def _track_os_write(fd, data):
    result = _os_write(fd, data)
    if result:
        _mark(_fds.get(fd))
        _snapshot(_fds.get(fd))
    return result

def _track_os_close(fd):
    try:
        return _os_close(fd)
    finally:
        _fds.pop(fd, None)

def _finish():
    for reference in _handles:
        try:
            handle = reference()
            if handle is not None:
                handle.flush()
        except Exception:
            pass
    for file, (before, after, captured_at) in list(_changed.items()):
        if after and after != "oversize":
            _emit(dict(kind="write", path=file, before=before, sha256=after, time=captured_at))
    _emit(dict(kind="end", exitCode=_exit_code))

if _config:
    builtins.open = _wrap_open(_open)
    io.open = _wrap_open(_io_open)
    os.open = _track_os_open
    os.write = _track_os_write
    os.close = _track_os_close
    for _name in ("rename", "replace"):
        _original = getattr(os, _name)
        def _rename(src, dst, *args, _fn=_original, **kwargs):
            item = _before(dst)
            result = _fn(src, dst, *args, **kwargs)
            _mark(item)
            _snapshot(item)
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
