"""Read replies over private JSON lines and lazily synthesize local WAV clips.

The desktop owns this bridge and releases it after a short idle period. A valid request loads
the optional Elysia AI configuration and acquires its managed GPT-SoVITS lease.
The lease's non-inherited, kill-on-close Windows Job owns the model process;
terminating this bridge therefore releases its model without touching another
application's service. The compatibility adapter borrows an already mounted,
verified volume letter and never creates a DOS drive mapping, including when
the bridge is forcefully terminated. Each clip waits for playback acknowledgement before the
next synthesis, so the bridge cannot build an unbounded audio queue.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import redirect_stderr, redirect_stdout
from collections import deque
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import secrets
import sys
from threading import Condition, RLock, Thread
import unicodedata
from typing import TextIO


MAX_TEXT_LENGTH = 16_000
MAX_INPUT_BYTES = 128 * 1024
MAX_CLIP_BYTES = 9 * 1024 * 1024
MAX_SEGMENT_LENGTH = 150
sys.dont_write_bytecode = True

# Paths remain separate argv values. run_path reads the guarded source file,
# not an unguarded __pycache__ entry. Its returned dictionary is a copy: update
# the actual function globals so the independent Python 3.9 worker accepts C:.
_EXISTING_DRIVE_WORKER_SHIM = r'''
import re, runpy, sys
if len(sys.argv) != 3:
    raise SystemExit(1)
worker_path, import_root = sys.argv[1:]
namespace = runpy.run_path(worker_path, run_name="__elysia_guarded_voice__")
main = namespace.get("_main")
if not callable(main):
    raise SystemExit(1)
scope = main.__globals__
pattern = scope.get("_MAPPED_DRIVE_PATTERN")
if not isinstance(pattern, re.Pattern) or pattern.pattern not in (r"[D-Z]:", r"[C-Z]:") or pattern.flags != re.compile(r"[D-Z]:", re.IGNORECASE).flags:
    raise SystemExit(1)
scope["_MAPPED_DRIVE_PATTERN"] = re.compile(r"[C-Z]:", re.IGNORECASE)
sys.argv = [worker_path, import_root]
raise SystemExit(main())
'''


class _BridgeError(Exception):
    """Carry only a fixed public failure code, never an upstream exception."""


def _use_existing_volume_drives(runtime: object) -> None:
    """Adapt the pinned runtime without writing its files or owning drive letters.

    Its CPython 3.9 extension loader needs a DOS spelling rather than a Volume
    GUID spelling. A verified existing letter supplies exactly that spelling;
    Unicode and long suffixes, source guards and native image checks remain the
    upstream implementation's responsibility. Folder-only mounts, SUBST paths,
    network mappings and mismatched volumes never cause a new mapping.
    """
    if getattr(runtime, "_elysia_existing_drive_adapter", None) is _use_existing_volume_drives:
        return
    try:
        base = runtime._DosDeviceMapping
        pattern = runtime._MAPPED_DRIVE_PATH_PATTERN
        launcher = runtime.launch_windows_managed_process
        if (
            not isinstance(base, type)
            or tuple(base.__slots__) != ("_active", "_drive", "_native_target", "_volume_root")
            or not all(callable(getattr(base, name, None)) for name in ("path_for", "native_path_for", "verify", "close"))
            or not isinstance(pattern, re.Pattern)
            or pattern.pattern not in (r"[D-Z]:\\.+\Z", r"[C-Z]:\\.+\Z")
            or pattern.flags != re.compile(r"[D-Z]:\\.+\Z", re.IGNORECASE).flags
            or not all(callable(getattr(runtime, name, None)) for name in (
                "_volume_mapping_identity", "_logical_drive_mask", "_query_dos_device", "_query_volume_name",
                "_create_dos_device_mapping", "launch_windows_managed_process", "ManagedGptSovitsStartupError",
            ))
            or not hasattr(runtime._DOS_DEVICE_LOCK, "__enter__")
        ):
            raise _BridgeError("runtime_unavailable")
    except (AttributeError, TypeError):
        raise _BridgeError("runtime_unavailable") from None

    class _ExistingVolumeMapping(base):
        __slots__ = ()

        def close(self) -> None:
            # This mapping belongs to Windows/the user, not this bridge. In
            # particular, never invoke the upstream DefineDosDevice remover.
            with runtime._DOS_DEVICE_LOCK:
                self._active = False

    def borrow(path: Path) -> object:
        volume_name, native_target = runtime._volume_mapping_identity(path)
        expected_root = "\\\\?\\" + volume_name + "\\"
        with runtime._DOS_DEVICE_LOCK:
            occupied = runtime._logical_drive_mask()
            for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
                if not occupied & (1 << (ord(letter) - ord("A"))):
                    continue
                drive = letter + ":"
                try:
                    if runtime._query_dos_device(drive) != (native_target,):
                        continue
                    if runtime._query_volume_name(drive + "\\").casefold() != expected_root.casefold():
                        continue
                    mapping = _ExistingVolumeMapping(drive, native_target, expected_root)
                    mapping.verify()
                    return mapping
                except runtime.ManagedGptSovitsStartupError:
                    continue
        raise runtime.ManagedGptSovitsStartupError(runtime._STARTUP_MESSAGE)

    def launch(argv: object, **options: object) -> object:
        if (
            type(argv) not in (list, tuple) or len(argv) != 6
            or list(argv[1:4]) != ["-I", "-B", "-u"]
            or not all(type(value) is str and "\x00" not in value for value in argv)
        ):
            raise _BridgeError("runtime_unavailable")
        # Keep the original executable, guarded script, Job launcher, cwd,
        # inherited protocol handles and closed environment unchanged.
        return launcher([*argv[:4], "-c", _EXISTING_DRIVE_WORKER_SHIM, *argv[4:]], **options)

    runtime._MAPPED_DRIVE_PATH_PATTERN = re.compile(r"[C-Z]:\\.+\Z", re.IGNORECASE)
    runtime._create_dos_device_mapping = borrow
    runtime.launch_windows_managed_process = launch
    runtime._elysia_existing_drive_adapter = _use_existing_volume_drives


def _strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise _BridgeError("invalid_request")
        value[key] = item
    return value


def _read_message(limit: int) -> dict[str, object] | None:
    raw = sys.stdin.buffer.readline(limit + 1)
    return _parse_message(raw, limit)


def _parse_message(raw: bytes, limit: int) -> dict[str, object] | None:
    if not raw:
        return None
    if len(raw) > limit or not raw.endswith(b"\n"):
        raise _BridgeError("invalid_request")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_strict_object)
    except (ValueError, UnicodeError, RecursionError):
        raise _BridgeError("invalid_request") from None
    if type(value) is not dict:
        raise _BridgeError("invalid_request")
    return value


class _PipeFrames:
    """Read raw stdin without holding CPython's buffered-stdin finalizer lock."""

    def __init__(self, descriptor: int) -> None:
        self._descriptor = descriptor
        self._buffer = bytearray()

    def readline(self, limit: int) -> bytes:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0 or len(self._buffer) >= limit:
                end = min(newline + 1 if newline >= 0 else limit, limit)
                raw = bytes(self._buffer[:end])
                del self._buffer[:end]
                return raw
            chunk = os.read(self._descriptor, min(4096, limit - len(self._buffer)))
            if not chunk:
                raw = bytes(self._buffer)
                self._buffer.clear()
                return raw
            self._buffer.extend(chunk)


