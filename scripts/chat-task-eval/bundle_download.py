"""Pinned, resumable HF CLI downloads for the standalone benchmark."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

from local_worker import save, sha256, verify_checkpoint


# Run the HF CLI with the OS certificate store (truststore) so corporate TLS-inspection proxies validate.
_HF_WITH_OS_CERTS = "import sys, truststore; truststore.inject_into_ssl(); from huggingface_hub.cli.hf import main; sys.exit(main())"


def hf_command():
    if importlib.util.find_spec("truststore"):
        return [sys.executable, "-c", _HF_WITH_OS_CERTS]
    return [str(Path(sys.executable).parent / ("hf.exe" if sys.platform == "win32" else "hf"))]


def prepare(config):
    root = Path(config["model_path"]).resolve()
    sidecar = Path(str(root) + ".provenance.json")
    pending = Path(str(root) + ".download-plan.json")
    identity = {"repo_id": config["model_id"], "revision": config["revision"]}
    if sidecar.exists():
        recorded = json.loads(sidecar.read_text(encoding="utf-8"))
        if any(recorded.get(k) != v for k, v in identity.items()):
            raise ValueError("Cached checkpoint revision differs; choose another --work-dir")
        if recorded.get("base") != config.get("base"):
            raise ValueError("Cached base assets differ; choose another --work-dir")
        verify_checkpoint(root, config["model_id"])
        print(f"Reusing verified checkpoint: {root}", flush=True)
        return
    if pending.exists():
        if json.loads(pending.read_text(encoding="utf-8")) != identity:
            raise ValueError("Partial download belongs to another revision")
    elif root.exists() and any(root.iterdir()):
        raise ValueError("Unregistered model directory; choose another --work-dir")
    root.parent.mkdir(parents=True, exist_ok=True)
    save(pending, identity)
    hf = hf_command()
    subprocess.run([*hf, "download", identity["repo_id"], "--revision", identity["revision"],
                    "--local-dir", str(root), *(["--exclude", *config["exclude"]] if config.get("exclude") else [])], check=True, shell=False,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    if config.get("base"):
        base = config["base"]
        subprocess.run([*hf, "download", base["repo"], *base["include"], "--revision", base["revision"],
                        "--local-dir", str(root / "base")], check=True, shell=False,
                        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    provenance = {**identity, "download_backend": "hf", "downloaded_at": datetime.now(timezone.utc).isoformat()}
    if config.get("base"):
        provenance["base"] = config["base"]
    if identity["repo_id"] in ("SupersonicLabs/Julia-1", "vllm-sr/Vela-2.0-0.3B", "fastino/GLiNER2.5-Decide", "J33-AI/j33-jev", "tardellirs/crivo-150m"):
        provenance["files_sha256"] = {str(p.relative_to(root)).replace("\\", "/"): sha256(p)
            for p in sorted(root.rglob("*")) if p.is_file() and ".cache" not in p.relative_to(root).parts}
        required = {"SupersonicLabs/Julia-1": ["julia/__init__.py", "julia_config.json"],
                    "vllm-sr/Vela-2.0-0.3B": ["vela2_inference.py", "modeling_vela2.py", "configuration_vela2.py", "calibration.json", "config.json", "tokenizer.json"],
                    "fastino/GLiNER2.5-Decide": ["config.json", "encoder_config/config.json", "tokenizer.json"],
                    "J33-AI/j33-jev": ["gemma_jev.py", "base/config.json", "base/tokenizer.json", "base/tokenizer_config.json", "base/processor_config.json", "base/preprocessor_config.json"],
                    "tardellirs/crivo-150m": ["crivo.py", "model.py", "config.json", "tokenizer.json", "tokenizer_config.json"]}[identity["repo_id"]]
        if any(name not in provenance["files_sha256"] for name in ["model.safetensors", *required]):
            raise ValueError("Download is missing weights, configuration or runtime")
        provenance["excluded_patterns"] = config.get("exclude", [])
    else:
        provenance["manifest_sha256"] = sha256(root / "MODEL_MANIFEST.json")
    # A failed download never creates a completed provenance record.
    save(sidecar, provenance)
    try:
        verify_checkpoint(root, config["model_id"])
    except Exception:
        sidecar.unlink()
        raise
    pending.unlink()
    print(f"Downloaded and verified: {root}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()
    try:
        prepare(json.loads(args.input.read_text(encoding="utf-8")))
    except Exception as exc:
        parser.exit(1, f"Download failed: {type(exc).__name__}: {exc}\n")
