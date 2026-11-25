from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import unittest

from ios.release import bytepatch
from ios.tools.build_ios_128_recipe import (
    EXPECTED_GATEWAY_128_SHA256,
    PORTED_FUNCTIONS,
    SETTINGS_SHEET_MODULE_FUNCTION,
    SETTINGS_TRY_ON_SELFIE_ENV_SLOT,
    VOICE_APPLY_STATUS_FUNCTION,
    VOICE_CALL_SUB_FUNCTION,
    VOICE_CATCH_STATUS_FUNCTION,
    VOICE_DISPOSE_FUNCTION,
    VOICE_SNAPSHOT_FUNCTION,
    VOICE_SUBSCRIBE_FUNCTION,
    VOICE_SYNC_STATUS_FUNCTION,
    VOICE_TOGGLE_CHANGE_FUNCTION,
    VOICE_TOGGLE_GROUP_FUNCTION,
    assert_realtime_voice_wired,
    build_realtime_voice_bodies,
)
from ios.tools.hbc98.opcodes import OpcodeSet
from ios.tools.hbc98.requirements import body_requirements

REPO_ROOT = Path(__file__).resolve().parents[4]
RECIPES_DIR = REPO_ROOT / 'ios' / 'recipes' / 'ios'


class RealtimeVoice128Tests(unittest.TestCase):
    def test_128_voice_constants_and_unrendered_select_not_overwritten(self):
        self.assertEqual(SETTINGS_SHEET_MODULE_FUNCTION, 6665)
        self.assertEqual(SETTINGS_TRY_ON_SELFIE_ENV_SLOT, 39)
        self.assertNotIn(44896, PORTED_FUNCTIONS)
        self.assertNotIn(45621, PORTED_FUNCTIONS.values())
        self.assertEqual(VOICE_TOGGLE_GROUP_FUNCTION, 94844)
        self.assertEqual(VOICE_CALL_SUB_FUNCTION, 94845)
        self.assertEqual(VOICE_APPLY_STATUS_FUNCTION, 94846)
        self.assertEqual(VOICE_CATCH_STATUS_FUNCTION, 94847)
        self.assertEqual(VOICE_SYNC_STATUS_FUNCTION, 94848)
        self.assertTrue(callable(assert_realtime_voice_wired))

    def test_build_realtime_voice_bodies_decodes_cleanly(self):
        opcodes = OpcodeSet.load_default()
        words = (
            'Object', 'values', 'forEach', 'enabled', 'fetch', 'then', 'catch',
            'store', 'getString', 'true', 'subscribe', 'dispose', 'hangUp',
            'write', 'grokbot', '.', 'voice', 'storage', 'service', 'host',
            'subs', 'seq', 'pending', 'local', 'https://', '/', 'status',
        )
        fake_strs = tuple(
            SimpleNamespace(index=i, text=w) for i, w in enumerate(words)
        )
        replaced, added = build_realtime_voice_bodies(opcodes, fake_strs)
        self.assertEqual(
            set(replaced),
            {
                VOICE_SNAPSHOT_FUNCTION,
                VOICE_SUBSCRIBE_FUNCTION,
                VOICE_DISPOSE_FUNCTION,
                VOICE_TOGGLE_CHANGE_FUNCTION,
            },
        )
        self.assertEqual(
            set(added),
            {
                VOICE_CALL_SUB_FUNCTION,
                VOICE_APPLY_STATUS_FUNCTION,
                VOICE_CATCH_STATUS_FUNCTION,
                VOICE_SYNC_STATUS_FUNCTION,
            },
        )
        for body in (*replaced.values(), *(spec[1] for spec in added.values())):
            insns = opcodes.decode(body, 0, len(body))
            self.assertGreater(len(insns), 3)
            self.assertLessEqual(body_requirements(opcodes, body).frame_size, 16)
            valid_offsets = {ins.offset for ins in insns}
            for ins in insns:
                if ins.name.startswith('J'):
                    self.assertIn(ins.offset + ins.operands[0], valid_offsets)

    def test_committed_128_gateway_recipe_has_nonempty_verified_pin(self):
        self.assertEqual(len(EXPECTED_GATEWAY_128_SHA256), 64)
        gateway_128 = bytepatch.load(RECIPES_DIR / 'gateway-template.hbc.gbp.gz')
        self.assertEqual(gateway_128['targetSha256'], EXPECTED_GATEWAY_128_SHA256)


if __name__ == '__main__':
    unittest.main()