class _InputChannel:
    """Observe EOF even while the main thread is blocked in model inference.

    The desktop closes this private pipe to cancel. Only the registered runtime
    owner is shut down; no files or processes are discovered by name. At most
    warmup and one speak request may be waiting behind the active operation.
    """

    def __init__(self, stream: object) -> None:
        self._condition = Condition(RLock())
        self._pending: deque[bytes] = deque()
        self._closed = False
        self._error: _BridgeError | None = None
        self._session = None
        self._stream = stream
        Thread(target=self._pump, name="pet-tts-input", daemon=True).start()

    def attach(self, session: object) -> None:
        with self._condition:
            self._session = session
            closed = self._closed
        if closed:
            session.cancel()

    def _finish(self, error: _BridgeError | None = None) -> None:
        with self._condition:
            self._closed = True
            self._error = error
            self._pending.clear()
            session = self._session
            self._condition.notify_all()
        if session is not None:
            session.cancel()

    def _pump(self) -> None:
        try:
            while True:
                raw = self._stream.readline(MAX_INPUT_BYTES + 1)
                if not raw:
                    self._finish()
                    return
                # Reject malformed/oversized frames before they can accumulate.
                _parse_message(raw, MAX_INPUT_BYTES)
                with self._condition:
                    if len(self._pending) >= 2:
                        raise _BridgeError("invalid_request")
                    self._pending.append(raw)
                    self._condition.notify_all()
        except Exception:
            self._finish(_BridgeError("invalid_request"))

    def read(self, limit: int) -> dict[str, object] | None:
        with self._condition:
            while not self._closed and not self._pending:
                self._condition.wait()
            if self._closed:
                if self._error is not None:
                    raise self._error
                return None
            raw = self._pending.popleft()
        return _parse_message(raw, limit)


