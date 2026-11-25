#!/usr/bin/env python3
"""Regression checks for credentials written by the iOS pairing flow."""

from pathlib import Path
import unittest


SOURCE = (
    Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBConnection.m"
).read_text(encoding="utf-8")


class PairingCredentialsTests(unittest.TestCase):
    def test_pairing_syncs_app_intent_credentials_after_saving_token(self):
        marker = "GBConnection.shared.deviceToken = token;"
        source = SOURCE[SOURCE.index(marker) :]
        sync = source.index("GBSyncAppIntentCredentials();")
        dismiss = source.index("dismissViewControllerAnimated:YES", sync)
        self.assertLess(sync, dismiss)

    def test_both_restore_and_connection_edit_keep_the_sync(self):
        self.assertGreaterEqual(SOURCE.count("GBSyncAppIntentCredentials();"), 4)

    def test_disconnect_synchronizes_defaults_and_clears_paired_bundle_dir(self):
        self.assertIn("standardUserDefaults synchronize", SOURCE)
        self.assertIn('URLByAppendingPathComponent:@"GrokBotPaired"', SOURCE)

    def test_bootstrap_intercepts_signout_and_login_screen_host_entry(self):
        bootstrap = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBBootstrap.m"
        ).read_text(encoding="utf-8")
        app_intents = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBAppIntents.m"
        ).read_text(encoding="utf-8")
        self.assertIn("GBSignOutLabels", bootstrap)
        self.assertIn("GBIsSettingsSignOutContext", bootstrap)
        self.assertNotIn('@"Account", @"账户", @"帳戶"', bootstrap)
        self.assertIn("GBClearHostSettingsIdentifier", bootstrap)
        self.assertIn("GBHasAncestorPluginTag", bootstrap)
        self.assertIn("GBSubtreeHasStyledHostButton", bootstrap)
        self.assertIn("confirmSignOut", bootstrap)
        self.assertIn("[GBConnection.shared disconnect]", bootstrap)
        self.assertIn("GBPrimaryLoginLabels", bootstrap)
        self.assertIn("GBSecondaryLoginLabels", bootstrap)
        self.assertIn("isFabricView && !paired && [primaryLogin containsObject:label]", bootstrap)
        self.assertIn("isFabricView && !paired && [secondaryLogin containsObject:label]", bootstrap)
        self.assertIn('NSClassFromString(@"RCTViewComponentView")', bootstrap)
        self.assertIn('@"Sign in with Apple"', bootstrap)
        self.assertIn('@"退出登录"', bootstrap)
        self.assertIn('GBDeleteAppIntentCredential(@"x.money.agent-connection-code:no-auth",\n                                  @"grok-bot", defaultGroup);', app_intents)
        self.assertIn('GBDeleteAppIntentCredential(@"app:no-auth",\n                                  @"sand.cursor-tokens", nil);', app_intents)
        self.assertIn("GBGlobalSettingsContextState", bootstrap)
        self.assertIn("GBSettingsContextUnknown", bootstrap)
        self.assertIn("GBInvalidateSettingsContextCache", bootstrap)
        self.assertIn("GBNoteSettingsMarkerOnView", bootstrap)
        self.assertIn("GBVerifyAppIntentCredentialsAsync", bootstrap)
        self.assertNotIn("if (matched || epoch == GBSettingsContextEpoch)", bootstrap)
        push = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBPush.m"
        ).read_text(encoding="utf-8")
        self.assertIn("GBSettingsContextState settingsState = GBGlobalSettingsContextState(view);", push)
        self.assertIn("settingsState == GBSettingsContextNo", push)
        library = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBLibrary.m"
        ).read_text(encoding="utf-8")
        self.assertIn('[path hasPrefix:@"/api/"]', library)
        self.assertIn('[path.lastPathComponent isEqualToString:@"openAgentWindowed"]', library)
        connectors = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBConnectors.m"
        ).read_text(encoding="utf-8")
        diagnostics = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBDiagnostics.m"
        ).read_text(encoding="utf-8")
        self.assertNotIn("GBInstallSessionConfigurationProvider", connectors)
        self.assertIn("sessionWithConfiguration:delegate:delegateQueue:", connectors)
        self.assertIn("config.identifier.length", connectors)
        self.assertIn("GBResolveReactSymbol", diagnostics)
        self.assertIn('@"RCTFatalException"', diagnostics)
        self.assertIn('@"Bot computer"', bootstrap)
        voice = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBVoice.m"
        ).read_text(encoding="utf-8")
        self.assertIn("isVoiceStatusRequest:", voice)
        self.assertIn('[request.URL.host.lowercaseString isEqual:@"local.voice"]', voice)
        self.assertIn('[request.URL.path isEqual:@"/local/voice/status"]', voice)
        self.assertIn('@"Cache-Control":@"no-store"', voice)
        perf_h = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBPerf.h"
        ).read_text(encoding="utf-8")
        perf_m = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBPerf.m"
        ).read_text(encoding="utf-8")
        deeplinks = (
            Path(__file__).resolve().parents[1] / "clients" / "ios" / "GBDeepLinks.m"
        ).read_text(encoding="utf-8")
        self.assertIn("BOOL GBPerfHandleURL(NSURL *url);", perf_h)
        self.assertNotIn("GBPerfInstallGesture", perf_h)
        self.assertNotIn("GBPerfInstallGesture", perf_m)
        self.assertNotIn("UITapGestureRecognizer", perf_m)
        self.assertIn("GBDiagnosticsEnabled()", perf_m)
        self.assertIn("isfinite(", perf_m)
        self.assertIn("GBPerfUninstallProbes()", perf_m)
        self.assertNotIn("GBPerfOriginalPerform = NULL;", perf_m)
        self.assertNotIn("GBPerfOriginalLayoutMetrics = NULL;", perf_m)
        self.assertNotIn("GBPerfOriginalProps = NULL;", perf_m)
        self.assertIn("NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication", perf_m)
        self.assertIn('![hooks isEqualToString:@"on"]', perf_m)
        self.assertNotIn("GBPerfInstallGesture", deeplinks)
        self.assertIn("if (GBPerfHandleURL(url)) return YES;", deeplinks)
        self.assertIn("GBHandledInitialPerfURL", deeplinks)
        self.assertIn("__builtin_expect(GBPerfActive, 0)", bootstrap)


if __name__ == "__main__":
    unittest.main()
