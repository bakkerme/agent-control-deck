"""Check resumable downloads and verified-cache reuse without network or weights."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import bundle_download as downloader
from local_worker import sha256


class DownloadTests(unittest.TestCase):
    def config(self, root):
        return {"model_path": str(root), "model_id": "SupersonicLabs/Julia-1", "revision": "a" * 40}

    def populate(self, root):
        (root / "julia").mkdir(parents=True, exist_ok=True)
        (root / "julia" / "__init__.py").write_text("# verified code", encoding="utf-8")
        (root / "model.safetensors").write_bytes(b"test weights")
        (root / "julia_config.json").write_text("{}", encoding="utf-8")

    def test_resume_then_verify_reuse_and_detect_tampering(self):
        with tempfile.TemporaryDirectory(prefix="download with spaces ") as directory:
            root = Path(directory) / "julia"
            config = self.config(root)
            with patch.object(downloader.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "hf")):
                with self.assertRaises(subprocess.CalledProcessError):
                    downloader.prepare(config)
            self.assertTrue(Path(str(root) + ".download-plan.json").exists())
            self.assertFalse(Path(str(root) + ".provenance.json").exists())
            self.populate(root)
            with patch.object(downloader.subprocess, "run") as run:
                downloader.prepare(config)
                args = run.call_args.args[0]
                self.assertEqual(args[-1], str(root.resolve()))
                self.assertEqual(args[args.index("--revision") + 1], "a" * 40)
                self.assertFalse(run.call_args.kwargs["shell"])
            self.assertFalse(Path(str(root) + ".download-plan.json").exists())
            inventory = json.loads(Path(str(root) + ".provenance.json").read_text())["files_sha256"]
            self.assertEqual(inventory["julia/__init__.py"], sha256(root / "julia" / "__init__.py"))
            with patch.object(downloader.subprocess, "run") as run:
                downloader.prepare(config)
                run.assert_not_called()
                (root / "julia" / "__init__.py").write_text("# altered", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "differs from manifest"):
                    downloader.prepare(config)
                run.assert_not_called()

    def test_vela_download_excludes_onnx_and_checks_required_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "vela"
            config = {"model_path": str(root), "model_id": "vllm-sr/Vela-2.0-0.3B", "revision": "b" * 40, "exclude": ["onnx/*"]}
            def populate(*_args, **_kwargs):
                root.mkdir()
                for name in ["model.safetensors", "config.json", "tokenizer.json", "calibration.json", "vela2_inference.py", "modeling_vela2.py", "configuration_vela2.py"]:
                    (root / name).write_text("{}", encoding="utf-8")
            with patch.object(downloader.subprocess, "run", side_effect=populate) as run:
                downloader.prepare(config)
                self.assertEqual(run.call_args.args[0][-2:], ["--exclude", "onnx/*"])
            provenance = json.loads(Path(str(root) + ".provenance.json").read_text())
            self.assertEqual(provenance["excluded_patterns"], ["onnx/*"])
            (root / "modeling_vela2.py").write_text("modified", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "differs from manifest"):
                downloader.prepare(config)

    def test_d3_manifest_verifies_sharded_weights_readout_and_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "d3-edge"
            config = {"model_path": str(root), "model_id": "vllm-sr/d3-edge", "revision": "c" * 40}
            def populate(*_args, **_kwargs):
                root.mkdir()
                for name in ["model-00001-of-00001.safetensors", "readout.safetensors", "d3_runtime.py"]:
                    (root / name).write_bytes(b"synthetic fixture")
                inventory = {p.name: sha256(p) for p in root.iterdir()}
                (root / "MODEL_MANIFEST.json").write_text(json.dumps({"model_name": "d3-edge", "files_sha256": inventory}), encoding="utf-8")
            with patch.object(downloader.subprocess, "run", side_effect=populate):
                downloader.prepare(config)
            with patch.object(downloader.subprocess, "run") as run:
                downloader.prepare(config); run.assert_not_called()
                (root / "readout.safetensors").write_bytes(b"changed weights")
                with self.assertRaisesRegex(ValueError, "differs from manifest"):
                    downloader.prepare(config)
                run.assert_not_called()

    def test_crivo_checks_complete_runtime_and_detects_changed_native_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "crivo"
            config = {"model_path": str(root), "model_id": "tardellirs/crivo-150m", "revision": "f" * 40}
            def populate(*_args, **_kwargs):
                root.mkdir()
                for name in ["model.safetensors", "crivo.py", "model.py", "config.json", "tokenizer.json"]:
                    (root / name).write_text("{}", encoding="utf-8")
            with patch.object(downloader.subprocess, "run", side_effect=populate):
                with self.assertRaisesRegex(ValueError, "missing"):
                    downloader.prepare(config)
            self.assertFalse(Path(str(root) + ".provenance.json").exists())
            (root / "tokenizer_config.json").write_text("{}", encoding="utf-8")
            with patch.object(downloader.subprocess, "run") as run:
                downloader.prepare(config)
                downloader.prepare(config)
                self.assertEqual(run.call_count, 1)
                (root / "model.py").write_text("changed", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "differs from manifest"):
                    downloader.prepare(config)

    def test_unregistered_existing_model_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "julia"; self.populate(root)
            with patch.object(downloader.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, "Unregistered"):
                    downloader.prepare(self.config(root))
                run.assert_not_called()
            self.assertEqual((root / "model.safetensors").read_bytes(), b"test weights")

    def test_j33_pins_config_only_base_assets_and_verifies_them_on_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "j33-jev"
            names = ["config.json", "tokenizer.json", "tokenizer_config.json", "processor_config.json", "preprocessor_config.json"]
            base = {"repo": "google/embeddinggemma-2", "revision": "e" * 40, "include": names}
            config = {"model_path": str(root), "model_id": "J33-AI/j33-jev", "revision": "d" * 40, "base": base}
            def populate(args, **_kwargs):
                path = Path(args[args.index("--local-dir") + 1]); path.mkdir(parents=True, exist_ok=True)
                for name in names if args[2] == base["repo"] else ["model.safetensors", "gemma_jev.py"]:
                    (path / name).write_text("{}", encoding="utf-8")
            with patch.object(downloader.subprocess, "run", side_effect=populate) as run:
                downloader.prepare(config)
                self.assertEqual(run.call_count, 2)
                args = run.call_args.args[0]
                self.assertEqual(args[args.index("--revision") + 1], "e" * 40)
                self.assertEqual(args[3:args.index("--revision")], names)
            provenance = json.loads(Path(str(root) + ".provenance.json").read_text())
            self.assertEqual(provenance["base"], base)
            self.assertIn("base/tokenizer.json", provenance["files_sha256"])
            with patch.object(downloader.subprocess, "run") as run:
                downloader.prepare(config); run.assert_not_called()
                with self.assertRaisesRegex(ValueError, "base assets differ"):
                    downloader.prepare({**config, "base": {**base, "revision": "f" * 40}})
                (root / "base/tokenizer.json").write_text("changed", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "differs from manifest"):
                    downloader.prepare(config)
                run.assert_not_called()

    def test_post_download_verification_failure_keeps_pending_without_completed_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "julia"
            with patch.object(downloader.subprocess, "run", side_effect=lambda *_args, **_kwargs: self.populate(root)), \
                 patch.object(downloader, "verify_checkpoint", side_effect=ValueError("broken inventory")):
                with self.assertRaisesRegex(ValueError, "broken inventory"):
                    downloader.prepare(self.config(root))
            self.assertTrue(Path(str(root) + ".download-plan.json").exists())
            self.assertFalse(Path(str(root) + ".provenance.json").exists())


if __name__ == "__main__":
    unittest.main()
