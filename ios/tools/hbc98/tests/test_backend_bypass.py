from __future__ import annotations

import unittest
from pathlib import Path

from ios.release import bytepatch
from ios.tools.build_ios_127_recipe import (
    BACKEND_CALL_FUNCTION as BACKEND_CALL_127,
    BACKEND_CALL_PUBLIC_FUNCTION as BACKEND_CALL_PUBLIC_127,
    BACKEND_LOCAL_BYPASS_RPCS,
    EXPECTED_GATEWAY_127_SHA256,
    assert_backend_local_bypass as assert_backend_local_bypass_127,
)
from ios.tools.build_ios_128_recipe import (
    BACKEND_CALL_FUNCTION as BACKEND_CALL_128,
    BACKEND_CALL_PUBLIC_FUNCTION as BACKEND_CALL_PUBLIC_128,
    BACKEND_LOCAL_BYPASS_RPCS_128,
    EXPECTED_GATEWAY_128_SHA256,
    assert_backend_local_bypass as assert_backend_local_bypass_128,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
RECIPES_DIR = REPO_ROOT / 'ios' / 'recipes' / 'ios'
RECIPES_127_DIR = RECIPES_DIR / '1.27.0'


class BackendLocalBypassTests(unittest.TestCase):
    def test_127_and_128_bypass_lists_cover_auto_review_and_pages_rpcs(self):
        self.assertEqual(BACKEND_CALL_128, 32902)
        self.assertEqual(BACKEND_CALL_PUBLIC_128, 32904)
        self.assertEqual(BACKEND_CALL_127, 28177)
        self.assertEqual(BACKEND_CALL_PUBLIC_127, 28179)
        self.assertTrue(callable(assert_backend_local_bypass_128))
        self.assertTrue(callable(assert_backend_local_bypass_127))
        required = {
            'aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
            'aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
            'aiserver.v1.DashboardService/ListUserCanvases',
            'aiserver.v1.DashboardService/GetCanvasMetadata',
            'aiserver.v1.DashboardService/GetCanvasPayload',
            'aiserver.v1.DashboardService/SetCanvasVisibility',
            'aiserver.v1.DashboardService/SetPageAddress',
            'aiserver.v1.DashboardService/GetCanvasShareAccess',
            'aiserver.v1.DashboardService/UpdateCanvasShareAccess',
            'aiserver.v1.DashboardService/RefreshCanvasSources',
        }
        self.assertTrue(required.issubset(set(BACKEND_LOCAL_BYPASS_RPCS)))
        self.assertEqual(BACKEND_LOCAL_BYPASS_RPCS_128, BACKEND_LOCAL_BYPASS_RPCS)
        self.assertEqual(len(BACKEND_LOCAL_BYPASS_RPCS), len(set(BACKEND_LOCAL_BYPASS_RPCS)))

    def test_committed_128_and_127_gateway_recipes_match_updated_pins(self):
        gateway_128 = bytepatch.load(RECIPES_DIR / 'gateway-template.hbc.gbp.gz')
        self.assertEqual(gateway_128['targetSha256'], EXPECTED_GATEWAY_128_SHA256)
        gateway_127 = bytepatch.load(RECIPES_127_DIR / 'gateway-template.hbc.gbp.gz')
        self.assertEqual(gateway_127['targetSha256'], EXPECTED_GATEWAY_127_SHA256)


if __name__ == '__main__':
    unittest.main()
