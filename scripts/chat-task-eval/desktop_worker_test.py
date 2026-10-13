import contextlib
import io
import json
import sys
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import PureWindowsPath
import unittest

import desktop_worker as worker


class PosixKeysTest(unittest.TestCase):
    def test_windows_path_keys_match_the_manifest_form(self):
        key = str(PureWindowsPath("backbone/config.json"))
        self.assertEqual(key, r"backbone\config.json")
        self.assertEqual(worker.posix_keys({key: "a", "decision_config.json": "b"}),
                         {"backbone/config.json": "a", "decision_config.json": "b"})

    def test_only_keys_change_and_nesting_is_followed(self):
        value = {"files": {r"a\b": r"c:\keep\values"}, "rows": [{r"x\y": 1}], "n": 3}
        self.assertEqual(worker.posix_keys(value), {"files": {"a/b": r"c:\keep\values"}, "rows": [{"x/y": 1}], "n": 3})
        json.dumps(worker.posix_keys(value))


class InferencePrivacyTest(unittest.TestCase):
    def run_worker(self, fail):
        secret = "PRIVATE CHAT CONTENT"
        def infer(**request):
            print(secret)
            print(secret, file=sys.stderr)
            if fail:
                raise ValueError(secret)
            return {"answer": "ok"}
        class Memory:
            peak = 1
            def __init__(self, process): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
        process = SimpleNamespace(cpu_times=lambda: SimpleNamespace(user=0, system=0))
        modules = {
            "torch": SimpleNamespace(set_num_threads=lambda n: None, set_num_interop_threads=lambda n: None,
                                     manual_seed=lambda n: None, inference_mode=contextlib.nullcontext),
            "psutil": SimpleNamespace(Process=lambda: process),
            "local_worker": SimpleNamespace(verify_checkpoint=lambda *args: ({"revision": "rev"}, None), MemorySampler=Memory),
            "transformers": SimpleNamespace(AutoModel=SimpleNamespace(from_pretrained=lambda *a, **k: SimpleNamespace(system_one=infer))),
        }
        stdout, stderr = io.StringIO(), io.StringIO()
        stdin = SimpleNamespace(buffer=io.BytesIO((json.dumps({"id": 1, "request": {"text": secret}}) + "\n").encode()))
        with patch.dict(sys.modules, modules), patch.object(sys, "argv", ["worker", ".", "vllm-sr/Decision-2.0-Kai-0.6B", "rev", "1"]), \
                patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                patch.dict(worker.os.environ), patch.object(worker, "ready", False):
            worker.main()
        self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        return [json.loads(line) for line in stdout.getvalue().splitlines()]

    def test_inference_exception_is_generic_and_has_no_traceback(self):
        self.assertEqual(self.run_worker(True)[1], {"id": 1, "error": "inference_failed"})

    def test_successful_inference_does_not_log_model_output(self):
        self.assertEqual(self.run_worker(False)[1]["raw"], {"answer": "ok"})


if __name__ == "__main__":
    unittest.main()
