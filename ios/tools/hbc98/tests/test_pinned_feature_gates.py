from __future__ import annotations

import base64
import json
import unittest
from pathlib import Path

from ios.release import bytepatch
from ios.tools.build_ios_127_recipe import (
    BUILD_PINNED_GATE_FUNCTION as BUILD_PINNED_GATE_127_FUNCTION,
    EXPECTED_GATEWAY_127_SHA256,
    PINNED_ENABLED_FEATURE_GATES,
    assert_pinned_feature_gates as assert_pinned_feature_gates_127,
    build_pinned_feature_gates_body as build_pinned_feature_gates_body_127,
)
from ios.tools.build_ios_128_recipe import (
    BUILD_PINNED_GATE_FUNCTION as BUILD_PINNED_GATE_128_FUNCTION,
    EXPECTED_GATEWAY_128_SHA256,
    assert_pinned_feature_gates as assert_pinned_feature_gates_128,
    build_pinned_feature_gates_body as build_pinned_feature_gates_body_128,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
RECIPES_DIR = REPO_ROOT / 'ios' / 'recipes' / 'ios'
RECIPES_127_DIR = RECIPES_DIR / '1.27.0'

# Relocated offset of patched buildPinnedGate (fn#27266) in 1.28.0 gateway-template.hbc.
BUILD_PINNED_GATE_128_OFFSET = 40391000
EXPECTED_PINNED_GATE_128_ADD_PREFIX = bytes.fromhex(
    '890201'
    '9003d59d'
    'd4140000000203'
    '900317de'
    'd4090000000203'
    'ae06'
    '95'
)

# Relocated offset of patched buildPinnedGate (fn#19464) in 1.27.0 gateway-template.hbc.
BUILD_PINNED_GATE_127_OFFSET = 38725456
EXPECTED_PINNED_GATE_127_ADD_PREFIX = bytes.fromhex(
    '890201'
    '900326cd'
    'd4140000000203'
    '9003eab9'
    'd4090000000203'
    'ae06'
    '95'
)


class PinnedFeatureGatesTests(unittest.TestCase):
    def test_127_and_128_pinned_gates_include_inline_canvas_flags(self):
        self.assertEqual(BUILD_PINNED_GATE_128_FUNCTION, 27266)
        self.assertEqual(BUILD_PINNED_GATE_127_FUNCTION, 19464)
        self.assertTrue(callable(build_pinned_feature_gates_body_128))
        self.assertTrue(callable(assert_pinned_feature_gates_128))
        self.assertTrue(callable(build_pinned_feature_gates_body_127))
        self.assertTrue(callable(assert_pinned_feature_gates_127))
        required = {
            'cloud_canvas_skill',
            'grok_bot_canvas_skill',
        }
        self.assertTrue(required.issubset(set(PINNED_ENABLED_FEATURE_GATES)))
        self.assertEqual(
            len(PINNED_ENABLED_FEATURE_GATES),
            len(set(PINNED_ENABLED_FEATURE_GATES)),
        )

    def _assert_recipe_pins_canvas_gates(
        self,
        recipes_dir: Path,
        expected_sha256: str,
        target_pin_offset: int,
        expected_prefix: bytes,
    ):
        gateway_recipe = bytepatch.load(recipes_dir / 'gateway-template.hbc.gbp.gz')
        metadata_recipe = bytepatch.load(recipes_dir / 'gateway-template.json.gbp.gz')
        self.assertEqual(gateway_recipe['targetSha256'], expected_sha256)

        self.assertEqual(len(metadata_recipe['ops']), 1)
        self.assertEqual(metadata_recipe['ops'][0][0], 'add')
        metadata = json.loads(
            base64.b64decode(metadata_recipe['ops'][0][1], validate=True)
        )
        self.assertEqual(metadata['templateSha256'], expected_sha256)

        target_offset = 0
        emitted_prefix = None
        for op in gateway_recipe['ops']:
            if op[0] == 'copy':
                target_offset += op[2]
            else:
                raw = base64.b64decode(op[1], validate=True)
                if target_offset <= target_pin_offset < target_offset + len(raw):
                    rel = target_pin_offset - target_offset
                    emitted_prefix = raw[rel:rel + len(expected_prefix)]
                    break
                target_offset += len(raw)
        self.assertEqual(emitted_prefix, expected_prefix)

    def test_committed_128_gateway_recipe_pins_canvas_feature_gates(self):
        self._assert_recipe_pins_canvas_gates(
            RECIPES_DIR,
            EXPECTED_GATEWAY_128_SHA256,
            BUILD_PINNED_GATE_128_OFFSET,
            EXPECTED_PINNED_GATE_128_ADD_PREFIX,
        )

    def test_committed_127_fallback_gateway_recipe_pins_canvas_feature_gates(self):
        self._assert_recipe_pins_canvas_gates(
            RECIPES_127_DIR,
            EXPECTED_GATEWAY_127_SHA256,
            BUILD_PINNED_GATE_127_OFFSET,
            EXPECTED_PINNED_GATE_127_ADD_PREFIX,
        )


if __name__ == '__main__':
    unittest.main()
