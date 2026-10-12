"""Offline CPU worker. No desktop imports, databases, cloud clients or downloads."""
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import sys
import threading
import time
import traceback


def save(path, report):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_checkpoint(root, model_id):
    """Check pinned download provenance and packaged bytes before importing model code."""
    root = root.resolve(strict=True)
    provenance = json.loads(Path(str(root) + ".provenance.json").read_text(encoding="utf-8"))
    if provenance.get("repo_id") != model_id or not re.fullmatch(r"[0-9a-f]{40}", provenance.get("revision", "")):
        raise ValueError("Checkpoint needs pinned provenance; use the model downloader")
    if model_id in ("SupersonicLabs/Julia-1", "vllm-sr/Vela-2.0-0.3B", "fastino/GLiNER2.5-Decide", "J33-AI/j33-jev", "tardellirs/crivo-150m"):
        files = provenance.get("files_sha256")
        config_path = "base/config.json" if model_id == "J33-AI/j33-jev" else "julia_config.json" if model_id == "SupersonicLabs/Julia-1" else "config.json"
        manifest = {"model_name": model_id.split("/")[-1], "files_sha256": files,
                    "config": json.loads((root / config_path).read_text(encoding="utf-8"))}
    else:
        manifest_path = root / "MODEL_MANIFEST.json"
        if sha256(manifest_path) != provenance.get("manifest_sha256"):
            raise ValueError("Checkpoint manifest differs from pinned download")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("model_name") != model_id.split("/")[-1]:
            raise ValueError("Checkpoint is not the selected model")
        files = manifest.get("files_sha256")
    if not isinstance(files, dict) or not files:
        raise ValueError("Missing checkpoint file inventory")
    for name, expected in files.items():
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            raise ValueError("Invalid checkpoint inventory path")
        path = root / relative
        if not path.resolve().is_relative_to(root) or path.is_symlink():
            raise ValueError("Checkpoint inventory escapes local directory")
        if sha256(path) != expected:
            raise ValueError("Checkpoint file differs from manifest: " + name)
    return provenance, manifest


def gliner_decision(model, state, questions):
    """Return native softmax scores without renormalization or choosing a label first."""
    tasks = {name: {"labels": q["criteria"], "prompt": q["instructions"],
                    "multi_label": True, "class_act": "softmax", "cls_threshold": 0}
             for name, q in questions.items()}
    native = model.classify_text(state if isinstance(state, str) else json.dumps(state, ensure_ascii=False),
                                 tasks, include_confidence=True, max_len=None)
    answers = {}
    for name, q in questions.items():
        rows = native[name]
        probabilities = {row["label"]: row["confidence"] for row in rows}
        if len(rows) != len(probabilities) or set(probabilities) != set(q["criteria"]):
            raise ValueError("GLiNER omitted or duplicated a choice probability")
        answers[name] = {"type": "choice", "probabilities": probabilities}
    return {"answers": answers, "native": native}


def j33_decision(model, state, questions):
    """Wrap the published probability maps; keep its fitted temperatures and scores intact."""
    native = model.predict(state, questions)
    if set(native) != set(questions):
        raise ValueError("j33-jev omitted or added a question")
    body = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
    return {"answers": {name: {"type": "choice", "probabilities": probabilities}
                        for name, probabilities in native.items()},
            "encoding": {"state_chars": len(body), "state_char_limit": 4000, "state_truncated": len(body) > 4000}}


def crivo_decision(model, state, questions):
    """Preserve the native per-option probabilities and reject missing questions."""
    native = model.answer(state, questions)
    if set(native) != set(questions):
        raise ValueError("Crivo omitted or added a question")
    return {"answers": native}


def load_j33(root):
    """Use the published model and strict weight loader, constructing its encoder from config.

    Upstream loads base weights then replaces every weight from its fine-tuned checkpoint.
    Avoid that extra download; leave the architecture, processing and prediction untouched.
    """
    sys.path.insert(0, str(root))
    import gemma_jev
    from transformers import AutoConfig, AutoModel

    class ConfigOnlyAutoModel:
        @staticmethod
        def from_pretrained(path, dtype, **kwargs):
            config = AutoConfig.from_pretrained(path, local_files_only=True, **kwargs)
            return AutoModel.from_config(config, dtype=dtype)

    original = gemma_jev.AutoModel
    try:
        gemma_jev.AutoModel = ConfigOnlyAutoModel
        model = gemma_jev.load(str(root / "model.safetensors"), base=str(root / "base"),
                               vision=False, head="none", device="cpu")
    finally:
        gemma_jev.AutoModel = original
    return model


