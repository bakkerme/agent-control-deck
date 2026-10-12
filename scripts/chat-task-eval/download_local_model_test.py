"""Download routing/provenance checks without network access or model weights."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import download_local_model as downloader
from local_worker import sha256, verify_checkpoint

REVISION = "a" * 40


def write_checkpoint(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / "code.py").write_text("# synthetic checkpoint\n", encoding="utf-8")
    (root / "MODEL_MANIFEST.json").write_text(json.dumps({
        "model_name": "Decision-2.0-Kai-0.6B",
        "files_sha256": {"code.py": sha256(root / "code.py")},
    }), encoding="utf-8")


class DownloadTests(unittest.TestCase):
    def test_cli_download_pins_revision_and_preserves_paths_with_spaces(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model with spaces"
            cli = str(Path(directory) / "tools with spaces" / "hf")

            def run(command, **options):
                self.assertEqual(command, [cli, "download", downloader.MODEL_ID,
                                          "--revision", REVISION, "--local-dir", str(root.resolve())])
                self.assertEqual(options, {"check": True, "shell": False})
                write_checkpoint(root)

            # Supplying a revision needs no huggingface_hub library or model imports.
            with patch.dict(sys.modules, {"huggingface_hub": None}), \
                 patch.object(downloader, "find_hf", return_value=cli), \
                 patch.object(downloader.subprocess, "run", side_effect=run) as call:
                provenance = downloader.download_checkpoint(root, REVISION, "hf")
            call.assert_called_once()
            self.assertEqual(provenance["revision"], REVISION)
            self.assertEqual(provenance["download_backend"], "hf")
            pinned, _ = verify_checkpoint(root, downloader.MODEL_ID)
            self.assertEqual(pinned, provenance)

    def test_default_python_route_resolves_once_and_downloads_that_commit(self):
        calls = []

        def model_info(repo):
            calls.append(repo)
            return SimpleNamespace(sha=REVISION)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model"

            def snapshot_download(**options):
                self.assertEqual(options, {"repo_id": downloader.MODEL_ID,
                                          "revision": REVISION, "local_dir": str(root.resolve())})
                write_checkpoint(root)

            hub = SimpleNamespace(HfApi=lambda: SimpleNamespace(model_info=model_info),
                                  snapshot_download=snapshot_download)
            with patch.dict(sys.modules, {"huggingface_hub": hub}):
                provenance = downloader.download_checkpoint(root)
            self.assertEqual(calls, [downloader.MODEL_ID])
            self.assertEqual(provenance["download_backend"], "python")

    def test_failed_cli_retains_partial_download_without_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model"

            def fail(command, **_):
                root.mkdir()
                (root / "partial").write_text("incomplete", encoding="utf-8")
                raise subprocess.CalledProcessError(1, command)

            with patch.object(downloader, "find_hf", return_value="hf"), \
                 patch.object(downloader.subprocess, "run", side_effect=fail):
                with self.assertRaises(subprocess.CalledProcessError):
                    downloader.download_checkpoint(root, REVISION, "hf")
            self.assertTrue((root / "partial").exists())
            self.assertFalse(Path(str(root.resolve()) + ".provenance.json").exists())

    def test_invalid_inputs_and_existing_checkpoints_fail_before_network_or_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model"
            with patch.dict(sys.modules, {"huggingface_hub": None}), \
                 patch.object(downloader, "find_hf") as find:
                with self.assertRaisesRegex(ValueError, "full commit SHA"):
                    downloader.download_checkpoint(root, "main", "hf")
                with self.assertRaisesRegex(ValueError, "requires --backend hf"):
                    downloader.download_checkpoint(root, REVISION, hf_executable="hf")
                write_checkpoint(root)
                with self.assertRaisesRegex(ValueError, "empty model directory"):
                    downloader.download_checkpoint(root, backend="hf")
                find.assert_not_called()

    def test_cli_lookup_prefers_selected_python_environment_then_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sibling = root / ("hf.exe" if sys.platform == "win32" else "hf")
            with patch.object(downloader.sys, "executable", str(root / "python")), \
                 patch.object(downloader.shutil, "which", return_value="path-hf") as which:
                sibling.touch()
                self.assertEqual(downloader.find_hf(), str(sibling))
                which.assert_not_called()
                sibling.unlink()
                self.assertEqual(downloader.find_hf(), "path-hf")
                self.assertEqual(downloader.find_hf("custom-hf"), "path-hf")
                which.assert_called_with("custom-hf")

    def test_missing_cli_fails_before_revision_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(downloader.sys, "executable", str(Path(directory) / "python")), \
                 patch.object(downloader.shutil, "which", return_value=None), \
                 patch.dict(sys.modules, {"huggingface_hub": None}):
                with self.assertRaisesRegex(ValueError, "HF CLI not found"):
                    downloader.download_checkpoint(Path(directory) / "model", backend="hf")


if __name__ == "__main__":
    unittest.main()
