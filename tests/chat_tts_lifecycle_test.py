"""Exercise bridge EOF cancellation using tiny fake runtimes, never model assets."""
from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import gc
import io
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
from threading import Event, RLock, Thread
from types import SimpleNamespace
import unittest
import weakref

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("pet_tts_lifecycle", ROOT / "electron/chat-tts-worker.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


@dataclass
class Selection:
    speed_factor: float = 1.0


def session_fixture(factory):
    session = object.__new__(bridge._SpeechSession)
    session.output = io.StringIO()
    session.pool, session.capacity, session.config = {}, 1, None
    session.runtime_factory = factory
    session.wait_cleanup = lambda _: True
    session.catalog = SimpleNamespace(resolve_selection=lambda *_: Selection())
    session.profile_id, session.speed = "test", 1.0
    session._runtime_lock, session._runtimes, session._closing = RLock(), set(), False
    return session


class InputStream:
    def __init__(self):
        self.frames = queue.Queue()

    def readline(self, limit):
        return self.frames.get(timeout=3)


CHILD = r'''
import importlib.util, json, sys
from dataclasses import dataclass
from pathlib import Path
from threading import Event, RLock
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("pet_test_bridge", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
folder, mode = Path(sys.argv[2]), sys.argv[3]
marker = folder / "owned-bootstrap-copy.bin"
@dataclass
class Selection:
    speed_factor: float = 1.0
class Runtime:
    def __init__(self, config):
        self.stopped = Event()
    def acquire_lease(self, selection):
        marker.write_bytes(b"owned tiny test fixture")
        if mode == "startup":
            m._emit(output, {"type": "test-startup"})
            if not self.stopped.wait(5): raise RuntimeError("startup was not cancelled")
            raise RuntimeError("cancelled")
        return self
    def synthesize(self, *args):
        m._emit(output, {"type": "test-inference"})
        if not self.stopped.wait(5): raise RuntimeError("inference was not cancelled")
        raise RuntimeError("cancelled")
    def close(self): pass
    def shutdown(self):
        self.stopped.set()
        marker.unlink(missing_ok=True)
class Session(m._SpeechSession):
    def __init__(self, project, device, destination):
        if mode == "failure": raise m._BridgeError("assets_unavailable")
        self.output = destination
        self.pool, self.capacity, self.config = {}, 1, None
        self.runtime_factory = Runtime
        self.wait_cleanup = lambda _: not marker.exists()
        self.catalog = SimpleNamespace(resolve_selection=lambda *_: Selection())
        self.profile_id, self.speed, self.available = "test", 1.0, {"neutral"}
        self._runtime_lock, self._runtimes, self._closing = RLock(), set(), False
        self.read_message = m._read_message
output = sys.stdout
m._SpeechSession, m._watch_parents = Session, lambda _: None
sys.argv = [sys.argv[0], "--project-root", str(folder)]
raise SystemExit(m.main())
'''


class LifecycleTests(unittest.TestCase):
    def test_repeated_emotion_changes_release_closed_runtime_references(self):
        references, closed = [], []
        class Runtime:
            def __init__(self, _):
                self.number = len(references)
                references.append(weakref.ref(self))
            def acquire_lease(self, _):
                return SimpleNamespace(close=lambda: None)
            def shutdown(self):
                closed.append(self.number)
        session = session_fixture(Runtime)
        for index in range(100):
            session.lease("happy" if index % 2 else "neutral")
            self.assertEqual(len(session._runtimes), 1)
        gc.collect()
        self.assertEqual(sum(reference() is not None for reference in references), 1)
        session.cancel(); session.close(); gc.collect()
        self.assertEqual(len(session._runtimes), 0)
        self.assertFalse(any(reference() is not None for reference in references))
        self.assertEqual(len(closed), 101, "cancel revisits only the current owner")

    def test_failed_cleanup_keeps_the_runtime_reachable_for_cancellation(self):
        stopped = []
        class Runtime:
            def __init__(self, _): pass
            def acquire_lease(self, _): return SimpleNamespace(close=lambda: None)
            def shutdown(self): stopped.append(True)
        session = session_fixture(Runtime)
        session.lease("neutral")
        session.wait_cleanup = lambda _: False
        with self.assertRaises(bridge._BridgeError): session.lease("happy")
        self.assertEqual(len(session._runtimes), 1)
        session.cancel()
        self.assertEqual(len(stopped), 2)

    def test_eof_interrupts_idle_startup_and_inference_and_removes_owned_fixture(self):
        temp_root = ROOT / "artifacts" / "chat-lifecycle-tests" / "temp"
        temp_root.mkdir(parents=True, exist_ok=True)
        for mode, expected in (("idle", "ready"), ("startup", "test-startup"), ("inference", "test-inference"), ("failure", "error")):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir=temp_root, prefix="用户 EOF ") as folder:
                child = subprocess.Popen(
                    [sys.executable, "-B", "-u", "-c", CHILD, str(ROOT / "electron/chat-tts-worker.py"), folder, mode],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding="utf-8", cwd=folder,
                )
                try:
                    packet = {"type": "speak", "text": "你好。"} if mode == "inference" else {"type": "warmup"}
                    child.stdin.write(json.dumps(packet) + "\n"); child.stdin.flush()
                    messages = queue.Queue()
                    def receive():
                        for line in child.stdout:
                            messages.put(json.loads(line))
                    reader = Thread(target=receive, daemon=True); reader.start()
                    while messages.get(timeout=3)["type"] != expected:
                        pass
                    if mode != "failure":
                        self.assertTrue((Path(folder) / "owned-bootstrap-copy.bin").is_file())
                        child.stdin.close(); child.stdin = None
                    # A startup failure must also exit cleanly while its parent
                    # still holds stdin open: no daemon BufferedReader lock.
                    child.wait(timeout=3)
                    reader.join(timeout=1)
                    self.assertFalse((Path(folder) / "owned-bootstrap-copy.bin").exists())
                    self.assertIn(child.returncode, (0, 1))
                    self.assertEqual(child.stderr.read(), "")
                finally:
                    if child.poll() is None:
                        child.kill(); child.wait(timeout=3)
                    for pipe in (child.stdin, child.stdout, child.stderr):
                        if pipe is not None:
                            pipe.close()

    def test_cancellation_before_factory_returns_cannot_start_a_model(self):
        entered, resume, stopped = Event(), Event(), Event()
        calls, failures = [], []
        runtime = SimpleNamespace(shutdown=lambda: stopped.set(), acquire_lease=lambda _: calls.append("acquire"))
        def factory(_):
            entered.set(); self.assertTrue(resume.wait(3)); return runtime
        session = session_fixture(factory)
        def acquire():
            try: session.lease("neutral")
            except EOFError: failures.append("cancelled")
        thread = Thread(target=acquire); thread.start()
        self.assertTrue(entered.wait(3)); session.cancel(); resume.set(); thread.join(timeout=3)
        self.assertFalse(thread.is_alive()); self.assertEqual(calls, [])
        self.assertEqual(failures, ["cancelled"]); self.assertTrue(stopped.is_set())

    def test_input_bounds_and_eof_before_attach_still_cancel_session(self):
        for frame in (b"", b"x" * (bridge.MAX_INPUT_BYTES + 1), b'{"type":"next","type":"next"}\n'):
            stream = InputStream(); stream.frames.put(frame)
            channel = bridge._InputChannel(stream)
            if frame:
                with self.assertRaises(bridge._BridgeError): channel.read(256)
            else:
                self.assertIsNone(channel.read(256))
            cancelled = Event(); channel.attach(SimpleNamespace(cancel=cancelled.set))
            self.assertTrue(cancelled.is_set())

    def test_acknowledgements_keep_the_tighter_frame_limit(self):
        stream = InputStream()
        channel = bridge._InputChannel(stream)
        stream.frames.put(json.dumps({"type": "next", "extra": "x" * 300}).encode() + b"\n")
        with self.assertRaises(bridge._BridgeError): channel.read(256)
        stream.frames.put(b"")


if __name__ == "__main__":
    unittest.main()
