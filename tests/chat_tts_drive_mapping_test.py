"""Mock-only volume compatibility checks: never call a real DOS mapping API."""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import ntpath
from pathlib import Path, PureWindowsPath
import re
import subprocess
import sys
import tempfile
from threading import RLock
from types import ModuleType
import unittest
import zipfile


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("pet_tts_bridge", ROOT / "electron/chat-tts-worker.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)
VOLUME = "Volume{12345678-1234-1234-1234-123456789abc}"
VOLUME_ROOT = "\\\\?\\" + VOLUME + "\\"
TARGET = r"\Device\HarddiskVolume4"
RUNTIME = PureWindowsPath(VOLUME_ROOT + r"Users\用户\Desktop Pet\models\runtime")


class StartupError(Exception):
    pass


def runtime_fixture():
    runtime = ModuleType("mock_managed_runtime")
    devices = {VOLUME: (TARGET,), "C:": (TARGET,)}
    volumes = {"C:\\": VOLUME_ROOT}
    mutations, launches = [], []

    def define(*args):
        mutations.append(args)
        raise AssertionError("Neither creating nor removing a DOS mapping is allowed")

    class Mapping:
        __slots__ = ("_active", "_drive", "_native_target", "_volume_root")

        def __init__(self, drive, target, volume):
            self._active, self._drive, self._native_target, self._volume_root = True, drive, target, volume

        @property
        def drive(self):
            return self._drive

        def path_for(self, path):
            value = str(path)
            if not value.startswith(self._volume_root):
                raise StartupError("wrong volume")
            return self.drive + "\\" + value[len(self._volume_root):]

        def native_path_for(self, path):
            return self._native_target + self.path_for(path)[2:]

        def verify(self):
            if not self._active or devices.get(self.drive) != (self._native_target,) or volumes.get(self.drive + "\\") != self._volume_root:
                raise StartupError("mapping changed")

        def close(self):
            define(15, self.drive, self._native_target)

    runtime._DosDeviceMapping = Mapping
    runtime._MAPPED_DRIVE_PATH_PATTERN = re.compile(r"[D-Z]:\\.+\Z", re.IGNORECASE)
    runtime._DOS_DEVICE_LOCK = RLock()
    runtime._volume_mapping_identity = lambda path: (VOLUME, TARGET)
    runtime._logical_drive_mask = lambda: sum(1 << (ord(name[0]) - ord("A")) for name in devices if re.fullmatch("[A-Z]:", name))
    runtime._query_dos_device = lambda name: devices.get(name, ())
    runtime._query_volume_name = lambda name: volumes.get(name, "")
    runtime._define_dos_device = define
    runtime._create_dos_device_mapping = lambda path: define(9, "Z:", TARGET)
    runtime.launch_windows_managed_process = lambda argv, **kwargs: launches.append((argv, kwargs)) or "owned-process"
    runtime.ManagedGptSovitsStartupError = StartupError
    runtime._STARTUP_MESSAGE = "runtime unavailable"
    return runtime, devices, volumes, mutations, launches


class DriveCompatibilityTests(unittest.TestCase):
    def test_existing_c_and_d_work_without_changing_device_namespace(self):
        for letter in ("C", "D"):
            runtime, devices, volumes, mutations, _ = runtime_fixture()
            devices.pop("C:")
            devices[letter + ":"] = (TARGET,)
            volumes.clear()
            volumes[letter + ":\\"] = VOLUME_ROOT
            before = dict(devices)
            bridge._use_existing_volume_drives(runtime)
            mapping = runtime._create_dos_device_mapping(RUNTIME)
            self.assertEqual(mapping.drive, letter + ":")
            for path in (RUNTIME, RUNTIME / ("中文目录" * 80) / "extension.pyd"):
                rendered = mapping.path_for(path)
                self.assertTrue(runtime._MAPPED_DRIVE_PATH_PATTERN.fullmatch(rendered))
                self.assertEqual(rendered[2:], str(path)[len(VOLUME_ROOT) - 1:])
                self.assertEqual(mapping.native_path_for(path), TARGET + rendered[2:])
            mapping.verify()
            mapping.close()
            mapping.close()
            self.assertEqual(devices, before)
            self.assertEqual(mutations, [])

    def test_subst_network_wrong_volume_multitarget_and_folder_mount_are_not_borrowed(self):
        cases = [
            ((r"\??\C:\data",), VOLUME_ROOT),
            ((r"\Device\LanmanRedirector\server\share",), VOLUME_ROOT),
            ((r"\Device\HarddiskVolume9",), VOLUME_ROOT),
            ((TARGET, r"\Device\HarddiskVolume9"), VOLUME_ROOT),
            ((TARGET,), VOLUME_ROOT.replace("12345678", "87654321")),
        ]
        for targets, volume in cases:
            runtime, devices, volumes, mutations, _ = runtime_fixture()
            devices["C:"], volumes["C:\\"] = targets, volume
            bridge._use_existing_volume_drives(runtime)
            with self.assertRaises(StartupError):
                runtime._create_dos_device_mapping(RUNTIME)
            self.assertEqual(mutations, [])
        runtime, devices, _, mutations, _ = runtime_fixture()
        devices.pop("C:")  # The exact guarded volume has only a directory mount.
        bridge._use_existing_volume_drives(runtime)
        with self.assertRaises(StartupError):
            runtime._create_dos_device_mapping(RUNTIME)
        self.assertEqual(mutations, [])

    def test_repeated_and_interrupted_sessions_never_accumulate_or_remove_mappings(self):
        runtime, devices, _, mutations, _ = runtime_fixture()
        before = dict(devices)
        bridge._use_existing_volume_drives(runtime)
        factory, launcher = runtime._create_dos_device_mapping, runtime.launch_windows_managed_process
        for index in range(100):
            bridge._use_existing_volume_drives(runtime)
            mapping = runtime._create_dos_device_mapping(RUNTIME)
            if index % 2:
                mapping.close()
            # Dropping the other objects simulates finally never running.
        self.assertIs(runtime._create_dos_device_mapping, factory)
        self.assertIs(runtime.launch_windows_managed_process, launcher)
        self.assertEqual(devices, before)
        self.assertEqual(mutations, [])

    def test_a_changed_borrowed_drive_is_rejected_and_close_leaves_the_new_owner_alone(self):
        runtime, devices, _, mutations, _ = runtime_fixture()
        bridge._use_existing_volume_drives(runtime)
        mapping = runtime._create_dos_device_mapping(RUNTIME)
        devices["C:"] = (r"\Device\HarddiskVolume9",)
        with self.assertRaises(StartupError):
            mapping.verify()
        mapping.close()
        self.assertEqual(devices["C:"], (r"\Device\HarddiskVolume9",))
        self.assertEqual(mutations, [])

    def test_unknown_runtime_contract_fails_without_calling_or_falling_back_to_old_factory(self):
        for mutate in (
            lambda runtime: setattr(runtime, "_MAPPED_DRIVE_PATH_PATTERN", re.compile(".*")),
            lambda runtime: setattr(runtime, "_DosDeviceMapping", object),
            lambda runtime: delattr(runtime, "_query_volume_name"),
        ):
            runtime, _, _, mutations, _ = runtime_fixture()
            original = runtime._create_dos_device_mapping
            mutate(runtime)
            with self.assertRaises(bridge._BridgeError):
                bridge._use_existing_volume_drives(runtime)
            self.assertIs(runtime._create_dos_device_mapping, original)
            self.assertEqual(mutations, [])

    def test_launcher_preserves_executable_native_job_options_and_all_paths_as_argv_data(self):
        runtime, _, _, mutations, launches = runtime_fixture()
        bridge._use_existing_volume_drives(runtime)
        worker = VOLUME_ROOT + '语音项目\\scripts\\gpt_sovits_worker.py'
        original = [r"C:\runtime\python.exe", "-I", "-B", "-u", worker, str(RUNTIME)]
        environment = {"LANGUAGE": "zh_CN", "PATH": "", "SystemRoot": r"C:\Windows", "USERPROFILE": r"C:\Users\Test"}
        handles = object()
        result = runtime.launch_windows_managed_process(original, cwd=str(RUNTIME), environment=environment, inherited_handles=handles)
        self.assertEqual(result, "owned-process")
        argv, options = launches[0]
        self.assertEqual(argv[:4], original[:4])
        self.assertEqual(argv[4:6], ["-c", bridge._EXISTING_DRIVE_WORKER_SHIM])
        self.assertEqual(argv[6:], original[4:])
        self.assertNotIn(worker, argv[5])
        self.assertIs(options["environment"], environment)
        self.assertIs(options["inherited_handles"], handles)
        self.assertEqual(options["cwd"], str(RUNTIME))
        self.assertEqual(mutations, [])
        for invalid in (["python", "-c", "print(1)"], original + ["extra"], original[:1] + ["-X"] + original[2:]):
            with self.assertRaises(bridge._BridgeError):
                runtime.launch_windows_managed_process(invalid)
        self.assertEqual(len(launches), 1)

    def test_fixed_child_shim_patches_actual_globals_and_preserves_original_file_argv_and_digest(self):
        ast.parse(bridge._EXISTING_DRIVE_WORKER_SHIM, feature_version=(3, 9))
        temporary = ROOT / "artifacts/drive-mapping-tests/temp"
        temporary.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            worker = Path(directory) / "用户 ' literal worker.py"
            source = (
                "import hashlib,json,re,sys\n"
                "from pathlib import Path\n"
                "_SCRIPT_PATH=Path(__file__)\n"
                "_MAPPED_DRIVE_PATTERN=re.compile(r'[D-Z]:',re.IGNORECASE)\n"
                "def _main():\n"
                " assert _MAPPED_DRIVE_PATTERN.fullmatch(sys.argv[1][:2])\n"
                " assert sys.argv[0]==str(_SCRIPT_PATH)\n"
                " print(json.dumps({'file':str(_SCRIPT_PATH),'argv':sys.argv,'sha256':hashlib.sha256(_SCRIPT_PATH.read_bytes()).hexdigest()}))\n"
                " return 0\n"
                "if __name__=='__main__': raise SystemExit(99)\n"
            )
            worker.write_text(source, encoding="utf-8")
            original_bytes = worker.read_bytes()
            for letter in ("C", "D"):
                import_root = letter + ":\\用户\\模型;$(not-a-command)\\runtime"
                result = subprocess.run([sys.executable, "-I", "-B", "-u", "-c", bridge._EXISTING_DRIVE_WORKER_SHIM, str(worker), import_root],
                                        capture_output=True, text=True, encoding="utf-8", timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(report["file"], str(worker))
                self.assertEqual(report["argv"], [str(worker), import_root])
                self.assertEqual(report["sha256"], hashlib.sha256(original_bytes).hexdigest())
                self.assertEqual(worker.read_bytes(), original_bytes)
            self.assertFalse((worker.parent / "__pycache__").exists())
            worker.write_text(source.replace("r'[D-Z]:'", "r'.*'"), encoding="utf-8")
            rejected = subprocess.run([sys.executable, "-I", "-B", "-c", bridge._EXISTING_DRIVE_WORKER_SHIM, str(worker), import_root],
                                      capture_output=True, text=True, encoding="utf-8", timeout=10)
            self.assertEqual(rejected.returncode, 1)
            self.assertEqual(rejected.stdout, "")

    def test_original_bundled_mapping_methods_remain_compatible_when_asset_archive_is_available(self):
        archive = ROOT / "build-resources/voice-bootstrap/Elysia-voice-assets-v1.zip"
        if not archive.is_file():
            self.skipTest("Local release asset is optional; no resource download is allowed")
        runtime, devices, _, mutations, _ = runtime_fixture()
        with zipfile.ZipFile(archive) as bundle:
            source = bundle.read("voice/managed_gpt_sovits.py").decode("utf-8")
            worker_source = bundle.read("scripts/gpt_sovits_worker.py").decode("utf-8")
        wanted = {"_DosDeviceMapping", "_volume_mapping_identity", "_VOLUME_GUID_PATH_PATTERN", "_NATIVE_FIXED_VOLUME_PATTERN", "_MAPPED_DRIVE_PATH_PATTERN"}
        nodes = [node for node in ast.parse(source).body if (
            isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in wanted
            or isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in wanted
        )]
        self.assertEqual(len(nodes), len(wanted))
        runtime.__dict__.update({"Path": PureWindowsPath, "re": re, "ntpath": ntpath})
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), "<original-bundled-mapping-contract>", "exec"), runtime.__dict__)
        bridge._use_existing_volume_drives(runtime)
        mapping = runtime._create_dos_device_mapping(RUNTIME)
        self.assertEqual(mapping.drive, "C:")
        self.assertEqual(mapping.path_for(RUNTIME), r"C:\Users\用户\Desktop Pet\models\runtime")
        mapping.verify()
        devices["C:"] = (r"\Device\HarddiskVolume9",)
        with self.assertRaises(StartupError):
            mapping.verify()
        mapping.close()
        self.assertEqual(mutations, [])
        # Exercise the original child's full identity check as well as its
        # regex. No upstream import, Windows API or model inference is run.
        child_names = {"_require_mapped_import_root", "_VOLUME_GUID_DRIVE_PATTERN", "_MAPPED_DRIVE_PATTERN", "_NATIVE_FIXED_VOLUME_PATTERN"}
        child_nodes = [node for node in ast.parse(worker_source).body if (
            isinstance(node, ast.FunctionDef) and node.name in child_names
            or isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in child_names
        )]
        self.assertEqual(len(child_nodes), len(child_names))
        child_scope = {"Path": PureWindowsPath, "re": re, "ntpath": ntpath, "_WorkerFailure": StartupError,
                       "_query_dos_device": runtime._query_dos_device}
        child_module = ast.Module(body=child_nodes, type_ignores=[])
        exec(compile(ast.fix_missing_locations(child_module), "<original-bundled-worker-contract>", "exec"), child_scope)
        devices["C:"] = (TARGET,)
        with self.assertRaises(StartupError):
            child_scope["_require_mapped_import_root"](r"C:\Users\用户\Desktop Pet\models\runtime", RUNTIME)
        child_scope["_MAPPED_DRIVE_PATTERN"] = re.compile(r"[C-Z]:", re.IGNORECASE)
        for letter in ("C", "D"):
            devices[letter + ":"] = (TARGET,)
            mapped = letter + r":\Users\用户\Desktop Pet\models\runtime"
            self.assertEqual(child_scope["_require_mapped_import_root"](mapped, RUNTIME), PureWindowsPath(mapped))
            devices[letter + ":"] = (r"\Device\HarddiskVolume9",)
            with self.assertRaises(StartupError):
                child_scope["_require_mapped_import_root"](mapped, RUNTIME)
        self.assertEqual(mutations, [])


if __name__ == "__main__":
    unittest.main()