def _emit(output: TextIO, value: dict[str, object]) -> None:
    output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    output.flush()


def _watch_parents(owner_pid: int | None) -> None:
    """Exit when the spawned parent dies, including Windows venv redirectors.

    A venv python.exe can launch the real interpreter as its own child. Node's
    kill then targets that redirector, not the interpreter holding our model's
    Job handle. Waiting on the exact parent process handle closes this gap:
    interpreter exit closes its non-inherited Job and kills only our model.
    """
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    if owner_pid is not None and (not 0 < owner_pid <= 0xFFFFFFFF or owner_pid == os.getpid()):
        raise _BridgeError("invalid_request")
    parents = {os.getppid()}
    if owner_pid is not None:
        parents.add(owner_pid)
    handles = []
    for pid in parents:
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            for opened in handles:
                kernel.CloseHandle(opened)
            raise _BridgeError("runtime_unavailable")
        handles.append(handle)

    def wait(handle: object) -> None:
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        kernel.CloseHandle(handle)
        # A forced parent termination cannot run a reliable Python cleanup
        # handshake; OS handle teardown is the Job's authoritative fallback.
        os._exit(0)

    for handle in handles:
        Thread(target=wait, args=(handle,), name="pet-tts-parent", daemon=True).start()


def _spoken_text(text: str) -> str:
    """Remove presentation markup without changing the stored chat response."""
    lines: list[str] = []
    fence: tuple[str, int] | None = None
    for line in text.splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            sequence = marker.group(1)
            if fence is None:
                fence = (sequence[0], len(sequence))
            elif sequence[0] == fence[0] and len(sequence) >= fence[1]:
                fence = None
            continue
        if fence is None:
            lines.append(line)
    plain = "\n".join(lines)
    plain = re.sub(r"!\[[^\]\n]*\]\([^\n)]*\)", "", plain)
    plain = re.sub(r"\[([^\]\n]+)\]\([^\n)]*\)", r"\1", plain)
    plain = re.sub(r"<[^>\n]*>", "", plain)
    plain = re.sub(r"(?:https?://|www\.)[^\s<>]+", "", plain)
    plain = re.sub(r"(?m)^\s*(?:[-*_]\s*){3,}$", "", plain)
    plain = re.sub(r"(?m)^\s*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?\s*$", "", plain)
    plain = re.sub(r"(?m)^\s*(?:#{1,6}\s+|>+\s*|[-+*]\s+|\d+[.)]\s+)", "", plain)
    plain = re.sub(r"(?m)^\s*\[[ xX]\]\s*", "", plain)
    plain = re.sub(r"[0-9#*]\ufe0f?\u20e3", "", plain)
    plain = re.sub(r"[`*_~|]", "", plain)
    # Emoji, variation selectors and format-only glyphs have no dependable
    # pronunciation and must not create punctuation-only inference requests.
    plain = "".join(character for character in plain if (
        character in "\n\t" or (
            unicodedata.category(character) not in {"So", "Sk", "Cf", "Cs", "Cc"}
            and not (0xFE00 <= ord(character) <= 0xFE0F or 0xE0100 <= ord(character) <= 0xE01EF)
        )
    ))
    plain = re.sub(r"[^\S\n]+", " ", plain)
    return re.sub(r"\n{3,}", "\n\n", plain).strip()