class MemorySampler:
    """Sample process RSS, including loaded runtime and activations; not VRAM."""
    def __init__(self, process):
        self.process = process
        self.peak = 0
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def sample(self):
        self.peak = max(self.peak, self.process.memory_info().rss)

    def _run(self):
        while not self.stopped.wait(0.02):
            self.sample()

    def __enter__(self):
        self.sample()
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stopped.set()
        self.thread.join()
        self.sample()


def run(input_path, output_path):
    config = json.loads(input_path.read_text(encoding="utf-8"))
    report = {"runtime": {"python": platform.python_version(), "os": platform.platform(),
                          "machine": platform.machine(), "processor": platform.processor(),
                          "logical_cpus": os.cpu_count(), "threads": config["threads"],
                          "device": "cpu", "dtype": "float32", "memory_method": "process RSS sampled every 20ms"},
              "results": [], "warmups": []}
    save(output_path, report)
    stage = "load"
    try:
        os.environ.update(CUDA_VISIBLE_DEVICES="", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                          HF_HUB_DISABLE_TELEMETRY="1", OMP_NUM_THREADS=str(config["threads"]),
                          MKL_NUM_THREADS=str(config["threads"]), JULIA_CPU_THREADS=str(config["threads"]))
        root = Path(config["model_path"]).resolve(strict=True)
        started = time.perf_counter()
        provenance, manifest = verify_checkpoint(root, config["model_id"])
        report["runtime"].update(provenance=provenance, model_manifest=manifest,
                                 verification_ms=round((time.perf_counter() - started) * 1000, 3))
        save(output_path, report)
        with contextlib.redirect_stdout(sys.stderr):
            import psutil
            import torch
            process = psutil.Process()
            report["runtime"].update(physical_cpus=psutil.cpu_count(logical=False),
                                     total_ram_bytes=psutil.virtual_memory().total,
                                     packages={name: importlib.metadata.version(name) for name in
                                               ("torch", "transformers", "safetensors", "huggingface-hub", "psutil")})
            torch.set_num_threads(config["threads"])
            torch.set_num_interop_threads(1)
            torch.manual_seed(0)
            load_started = time.perf_counter()
            with MemorySampler(process) as memory:
                if config["model_id"] == "SupersonicLabs/Julia-1":
                    sys.path.insert(0, str(root))
                    from julia import load_model
                    report["runtime"]["julia_options"] = {"strict_encoding": True, "max_length": 8192,
                        "head_length": 512, "backend": "torch", "marker_only_head": False,
                        "encoding_cache": 0, "token_cache": 0}
                    model = load_model(str(root), device="cpu", **report["runtime"]["julia_options"])
                    predict = model.predict
                elif config["model_id"] == "vllm-sr/Vela-2.0-0.3B":
                    sys.path.insert(0, str(root))
                    from vela2_inference import Vela2
                    model = Vela2(str(root), backend="torch", device="cpu", threads=config["threads"])
                    predict = model.system_one
                    report["runtime"]["adapter"] = "published Vela2.system_one; torch CPU FP32"
                elif config["model_id"] == "fastino/GLiNER2.5-Decide":
                    from gliner2 import GLiNER2
                    model = GLiNER2.from_pretrained(str(root), map_location="cpu")
                    model.to("cpu").float().eval()
                    predict = lambda state, questions: gliner_decision(model, state, questions)
                    report["runtime"]["packages"]["gliner2"] = importlib.metadata.version("gliner2")
                    report["runtime"]["adapter"] = "native multiclass softmax; multi_label=True, cls_threshold=0 returns all labels; max_len=None (no truncation)"
                elif config["model_id"] == "tardellirs/crivo-150m":
                    sys.path.insert(0, str(root))
                    from crivo import Crivo
                    model = Crivo(str(root), device="cpu", max_length=32768, batch_size=32, token_budget=65536)
                    predict = lambda state, questions: crivo_decision(model, state, questions)
                    report["runtime"].update(adapter="published Crivo.answer; CPU FP32; strict checkpoint loading; native softmax",
                        crivo_options={"max_length": 32768, "batch_size": 32, "token_budget": 65536,
                                       "truncation": False, "temperature_fitted": False})
                elif config["model_id"] == "J33-AI/j33-jev":
                    model = load_j33(root)
                    predict = lambda state, questions: j33_decision(model, state, questions)
                    report["runtime"].update(adapter="published GemmaJev.predict; CPU FP32; config-only encoder initialization; strict fine-tuned weights",
                        j33_options={"vision": False, "head": "none", "state_char_limit": 4000,
                                     "temperature": model.temperature.tolist(), "base": provenance["base"]})
                    report["runtime"]["packages"].update({name: importlib.metadata.version(name) for name in ("pillow", "torchvision")})
                elif config["model_id"] == "vllm-sr/d3-edge":
                    # Published numerics are fixed: BF16 backbone and FP32 readout.
                    # threads is configured above, not passed to the d3 loader.
                    from transformers import AutoModel
                    report["runtime"].update(dtype="bfloat16 backbone / float32 readout",
                        adapter="published D3Model.system_one; checkpoint numerics; text-only CPU; no GPU kernels",
                        packages={**report["runtime"]["packages"], **{name: importlib.metadata.version(name)
                                   for name in ("accelerate", "pillow")}})
                    model = AutoModel.from_pretrained(str(root), trust_remote_code=True,
                                                      local_files_only=True, device="cpu", verify="full")
                    predict = model.system_one
                    runtime = model.runtime
                    report["runtime"]["d3_options"] = {"batch_size": runtime.batch_size,
                        "permutation_average": runtime.permutation_average, "temperature": runtime.temperature,
                        "max_length": runtime.max_length, "kernels": runtime.kernels, "fast_skipped": runtime.fast_skipped,
                        "image_unavailable": runtime.image_unavailable, "video_unavailable": runtime.video_unavailable}
                else:
                    from transformers import AutoModel
                    model = AutoModel.from_pretrained(str(root), trust_remote_code=True,
                                                      local_files_only=True, device="cpu", threads=config["threads"])
                    predict = model.system_one
            report["runtime"].update(load_ms=round((time.perf_counter() - load_started) * 1000, 3),
                                     load_peak_rss_bytes=memory.peak,
                                     resident_rss_bytes=process.memory_info().rss)
        save(output_path, report)
        print(f"Loaded {config['model_id']} on CPU; starting synthetic requests.", flush=True)
        request_number = 0

        def infer(job):
            nonlocal request_number
            temperature = "cold" if request_number == 0 else "warm"
            request_number += 1
            started_request = time.perf_counter()
            cpu_before = process.cpu_times()
            row = {"case": job["case"], "temperature": temperature}
            with MemorySampler(process) as memory:
                try:
                    with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                        row["raw"] = predict(**job["request"])
                except Exception as exc:
                    row.update(error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
            cpu_after = process.cpu_times()
            row.update(latency_ms=round((time.perf_counter() - started_request) * 1000, 3),
                       cpu_ms=round((cpu_after.user + cpu_after.system - cpu_before.user - cpu_before.system) * 1000, 3),
                       peak_rss_bytes=memory.peak)
            return row

        stage = "warmup"
        for _ in range(config["warmup"]):
            row = infer(config["jobs"][0])
            report["warmups"].append(row)
            save(output_path, report)
            if row.get("error"):
                raise RuntimeError("Warmup failed; see retained warmup result")
        stage = "inference"
        for iteration in range(1, config["repeat"] + 1):
            for job in config["jobs"]:
                row = infer(job)
                row["iteration"] = iteration
                report["results"].append(row)
                save(output_path, report)
                print(f"Measured {job['case']} #{iteration}: {row['latency_ms']} ms", flush=True)
        return 0
    except Exception as exc:
        report.update(error=f"{stage}: {type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        save(output_path, report)
        print(report["error"], file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    sys.exit(run(args.input, args.output))
