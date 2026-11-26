# ProkBot Plus Mac Patch

[简体中文](README.md)

Connect Grok Bot 1.3.0 for macOS to your Host, on both Apple Silicon and Intel Macs. Requires Node.js 22.12+.

The complete deployment steps are in the [deployment guide](../docs/AI-INSTALL.en.md#client-packages), and how it works is in the [technical documentation](../docs/ARCHITECTURE.en.md#mac-client). `clients/desktop/` is the client's main process; the Windows, Linux and Android clients use its code too.

## Use

```sh
node patchers/desktop/patch.mjs
```

Automatically downloads and verifies the 1.3.0 original for this Mac's chip (the ARM64 build on Apple Silicon, the x64 build on Intel), then generates `output.noindex/Grok Bot.app`. Move it into Applications and enter your Host address and 6-character pairing code. Turn on the Tailcat switch on the connect screen only when pasting the connection link from Remote access in the Host console; leave it off for a LAN or HTTPS address. To build for a Mac with the other chip, add `--arch arm64` or `--arch x64`.

**Apple Silicon & Intel Macs**: the official 1.3.0 release provides separate Apple Silicon and Intel installers with identical application logic and preload modules, differing only in asset hashes and native binaries. Both `patchers/desktop/recipes/` and `patchers/desktop/x64/recipes/` are generated from the same anchored rules via `windows/tools/desktop-recipes/build.mjs` (`--target mac-arm64` / `--target mac-x64`) and add identical project code; Tailcat is provided for arm64 (`dist/network/`) and x86_64 (`dist/network/x64/`). 1.3.0 has been tested working on both Apple Silicon and Intel Macs. If it does not work on your Mac, download the **v1.15.0** Mac release package to build the previous `1.2.3`, or the **v1.7.0** Mac release package to build the `0.71.2` fallback.

To use an existing `.app` or `.dmg`, add `--source "/path/to/Grok Bot.app"`. A DMG is recognized by its size; for an `.app` built for the other chip, also add `--arch`.

`--verify-only` replays the fixed recipes in temporary storage without building a client. A supplied DMG must match the full archive SHA-256, and the Mac tool verifies the input app's signature. See the [version table](../README.en.md#client-versions) for accepted inputs and the latest official releases.

For local graphical control (Computer Use), add `--identity auto` to sign with an existing Apple Development / Developer ID certificate and update the trusted Team ID in `CUGrokBotService`.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most of this project's code was written with AI assistance.
