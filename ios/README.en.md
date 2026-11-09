# ProkBot Plus iOS Patch

Patch a decrypted Grok Bot 1.16.0 (23152) arm64 IPA. The app and all three extensions must be decrypted. Requires Python 3.10+. This repository does not provide any original or modified IPA; bring your own.

For the full deployment steps see the [AI install guide](../docs/AI-INSTALL.en.md); for how it works see the [technical documentation](../docs/ARCHITECTURE.en.md).

[简体中文](README.md)

## Use

```sh
python3 release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./GrokBot-Patched \
  --bundle-id dev.grokbot.local
```

Outputs `GrokBot-Local-resignable.ipa`, `GrokBotLocal.dylib` and `extension-signing.json`. Sign and install it with your own tools as described below, then enter your Host address and six-character pairing code.

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
- The shared keychain group is `<AppIdentifierPrefix>.<main ID>.shared`. Add it to the signing entitlements of all four targets, and set each target's Info.plist `SandKeychainAccessGroups` to an array containing it.
- The generated `extension-signing.json` lists this configuration.
- An app signed with the APNs entitlement uses APNs, with credentials configured in the Host. Otherwise, enter a Bark URL in the app's notification settings.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most code in this project was generated with AI assistance.
