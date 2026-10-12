"""Bounded JSON-lines protocol for one resident CPU model. Never writes chat input."""
import contextlib
import json
import os
from pathlib import Path
import sys
import time

def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(",", ":")), flush=True)

def main():
    root, repo, revision, threads = Path(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
    os.environ.update(CUDA_VISIBLE_DEVICES="", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1", OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads))
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        from local_worker import verify_checkpoint, MemorySampler
        provenance, _ = verify_checkpoint(root, repo)
        if provenance["revision"] != revision:
            raise ValueError("Revision mismatch")
        import torch
        import psutil
        torch.set_num_threads(threads); torch.set_num_interop_threads(1); torch.manual_seed(0)
        process = psutil.Process()
        with MemorySampler(process) as memory:
            if repo == "vllm-sr/Vela-2.0-0.3B":
                sys.path.insert(0, str(root))
                from vela2_inference import Vela2
                model = Vela2(str(root), backend="torch", device="cpu", threads=threads)
            elif repo == "vllm-sr/Decision-2.0-Kai-0.6B":
                from transformers import AutoModel
                model = AutoModel.from_pretrained(str(root), trust_remote_code=True, local_files_only=True, device="cpu", threads=threads)
            else:
                raise ValueError("Unsupported model")
    emit({"ready": True, "startup_ms": (time.perf_counter()-started)*1000, "peak_rss_bytes": memory.peak})
    cold = True
    while True:
        line = sys.stdin.buffer.readline(512 * 1024 + 1)
        if not line:
            break
        if len(line) > 512 * 1024 or not line.endswith(b"\n"):
            raise ValueError("Protocol limit")
        request = json.loads(line)
        started = time.perf_counter(); before = process.cpu_times()
        with MemorySampler(process) as memory:
            try:
                with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                    raw = model.system_one(**request["request"])
                after = process.cpu_times()
                emit({"id": request["id"], "raw": raw, "cold": cold, "inference_ms": (time.perf_counter()-started)*1000,
                      "cpu_ms": (after.user+after.system-before.user-before.system)*1000, "peak_rss_bytes": memory.peak})
                cold = False
            except Exception:
                # Errors can echo confidential request content. Send only a fixed code.
                emit({"id": request["id"], "error": "inference_failed"})

if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"error": "worker_failed"})
        sys.exit(1)