def _segments(text: str) -> list[str]:
    """Keep the first clip short, then prefer sentences within 150 code points."""
    remainder = _spoken_text(text)
    result: list[str] = []
    while remainder:
        limit = 70 if not result else MAX_SEGMENT_LENGTH
        candidate = remainder[:limit]
        natural = list(re.finditer(r"[。！？!?；;\n][”’\"」』）)]*", candidate))
        if natural:
            cut = natural[-1].end()
        elif len(remainder) <= limit:
            cut = len(remainder)
        else:
            soft = list(re.finditer(r"[，,、：:\s]", candidate))
            cut = soft[-1].end() if soft and soft[-1].end() >= min(30, limit) else limit
        segment, remainder = remainder[:cut].strip(), remainder[cut:].lstrip()
        if any(unicodedata.category(character)[0] in {"L", "N"} for character in segment):
            result.append(segment)
    return result


def _select_emotion(text: str, available: set[str]) -> str:
    """Pet-only conservative rules; the source project uses a fixed preference.

    Only supported, catalogued reference recordings may be selected. Negation,
    comfort, and conflicting signals take precedence over celebratory keywords.
    Punctuation alone never chooses an emotion.
    """
    plain = _spoken_text(text)
    negative = bool(re.search(r"难过|难受|伤心|悲伤|失落|痛苦|委屈|孤单|孤独|哭|生病|不开心|不高兴|不是.{0,3}开心|并非.{0,3}开心", plain))
    comfort = bool(re.search(r"我(?:会|一直|就)?(?:陪着你|陪你|在这里)|别(?:太)?勉强|不必勉强|慢慢来|辛苦了|抱抱你|愿意听你|你可以依赖|好好休息|照顾好自己", plain))
    negated_happy = bool(re.search(r"(?:不|没|并非|不是|谈不上)[^。！？!?，,]{0,5}(?:开心|高兴|快乐|喜悦|好消息|太棒|恭喜)", plain))
    happy = bool(re.search(r"真(?:的)?(?:令人)?(?:开心|高兴)|太(?:开心|高兴|棒)了|好消息|恭喜|值得庆祝|成功了|真为你(?:开心|高兴)", plain))
    serious = bool(re.search(r"请立即(?:停止|远离|拨打|就医)|安全(?:最重要|第一)|有生命危险|紧急情况", plain))
    moved = bool(re.search(r"很感动|深受感动|谢谢你一直|这份心意", plain))
    if serious:
        chosen = "serious"
    elif comfort and not (happy and not negative):
        chosen = "caring"
    elif negative and happy and not negated_happy:
        chosen = "neutral"
    elif negative:
        chosen = "sad"
    elif happy and not negated_happy:
        chosen = "happy"
    elif moved:
        chosen = "moved"
    else:
        chosen = "neutral"
    return chosen if chosen in available else "neutral"


def _voice_preferences(settings: object) -> tuple[str, float]:
    """Read only the two useful saved preferences; never migrate or write them."""
    profile = settings.voice_profile_id
    speed = settings.speech_rate_percent
    try:
        location = settings.data_layout.settings / "global.json"
        if location.is_file() and location.stat().st_size <= 128 * 1024:
            document = json.loads(location.read_text(encoding="utf-8"))
            values = document.get("settings", {})
            candidate = values.get("voice_profile_id")
            if type(candidate) is str and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", candidate):
                profile = candidate
            candidate = values.get("speech_rate_percent")
            if type(candidate) is int and 50 <= candidate <= 200:
                speed = candidate
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return profile, speed / 100.0


