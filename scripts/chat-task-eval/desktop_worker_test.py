import json
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


if __name__ == "__main__":
    unittest.main()
