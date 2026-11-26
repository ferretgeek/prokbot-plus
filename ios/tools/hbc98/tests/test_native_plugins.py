from __future__ import annotations

import base64
import json
import unittest
from pathlib import Path

from ios.release import bytepatch
from ios.tools.build_ios_126_recipe import (
    EMPTY_ARRAY_STUB,
    EXPECTED_GATEWAY_SHA256_WITH_AVATAR_MOTION,
    NATIVE_PLUGIN_ENTRIES_FUNCTION as NATIVE_PLUGIN_ENTRIES_126,
    assert_native_plugin_entries_hidden as assert_native_plugin_entries_hidden_126,
)
from ios.tools.build_ios_127_recipe import (
    EXPECTED_GATEWAY_127_SHA256,
    NATIVE_PLUGIN_ENTRIES_FUNCTION as NATIVE_PLUGIN_ENTRIES_127,
    NATIVE_PLUGIN_ENTRIES_OFFSET as NATIVE_PLUGIN_ENTRIES_OFFSET_127,
    assert_native_plugin_entries_hidden as assert_native_plugin_entries_hidden_127,
)
from ios.tools.build_ios_128_recipe import (
    EXPECTED_GATEWAY_128_SHA256,
    NATIVE_PLUGIN_ENTRIES_FUNCTION as NATIVE_PLUGIN_ENTRIES_128,
    NATIVE_PLUGIN_ENTRIES_OFFSET as NATIVE_PLUGIN_ENTRIES_OFFSET_128,
    assert_native_plugin_entries_hidden as assert_native_plugin_entries_hidden_128,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
RECIPES_DIR = REPO_ROOT / 'ios' / 'recipes' / 'ios'
RECIPES_127_DIR = RECIPES_DIR / '1.27.0'
RECIPES_126_DIR = RECIPES_DIR / '1.26.0'


class NativePluginEntriesPatchTests(unittest.TestCase):
    def test_constants_and_assertion_helper(self):
        self.assertEqual(NATIVE_PLUGIN_ENTRIES_128, 56807)
        self.assertEqual(NATIVE_PLUGIN_ENTRIES_127, 45655)
        self.assertEqual(NATIVE_PLUGIN_ENTRIES_126, 52198)
        self.assertEqual(EMPTY_ARRAY_STUB, bytes.fromhex('080000007600'))
        self.assertTrue(callable(assert_native_plugin_entries_hidden_128))
        self.assertTrue(callable(assert_native_plugin_entries_hidden_127))
        self.assertTrue(callable(assert_native_plugin_entries_hidden_126))

    def _assert_recipe_hides_native_plugin_entries(
        self,
        recipes_dir: Path,
        expected_sha256: str,
        expected_offset: int,
        expected_add_bytes: bytes,
    ):
        gateway_recipe = bytepatch.load(recipes_dir / 'gateway-template.hbc.gbp.gz')
        metadata_recipe = bytepatch.load(recipes_dir / 'gateway-template.json.gbp.gz')
        self.assertEqual(gateway_recipe['targetSha256'], expected_sha256)

        # Verify the metadata recipe points at the same updated gateway template.
        self.assertEqual(len(metadata_recipe['ops']), 1)
        self.assertEqual(metadata_recipe['ops'][0][0], 'add')
        metadata = json.loads(
            base64.b64decode(metadata_recipe['ops'][0][1], validate=True)
        )
        self.assertEqual(metadata['templateSha256'], expected_sha256)

        # Verify the exact equal-length cover (NewArray r0,0; Ret r0)
        # is emitted at useNativePluginEntries' offset.
        target_offset = 0
        found = None
        for op in gateway_recipe['ops']:
            if op[0] == 'copy':
                target_offset += op[2]
            else:
                raw = base64.b64decode(op[1], validate=True)
                if target_offset == expected_offset:
                    found = raw
                    break
                target_offset += len(raw)
        self.assertEqual(found, expected_add_bytes)

    def test_committed_128_gateway_recipe_hides_native_plugin_entries(self):
        self._assert_recipe_hides_native_plugin_entries(
            RECIPES_DIR,
            EXPECTED_GATEWAY_128_SHA256,
            NATIVE_PLUGIN_ENTRIES_OFFSET_128,
            EMPTY_ARRAY_STUB,
        )

    def test_committed_127_fallback_gateway_recipe_hides_native_plugin_entries(self):
        # In 1.27.0 byte 6 of stock useNativePluginEntries is already 0x00
        # (LoadFromEnvironment 5, 4, 0), so bytepatch reuses it in the next COPY.
        self._assert_recipe_hides_native_plugin_entries(
            RECIPES_127_DIR,
            EXPECTED_GATEWAY_127_SHA256,
            NATIVE_PLUGIN_ENTRIES_OFFSET_127,
            EMPTY_ARRAY_STUB,
        )

    def test_committed_126_fallback_gateway_recipe_hides_native_plugin_entries(self):
        self._assert_recipe_hides_native_plugin_entries(
            RECIPES_126_DIR,
            EXPECTED_GATEWAY_SHA256_WITH_AVATAR_MOTION,
            31163313,
            EMPTY_ARRAY_STUB + b'\x00',
        )


if __name__ == '__main__':
    unittest.main()
