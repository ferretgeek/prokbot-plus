# ProkBot Plus iOS Patch

[简体中文](README.md)

Patch a decrypted Grok Bot 1.28.0 (29649, recommended), 1.27.0 (29519, fallback), 1.26.0 (29388, fallback) or 1.16.0 (23152, fallback) arm64 IPA; the patcher matches the pinned manifest by version and SHA-256 automatically. The app and all three extensions must be decrypted. Requires Python 3.10+. This repository does not provide any original or modified IPA; bring your own.

For the full deployment steps see the [deployment guide](../docs/AI-INSTALL.en.md#client-packages); for how it works see the [technical documentation](../docs/ARCHITECTURE.en.md#ios-client).

## Use

```sh
python3 release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./GrokBot-Patched \
  --bundle-id dev.grokbot.local
```

Outputs `GrokBot-Local-resignable.ipa`, `GrokBotLocal.dylib` and `extension-signing.json`. Sign and install it with your own tools as described below, then enter your Host address and 6-character pairing code.

Push notifications use APNs or Bark, configured in the Host console. Enable realtime voice in the app settings.

## Signing

The patch keeps the Widgets, Share and NotificationService extensions. Configure a provisioning profile for each of the four targets:

| Target | Bundle ID |
| --- | --- |
| Main app | Your `--bundle-id` value |
| Widgets | `<main ID>.widgets` |
| Share | `<main ID>.share` |
| NotificationService | `<main ID>.NotificationService` |

- All four targets use the same App Group, `group.<main ID>` by default. Set another one with `--app-group`.
- The shared keychain group is `<AppIdentifierPrefix>.<main ID>.shared`. Add it to the signing entitlements of all four targets, and set each target's Info.plist `SandKeychainAccessGroups` to an array containing it. If the main app or any extension Info.plist contains a `GrokAppProtection` dictionary, update its `appGroupIdentifiers` and `keychainAccessGroups` as well (`patch-app.py` and `extensions.py` isolate both automatically).
- The generated `extension-signing.json` lists this configuration (including the `GrokAppProtection` requirement).
- When extensions are kept but a provisioning profile omits the requested App Group, `signing.py` prints a clear warning and omits that entitlement (widgets, share and notification extensions may not share state with the main app).
- An app signed with the APNs entitlement uses APNs, with credentials configured in the Host. Otherwise, enter a Bark URL in the app's notification settings.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most of this project's code was written with AI assistance.
