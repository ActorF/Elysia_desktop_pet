"""Publish only the prepared upstream archive and its generated provenance README."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
FILE_NAME = "GPT-SoVITS-v2-240821.7z"
REPO_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


def contained_path(root: Path, relative: str) -> Path:
    root = root.absolute()
    target = root / relative
    if root.resolve() != root or not target.resolve().is_relative_to(root):
        raise ValueError("Path is outside the project.")
    current = root
    for part in Path(relative).parts:
        if part in ("..", "."):
            raise ValueError("Invalid relative path.")
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError("Linked paths are not allowed.")
    return target


def readme_text(runtime: dict) -> str:
    return "\n".join([
        "---", "license: mit", "---", "", "# GPT-SoVITS Windows runtime mirror", "",
        "This repository mirrors the original upstream Windows archive without modifying its bytes.",
        "It contains no Elysia user data, character artwork, personal voice profiles, or chat history.", "",
        f"- File: {runtime['fileName']}", f"- Bytes: {runtime['bytes']}", f"- SHA256: {runtime['sha256']}",
        f"- Original download: {runtime['url']}", "- Upstream project: https://github.com/RVC-Boss/GPT-SoVITS", "",
        "GPT-SoVITS is distributed under the upstream MIT license. Bundled components retain their own licenses and notices inside the original archive.", "",
    ])


def build_plan(root: Path = ROOT) -> dict:
    manifest_path = contained_path(root, "electron/voice-bootstrap-manifest.json")
    if not manifest_path.is_file() or manifest_path.stat().st_size > 65536:
        raise ValueError("Invalid voice manifest file.")
    runtime = json.loads(manifest_path.read_text(encoding="utf-8"))["runtime"]
    if (runtime.get("fileName") != FILE_NAME or type(runtime.get("bytes")) is not int
            or not 0 < runtime["bytes"] <= 12 * 1024 ** 3
            or not re.fullmatch(r"[a-f0-9]{64}", runtime.get("sha256", ""))
            or not re.fullmatch(r"https://huggingface\.co/lj1995/GPT-SoVITS-windows-package/resolve/[a-f0-9]{40}/GPT-SoVITS-v2-240821\.7z", runtime.get("url", ""))):
        raise ValueError("Invalid pinned voice runtime.")
    archive = contained_path(root, f"build-resources/voice-mirror/{FILE_NAME}")
    readme = contained_path(root, "build-resources/voice-mirror/README.md")
    if not archive.is_file() or archive.stat().st_size != runtime["bytes"]:
        raise ValueError("Prepared archive is missing or wrong-sized; run prepare-voice-mirror.cjs --download first.")
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != runtime["sha256"]:
        raise ValueError("Prepared archive SHA256 does not match; nothing will be uploaded.")
    expected = readme_text(runtime).encode("utf-8")
    if not readme.is_file() or readme.stat().st_size != len(expected) or readme.read_bytes() != expected:
        raise ValueError("Provenance README differs from the generated file; prepare the mirror again.")
    return {"root": root, "runtime": runtime, "files": [(archive, FILE_NAME), (readme, "README.md")]}


def configure_local_sdk(root: Path) -> None:
    # The official SDK treats even an empty environment value as an explicit
    # anonymous-token override. Let an empty value fall back to the local login.
    if os.environ.get("MODELSCOPE_API_TOKEN") == "":
        os.environ.pop("MODELSCOPE_API_TOKEN", None)
    locations = {
        "MODELSCOPE_HOME": "build-resources/voice-mirror/.modelscope",
        "MODELSCOPE_CACHE": "build-resources/voice-mirror/.cache/modelscope",
        "XDG_CACHE_HOME": "build-resources/voice-mirror/.cache",
        "PIP_CACHE_DIR": "build-resources/voice-mirror/.cache/pip",
        "TEMP": "build-resources/voice-mirror/.tmp",
        "TMP": "build-resources/voice-mirror/.tmp",
        "TMPDIR": "build-resources/voice-mirror/.tmp",
    }
    for key, relative in locations.items():
        directory = contained_path(root, relative)
        directory.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(directory)
    # Credentials must only be sent to the actual domestic ModelScope service.
    os.environ["MODELSCOPE_ENDPOINT"] = "https://modelscope.cn"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    import tempfile
    tempfile.tempdir = os.environ["TEMP"]


def publish_plan(plan: dict, repo: str, api_factory=None, repo_exists_error=None) -> None:
    if not REPO_PATTERN.fullmatch(repo):
        raise ValueError("Use a real repository in owner/name form.")
    configure_local_sdk(plan["root"])
    # Suppress third-party HTTP/progress output; errors may contain headers or signed URLs.
    previous_logging = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        with open(os.devnull, "w", encoding="utf-8") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            if api_factory is None:
                try:
                    from modelscope_hub import HubApi
                    from modelscope_hub.errors import is_repo_exists_error
                except ImportError:
                    raise RuntimeError("missing-sdk") from None
                api_factory, repo_exists_error = HubApi, is_repo_exists_error
            api = api_factory(token=os.environ.get("MODELSCOPE_API_TOKEN") or None, endpoint="https://modelscope.cn")
            try:
                api.create_repo(repo, "model", visibility="public", license="mit")
            except Exception as error:
                if repo_exists_error is None or not repo_exists_error(error):
                    raise
            for local, remote in plan["files"]:
                api.upload_file(repo, "model", str(local), remote)
    finally:
        logging.disable(previous_logging)


def main(argv=None) -> int:
    class PrivateArgumentParser(argparse.ArgumentParser):
        def error(self, message):
            # argparse normally echoes unrecognized values, including an accidentally supplied token.
            self.exit(2, "Use --repo owner/name [--publish]. Credentials belong in MODELSCOPE_API_TOKEN or local login configuration, never command arguments.\n")

    parser = PrivateArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Public ModelScope owner/name repository")
    parser.add_argument("--publish", action="store_true", help="Actually create/upload; omitted means a local dry run")
    args = parser.parse_args(argv)
    if not REPO_PATTERN.fullmatch(args.repo):
        parser.error("--repo must be owner/name")
    try:
        plan = build_plan()
        print(json.dumps({"action": "publish" if args.publish else "dry-run", "repo": args.repo,
                          "files": [{"local": str(local), "remote": remote} for local, remote in plan["files"]],
                          "bytes": plan["runtime"]["bytes"], "sha256": plan["runtime"]["sha256"]}, indent=2))
        if not args.publish:
            print("No SDK imported, no login performed, and no remote files changed. Add --publish only when ready.")
            return 0
        publish_plan(plan, args.repo)
        print("Uploaded the original archive and README. Run configure-voice-mirror.cjs to verify public access before enabling it.")
        return 0
    except RuntimeError as error:
        if str(error) == "missing-sdk":
            mirror_root = str(ROOT / "build-resources/voice-mirror").replace("'", "''")
            print("ModelScope SDK is missing. No automatic installation was attempted. To install into this project's directory, run in PowerShell:", file=sys.stderr)
            print(f"$voiceMirrorRoot = '{mirror_root}'", file=sys.stderr)
            print("$env:TEMP = Join-Path $voiceMirrorRoot '.tmp'\n$env:TMP = $env:TEMP", file=sys.stderr)
            print("python -m venv (Join-Path $voiceMirrorRoot '.venv')", file=sys.stderr)
            print("& (Join-Path $voiceMirrorRoot '.venv\\Scripts\\python.exe') -m pip install --cache-dir (Join-Path $voiceMirrorRoot '.cache\\pip') modelscope-hub", file=sys.stderr)
            print("Then rerun this publisher with that project-local Python executable. Supply credentials through MODELSCOPE_API_TOKEN or the project-local ModelScope login configuration.", file=sys.stderr)
        else:
            print("Publication failed. Check your local ModelScope login/token, repository access, and connection. Credentials are not printed.", file=sys.stderr)
    except (ValueError, FileNotFoundError, KeyError, json.JSONDecodeError) as error:
        # These errors originate from local validation before the SDK is called.
        print(str(error) if not args.publish else "Mirror preparation/publication failed. Check the prepared archive and local credentials.", file=sys.stderr)
    except Exception:
        print("Publication failed. Check the prepared files, local ModelScope login/token, and repository access. Credentials are not printed.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
