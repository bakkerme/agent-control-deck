"""Explicit network/download step; the evaluator itself never downloads weights."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

from local_worker import sha256

MODEL_ID = "vllm-sr/Decision-2.0-Kai-0.6B"


def find_hf(executable=None):
    if executable:
        found = shutil.which(executable)
    else:
        # pip installs hf beside this interpreter, even when the venv isn't activated.
        sibling = Path(sys.executable).parent / ("hf.exe" if sys.platform == "win32" else "hf")
        found = str(sibling) if sibling.is_file() else shutil.which("hf")
    if not found:
        raise ValueError("HF CLI not found; install huggingface-hub in this Python environment "
                         "or pass --hf-executable PATH_TO_HF")
    return found


def download_checkpoint(model_path, revision=None, backend="python", hf_executable=None):
    if backend not in ("python", "hf"):
        raise ValueError("Download backend must be python or hf")
    if hf_executable is not None and backend != "hf":
        raise ValueError("--hf-executable requires --backend hf")
    if revision is not None and not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("--revision must be a full commit SHA")
    root = model_path.resolve()
    sidecar = Path(str(root) + ".provenance.json")
    if sidecar.exists() or (root.exists() and (not root.is_dir() or any(root.iterdir()))):
        raise ValueError("Choose an empty model directory; existing checkpoints are not replaced")
    hf = find_hf(hf_executable) if backend == "hf" else None
    if revision is None:
        from huggingface_hub import HfApi
        revision = HfApi().model_info(MODEL_ID).sha
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Hugging Face did not return a full commit SHA")
    print(f"Downloading {MODEL_ID}@{revision} into {root} via {backend}", flush=True)
    if backend == "hf":
        subprocess.run([hf, "download", MODEL_ID, "--revision", revision, "--local-dir", str(root)],
                       check=True, shell=False)
    else:
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=MODEL_ID, revision=revision, local_dir=str(root))
    provenance = {"repo_id": MODEL_ID, "revision": revision, "download_backend": backend,
                  "manifest_sha256": sha256(root / "MODEL_MANIFEST.json"),
                  "downloaded_at": datetime.now(timezone.utc).isoformat()}
    with sidecar.open("x", encoding="utf-8") as stream:
        json.dump(provenance, stream, indent=2)
        stream.write("\n")
    print(f"Pinned provenance: {sidecar}", flush=True)
    return provenance


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True, type=Path)
    parser.add_argument("--revision", help="Full commit SHA; omitted: resolve current revision once and pin it")
    parser.add_argument("--backend", choices=("python", "hf"), default="python",
                        help="Download using the Python Hub library (default) or hf download")
    parser.add_argument("--hf-executable", help="HF CLI executable path; default: beside Python, then PATH")
    args = parser.parse_args(argv)
    try:
        download_checkpoint(args.model_path, args.revision, args.backend, args.hf_executable)
    except (ValueError, OSError, ImportError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Download failed: {exc}\n")


if __name__ == "__main__":
    main()