class _SpeechSession:
    """Reuse one emotion-bound lease, respecting the runtime's global owner gate."""

    def __init__(self, project_root: Path, device: str, output: TextIO) -> None:
        self.output = output
        self.pool: dict[str, tuple[object, object]] = {}
        self.read_message = _read_message
        self._runtime_lock = RLock()
        self._runtimes: set[object] = set()
        self._closing = False
        if not project_root.is_absolute() or not (project_root / "config" / "settings.py").is_file():
            raise _BridgeError("assets_unavailable")
        sys.path.insert(0, str(project_root))
        try:
            from config.settings import SETTINGS
            from voice import managed_gpt_sovits
            _use_existing_volume_drives(managed_gpt_sovits)
            from voice.managed_gpt_sovits import (
                ManagedGptSovitsConfig, ManagedGptSovitsRuntime, wait_for_managed_cleanup,
            )
            from voice.profiles import JsonVoiceProfileCatalog
        except Exception:
            raise _BridgeError("runtime_unavailable") from None
        self.runtime_factory = ManagedGptSovitsRuntime
        self.wait_cleanup = wait_for_managed_cleanup
        # The source runtime deliberately reserves one production owner per
        # interpreter. Switching emotion must release that owner first; keeping
        # multiple models would also double the user's resident memory.
        self.capacity = 1
        try:
            models_root = SETTINGS.model_assets_root
            self.catalog = JsonVoiceProfileCatalog.load(
                SETTINGS.data_layout.settings / "voice-profiles.json",
                models_root / "weights" / "gpt-sovits",
                allow_local_evaluation=SETTINGS.gpt_sovits_allow_local_evaluation,
            )
            self.profile_id, self.speed = _voice_preferences(SETTINGS)
            neutral = self.catalog.resolve_selection(self.profile_id, "neutral")
            self.profile_id = neutral.profile_id
            self.available = next(set(item.emotions) for item in self.catalog.summaries() if item.profile_id == self.profile_id)
            self.config = ManagedGptSovitsConfig(
                runtime_root=models_root / "cache" / "GPT-SoVITS-v2-240821",
                worker_script=project_root / "scripts" / "gpt_sovits_worker.py",
                startup_timeout_seconds=300.0, synthesis_timeout_seconds=180.0,
                stop_timeout_seconds=5.0, device=device, seed=SETTINGS.gpt_sovits_deterministic_seed,
            )
        except Exception:
            raise _BridgeError("assets_unavailable") from None

    def _close_entry(self, entry: tuple[object, object]) -> None:
        runtime, lease = entry
        try:
            lease.close()
        finally:
            runtime.shutdown()
        if not self.wait_cleanup(5.0):
            raise _BridgeError("cleanup_failed")
        # Emotion changes replace the sole runtime. Keep failed cleanup owners
        # reachable for cancellation, but release confirmed closed owners so a
        # long conversation does not retain every historical runtime object.
        with self._runtime_lock:
            self._runtimes.discard(runtime)

    def cancel(self) -> None:
        # Upstream shutdown atomically detaches starting/active resources and
        # performs process-first cleanup, including when synthesis is blocked.
        with self._runtime_lock:
            self._closing = True
            runtimes = tuple(self._runtimes)
        for runtime in runtimes:
            try:
                runtime.shutdown()
            except Exception:
                pass  # Main-thread close still checks the cleanup barrier.

    def close(self) -> None:
        entries, self.pool = list(self.pool.values()), {}
        failure = None
        for entry in entries:
            try:
                self._close_entry(entry)
            except Exception as error:
                failure = error
        if failure:
            raise _BridgeError("cleanup_failed") from None

    def lease(self, emotion: str) -> object:
        if emotion in self.pool:
            entry = self.pool.pop(emotion)
            self.pool[emotion] = entry
            return entry[1]
        if len(self.pool) >= self.capacity:
            oldest = next(iter(self.pool))
            self._close_entry(self.pool.pop(oldest))
        try:
            selection = replace(self.catalog.resolve_selection(self.profile_id, emotion), speed_factor=self.speed)
        except Exception:
            raise _BridgeError("assets_unavailable") from None
        runtime = self.runtime_factory(self.config)
        with self._runtime_lock:
            closing = self._closing
            if not closing:
                self._runtimes.add(runtime)
        if closing:
            runtime.shutdown()
            raise EOFError()
        _emit(self.output, {"type": "starting", "emotion": emotion})
        try:
            lease = runtime.acquire_lease(selection)
        except Exception:
            runtime.shutdown()
            if self.wait_cleanup(5.0):
                with self._runtime_lock:
                    self._runtimes.discard(runtime)
            raise _BridgeError("runtime_unavailable") from None
        self.pool[emotion] = (runtime, lease)
        return lease

    def warmup(self) -> None:
        self.lease("neutral")
        _emit(self.output, {"type": "ready", "emotion": "neutral"})

    def speak(self, text: str, segments: list[str]) -> bool:
        emotion = _select_emotion(text, self.available)
        lease = self.lease(emotion)
        for segment in segments:
            _emit(self.output, {"type": "synthesizing", "emotion": emotion})
            try:
                result = lease.synthesize(segment, "auto", secrets.token_hex(32))
            except Exception:
                raise _BridgeError("synthesis_failed") from None
            if len(result.audio) > MAX_CLIP_BYTES:
                raise _BridgeError("audio_too_large")
            _emit(self.output, {
                "type": "audio", "mime": "audio/wav", "emotion": emotion,
                "base64": base64.b64encode(result.audio).decode("ascii"),
            })
            message = self.read_message(256)
            if message is None:
                return False
            if message != {"type": "next"}:
                raise _BridgeError("invalid_request")
        _emit(self.output, {"type": "done", "emotion": emotion})
        return True


