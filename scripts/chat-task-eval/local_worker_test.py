"""Dependency-free checks; these do not measure a real decision model."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("local_worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def checkpoint(self, root, model_id="vllm-sr/Decision-2.0-Kai-0.6B"):
        (root / "code.py").write_text("# original model code\n", encoding="utf-8")
        manifest = {"model_name": model_id.split("/")[-1], "files_sha256": {"code.py": worker.sha256(root / "code.py")}}
        (root / "MODEL_MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.provenance(root, model_id)

    def provenance(self, root, model_id="vllm-sr/Decision-2.0-Kai-0.6B"):
        Path(str(root) + ".provenance.json").write_text(json.dumps({
            "repo_id": model_id, "revision": "a" * 40,
            "manifest_sha256": worker.sha256(root / "MODEL_MANIFEST.json"),
        }), encoding="utf-8")

    def test_pinned_bytes_checked_before_model_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model"; root.mkdir()
            self.checkpoint(root)
            worker.verify_checkpoint(root, "vllm-sr/Decision-2.0-Kai-0.6B")
            (root / "code.py").write_text("# changed", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "differs from manifest"):
                worker.verify_checkpoint(root, "vllm-sr/Decision-2.0-Kai-0.6B")

    def test_inventory_cannot_read_outside_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model"; root.mkdir()
            self.checkpoint(root)
            manifest_path = root / "MODEL_MANIFEST.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["files_sha256"] = {"../private": "a" * 64}
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            self.provenance(root)
            with self.assertRaisesRegex(ValueError, "inventory path"):
                worker.verify_checkpoint(root, "vllm-sr/Decision-2.0-Kai-0.6B")

    def test_loading_failure_is_checkpointed_without_inference_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path, output_path = root / "input.json", root / "raw.json"
            input_path.write_text(json.dumps({"threads": 4, "model_path": str(root / "missing"),
                                              "model_id": "vllm-sr/Decision-2.0-Kai-0.6B"}), encoding="utf-8")
            self.assertEqual(worker.run(input_path, output_path), 1)
            report = json.loads(output_path.read_text())
            self.assertIn("load: FileNotFoundError", report["error"])
            self.assertEqual(report["results"], [])
            self.assertEqual(report["runtime"]["device"], "cpu")

    def test_gliner_full_native_softmax_preserves_scores_and_missing_labels_fail(self):
        calls = []
        native = {"task": [{"label": "first", "confidence": .3}, {"label": "second", "confidence": .7}]}
        model = SimpleNamespace(classify_text=lambda text, tasks, **options: calls.append((text, tasks, options)) or native)
        questions = {"task": {"instructions": "Which subject?", "criteria": {"first": "Area A", "second": "Area B"}}}
        result = worker.gliner_decision(model, {"request": "example"}, questions)
        self.assertEqual(result["answers"]["task"]["probabilities"], {"first": .3, "second": .7})
        self.assertEqual(result["native"], native)
        self.assertEqual(calls[0][1]["task"]["class_act"], "softmax")
        self.assertEqual(calls[0][1]["task"]["cls_threshold"], 0)
        self.assertTrue(calls[0][1]["task"]["multi_label"])
        self.assertIsNone(calls[0][2]["max_len"])
        native["task"].pop()
        with self.assertRaisesRegex(ValueError, "omitted or duplicated"):
            worker.gliner_decision(model, "example", questions)

    def test_atomic_checkpoint_replaces_previous_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "raw.json"
            worker.save(path, {"results": []})
            worker.save(path, {"results": [{"error": "retained failure"}]})
            self.assertEqual(json.loads(path.read_text())["results"][0]["error"], "retained failure")
            self.assertFalse(path.with_suffix(".tmp").exists())

    def test_crivo_preserves_native_answers_and_propagates_length_failures(self):
        native = {"task": {"type": "choice", "choice": "b", "probabilities": {"a": .3, "b": .7}}}
        calls = []
        model = SimpleNamespace(answer=lambda state, questions: calls.append((state, questions)) or native)
        state, questions = {"request": "evidence"}, {"task": {"type": "choice"}}
        self.assertIs(worker.crivo_decision(model, state, questions)["answers"], native)
        self.assertEqual(calls, [(state, questions)])
        with self.assertRaisesRegex(ValueError, "omitted or added"):
            worker.crivo_decision(model, state, {**questions, "context": {}})
        model.answer = lambda *_: (_ for _ in ()).throw(ValueError("above max_length"))
        with self.assertRaisesRegex(ValueError, "above max_length"):
            worker.crivo_decision(model, state, questions)

    def test_j33_wraps_native_probabilities_without_changing_scores_or_temperatures(self):
        calls = []
        native = {"task": {"a": .2, "b": .8}, "context": {"sufficient": .4, "insufficient": .6}}
        model = SimpleNamespace(predict=lambda state, questions: calls.append((state, questions)) or native)
        state = {"request": "subject"}
        questions = {name: {"type": "choice", "criteria": dict(values)} for name, values in native.items()}
        result = worker.j33_decision(model, state, questions)
        self.assertEqual(calls, [(state, questions)])
        self.assertEqual(result["answers"]["task"]["probabilities"], native["task"])
        self.assertEqual(result["answers"]["context"]["probabilities"], native["context"])
        self.assertFalse(result["encoding"]["state_truncated"])
        self.assertTrue(worker.j33_decision(model, "x" * 4001, questions)["encoding"]["state_truncated"])
        native.pop("context")
        with self.assertRaisesRegex(ValueError, "omitted or added"):
            worker.j33_decision(model, state, questions)

    def test_j33_constructs_pinned_config_only_and_uses_published_strict_cpu_loader(self):
        calls = []
        original = object()
        fake_module = SimpleNamespace(AutoModel=original)
        def load(path, **options):
            calls.append(("load", path, options))
            fake_module.AutoModel.from_pretrained(options["base"], dtype="fp32", audio_config=None, vision_config=None)
            return "loaded"
        fake_module.load = load
        transformers = SimpleNamespace(AutoConfig=SimpleNamespace(from_pretrained=lambda path, **kw:
            calls.append(("config", path, kw)) or "encoder-config"),
            AutoModel=SimpleNamespace(from_config=lambda config, **kw: calls.append(("construct", config, kw)) or "encoder"))
        with tempfile.TemporaryDirectory() as directory, patch.dict(worker.sys.modules, {
            "gemma_jev": fake_module, "torch": SimpleNamespace(), "transformers": transformers}), \
                patch.object(worker.sys, "path", list(worker.sys.path)):
            self.assertEqual(worker.load_j33(Path(directory)), "loaded")
        self.assertIs(fake_module.AutoModel, original)
        self.assertEqual(calls[0][2]["device"], "cpu")
        self.assertEqual(calls[0][2]["head"], "none"); self.assertFalse(calls[0][2]["vision"])
        self.assertTrue(calls[1][2]["local_files_only"])
        self.assertEqual(calls[2], ("construct", "encoder-config", {"dtype": "fp32"}))

    def test_julia_uses_cpu_reference_predict_without_optional_native_or_gpu_backends(self):
        calls, loads = [], []
        def load(*args, **kwargs):
            loads.append(kwargs)
            return SimpleNamespace(predict=lambda **request: calls.append(request) or {"answers": {}})
        process = SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=123456),
                                  cpu_times=lambda: SimpleNamespace(user=1, system=2))
        modules = {"julia": SimpleNamespace(load_model=load),
            "psutil": SimpleNamespace(Process=lambda: process, cpu_count=lambda **_: 4,
                                      virtual_memory=lambda: SimpleNamespace(total=64000000000)),
            "torch": SimpleNamespace(set_num_threads=lambda _: None, set_num_interop_threads=lambda _: None,
                                     manual_seed=lambda _: None, inference_mode=worker.contextlib.nullcontext)}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "julia"; root.mkdir()
            (root / "julia_config.json").write_text("{}", encoding="utf-8")
            Path(str(root) + ".provenance.json").write_text(json.dumps({"repo_id": "SupersonicLabs/Julia-1", "revision": "a" * 40,
                "files_sha256": {"julia_config.json": worker.sha256(root / "julia_config.json")}}), encoding="utf-8")
            input_path, output_path = root.parent / "input.json", root.parent / "raw.json"
            input_path.write_text(json.dumps({"threads": 4, "model_path": str(root), "model_id": "SupersonicLabs/Julia-1",
                "warmup": 0, "repeat": 1, "jobs": [{"case": "sample", "request": {"state": "evidence", "questions": {}}}]}), encoding="utf-8")
            with patch.dict(worker.sys.modules, modules), patch.dict(worker.os.environ), \
                 patch.object(worker.sys, "path", list(worker.sys.path)), \
                 patch.object(worker.importlib.metadata, "version", return_value="test-runtime"):
                self.assertEqual(worker.run(input_path, output_path), 0)
            self.assertEqual(loads[0]["device"], "cpu"); self.assertEqual(loads[0]["backend"], "torch")
            self.assertTrue(loads[0]["strict_encoding"]); self.assertFalse(loads[0]["marker_only_head"])
            self.assertEqual(loads[0]["encoding_cache"], 0); self.assertEqual(len(calls), 1)
            self.assertEqual(json.loads(output_path.read_text())["results"][0]["case"], "sample")

    def test_d3_preserves_checkpoint_numerics_and_uses_cpu_without_gpu_kernel_dependencies(self):
        calls, loads = [], []
        runtime = SimpleNamespace(batch_size=8, permutation_average=False, temperature=1.0,
            max_length=None, kernels={"delta": "torch_reference"}, fast_skipped="not a ROCm GPU",
            image_unavailable=None, video_unavailable="text-only test")
        def load(*args, **kwargs):
            loads.append(kwargs)
            return SimpleNamespace(runtime=runtime, system_one=lambda **request: calls.append(request) or {"answers": {}})
        process = SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=123456),
                                  cpu_times=lambda: SimpleNamespace(user=1, system=2))
        modules = {"transformers": SimpleNamespace(AutoModel=SimpleNamespace(from_pretrained=load)),
            "psutil": SimpleNamespace(Process=lambda: process, cpu_count=lambda **_: 4,
                                      virtual_memory=lambda: SimpleNamespace(total=64000000000)),
            "torch": SimpleNamespace(set_num_threads=lambda _: None, set_num_interop_threads=lambda _: None,
                                     manual_seed=lambda _: None, inference_mode=worker.contextlib.nullcontext)}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "d3-edge"; root.mkdir()
            self.checkpoint(root, "vllm-sr/d3-edge")
            input_path, output_path = root.parent / "input.json", root.parent / "raw.json"
            input_path.write_text(json.dumps({"threads": 4, "model_path": str(root), "model_id": "vllm-sr/d3-edge",
                "warmup": 0, "repeat": 1, "jobs": [{"case": "sample", "request": {"state": "evidence", "questions": {}}}]}), encoding="utf-8")
            with patch.dict(worker.sys.modules, modules), patch.dict(worker.os.environ), \
                 patch.object(worker.importlib.metadata, "version", return_value="test-runtime"):
                self.assertEqual(worker.run(input_path, output_path), 0)
            self.assertEqual(loads[0]["device"], "cpu"); self.assertEqual(loads[0]["verify"], "full")
            self.assertTrue(loads[0]["local_files_only"])
            self.assertNotIn("threads", loads[0]); self.assertNotIn("dtype", loads[0])
            self.assertEqual(calls, [{"state": "evidence", "questions": {}}])
            report = json.loads(output_path.read_text())
            self.assertEqual(report["runtime"]["dtype"], "bfloat16 backbone / float32 readout")
            self.assertFalse(report["runtime"]["d3_options"]["permutation_average"])

    def test_cpu_worker_retains_warmup_and_per_trial_failure_without_retry(self):
        # Exercise load -> warmup -> repeated requests -> checkpoints without weights.
        calls, loads = [], []

        class FakeModel:
            def system_one(self, **request):
                calls.append(request)
                if request["state"] == "bad":
                    raise ValueError("synthetic inference failure")
                return {"answers": {"task": {"type": "choice", "probabilities": {"no_match": 1}}}}

        def load(*args, **kwargs):
            loads.append(kwargs)
            return FakeModel()

        process = SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=123456),
                                  cpu_times=lambda: SimpleNamespace(user=1, system=2))
        modules = {
            "psutil": SimpleNamespace(Process=lambda: process, cpu_count=lambda **_: 4,
                                      virtual_memory=lambda: SimpleNamespace(total=64000000000)),
            "torch": SimpleNamespace(set_num_threads=lambda _: None, set_num_interop_threads=lambda _: None,
                                     manual_seed=lambda _: None, inference_mode=worker.contextlib.nullcontext),
            "transformers": SimpleNamespace(AutoModel=SimpleNamespace(from_pretrained=load)),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model"; root.mkdir()
            self.checkpoint(root)
            input_path, output_path = root.parent / "input.json", root.parent / "raw.json"
            input_path.write_text(json.dumps({"threads": 4, "model_path": str(root),
                "model_id": "vllm-sr/Decision-2.0-Kai-0.6B", "warmup": 1, "repeat": 2,
                "jobs": [{"case": "good", "request": {"state": "good", "questions": {}}},
                         {"case": "bad", "request": {"state": "bad", "questions": {}}}]}), encoding="utf-8")
            with patch.dict(worker.sys.modules, modules), patch.dict(worker.os.environ), \
                 patch.object(worker.importlib.metadata, "version", return_value="test-runtime"):
                self.assertEqual(worker.run(input_path, output_path), 0)
                self.assertEqual(worker.os.environ["HF_HUB_OFFLINE"], "1")
                self.assertEqual(worker.os.environ["CUDA_VISIBLE_DEVICES"], "")
            report = json.loads(output_path.read_text())
            self.assertEqual(len(calls), 5)  # One warmup, then exactly four trials.
            self.assertEqual(loads[0]["device"], "cpu")
            self.assertTrue(loads[0]["local_files_only"])
            self.assertEqual(report["warmups"][0]["temperature"], "cold")
            self.assertEqual([r["iteration"] for r in report["results"]], [1, 1, 2, 2])
            self.assertTrue(all(r["temperature"] == "warm" for r in report["results"]))
            self.assertEqual(report["results"][0]["peak_rss_bytes"], 123456)
            self.assertIn("synthetic inference failure", report["results"][1]["error"])
            self.assertIn("ValueError", report["results"][3]["traceback"])
            self.assertIn("raw", report["results"][2])


if __name__ == "__main__":
    unittest.main()
