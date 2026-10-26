"""Read replies over private JSON lines and lazily synthesize local WAV clips.

The desktop owns this bridge and releases it after a short idle period. A valid request loads
the optional Elysia AI configuration and acquires its managed GPT-SoVITS lease.
The lease's non-inherited, kill-on-close Windows Job owns the model process;
terminating this bridge therefore releases its model without touching another
application's service. Each clip waits for playback acknowledgement before the
next synthesis, so the bridge cannot build an unbounded audio queue.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import secrets
import sys
from threading import Thread
import unicodedata
from typing import TextIO


MAX_TEXT_LENGTH = 16_000
MAX_INPUT_BYTES = 128 * 1024
MAX_CLIP_BYTES = 9 * 1024 * 1024
MAX_SEGMENT_LENGTH = 150
sys.dont_write_bytecode = True


class _BridgeError(Exception):
    """Carry only a fixed public failure code, never an upstream exception."""


def _strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise _BridgeError("invalid_request")
        value[key] = item
    return value


def _read_message(limit: int) -> dict[str, object] | None:
    raw = sys.stdin.buffer.readline(limit + 1)
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
        if not project_root.is_absolute() or not (project_root / "config" / "settings.py").is_file():
            raise _BridgeError("assets_unavailable")
        sys.path.insert(0, str(project_root))
        try:
            from config.settings import SETTINGS
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
        _emit(self.output, {"type": "starting", "emotion": emotion})
        try:
            lease = runtime.acquire_lease(selection)
        except Exception:
            runtime.shutdown()
            self.wait_cleanup(5.0)
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
            message = _read_message(256)
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
            try:
                while True:
                    message = _read_message(MAX_INPUT_BYTES)
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
