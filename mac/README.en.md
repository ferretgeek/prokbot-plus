# ProkBot Plus Mac Patch

Connect Grok Bot 0.71.2 for Apple Silicon to your Host. Requires Node.js 22.12+.

The complete deployment steps are in the [AI deployment guide](../docs/AI-INSTALL.en.md#92-mac-apple-silicon), and how it works is in the [technical documentation](../docs/ARCHITECTURE.en.md#mac-client). `clients/desktop/` is the client's main process; the Windows and Android clients use its code too.

[简体中文](README.md)

## Use

```sh
node patchers/desktop/patch.mjs
```

Automatically downloads and verifies the 0.71.2 Apple Silicon original, then generates `output.noindex/Grok Bot.app`. Move it into Applications and enter your Host address and six-character pairing code.

To use an existing `.app` or `.dmg`, add `--source "/path/to/Grok Bot.app"`.

For local graphical control, add `--identity auto` to sign with an existing certificate.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most code in this project was generated with AI assistance.