def main() -> int:
    """Serve bounded requests until EOF; the desktop owns the short idle timer."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--project-root", default=r"D:\Elysia_AI")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--parent-pid", type=int)
    output = sys.stdout
    output.reconfigure(encoding="utf-8", errors="strict", newline="\n")
    session = None
    try:
        with open(os.devnull, "w", encoding="utf-8") as sink, redirect_stdout(sink), redirect_stderr(sink):
            try:
                args = parser.parse_args()
            except SystemExit:
                raise _BridgeError("invalid_request") from None
            _watch_parents(args.parent_pid)
            channel = _InputChannel(_PipeFrames(sys.stdin.fileno()))
            try:
                while True:
                    message = channel.read(MAX_INPUT_BYTES)
                    if message is None:
                        break
                    warming = message == {"type": "warmup"}
                    if not warming:
                        if set(message) != {"type", "text"} or message["type"] != "speak" or type(message["text"]) is not str:
                            raise _BridgeError("invalid_request")
                        text = message["text"]
                        if len(text) > MAX_TEXT_LENGTH:
                            raise _BridgeError("invalid_request")
                        segments = _segments(text)
                        if not segments:
                            raise _BridgeError("no_speech")
                    if session is None:
                        session = _SpeechSession(Path(args.project_root), args.device, output)
                        session.read_message = channel.read
                        channel.attach(session)
                    if warming:
                        session.warmup()
                    elif not session.speak(text, segments):
                        break
            finally:
                if session is not None:
                    session.close()
        return 0
    except (BrokenPipeError, EOFError):
        return 0
    except _BridgeError as error:
        try:
            _emit(output, {"type": "error", "code": str(error)})
        except (BrokenPipeError, OSError):
            pass
        return 1
    except BaseException:
        try:
            _emit(output, {"type": "error", "code": "worker_failed"})
        except (BrokenPipeError, OSError):
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
