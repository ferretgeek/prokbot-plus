"""Static guardrails for the iOS 1.26 App Intents compatibility path."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AppIntentsCompatibility(unittest.TestCase):
    def test_1_26_credentials_include_a_non_expiring_local_refresh_marker(self):
        source = (ROOT / 'clients' / 'ios' / 'GBAppIntents.m').read_text(encoding='utf-8')
        self.assertIn('@"refreshToken": marker', source)
        self.assertIn('@"exp": @4070908800LL', source)
        self.assertIn('@"type": @"sand_mobile"', source)
        self.assertIn('tokenStoreStatus == errSecSuccess && appIntentStatus == errSecSuccess', source)
        self.assertIn('void GBVerifyAppIntentCredentials(void)', source)

    def test_embedded_bundle_validation_is_opt_in(self):
        source = (ROOT / 'clients' / 'ios' / 'GBBootstrap.m').read_text(encoding='utf-8')
        self.assertIn('GROKBOT_VALIDATE_EMBEDDED_BUNDLE', source)
        self.assertIn('useEmbeddedBundle ? url : (paired ?: url)', source)
        self.assertIn('GBLoadedPairedBundle = paired != nil && !useEmbeddedBundle', source)


if __name__ == '__main__':
    unittest.main()
