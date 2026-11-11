# ProkBot Plus Windows Patch

Connect Grok Bot 0.71.2 for Windows x64 to your Host. Requires Windows 10/11 x64, Node.js 22.12+ and the full repository (the client code and patch tools in `mac/` are shared).

The complete deployment steps are in the [AI deployment guide](../docs/AI-INSTALL.en.md#91-windows-1011-x64), and how it works is in the [technical documentation](../docs/ARCHITECTURE.en.md#windows-client-new-in-this-version).

[简体中文](README.md)

## Use

From the repository root:

```powershell
node windows/patchers/desktop/patch.mjs
```

The tool downloads and verifies the official `Grok_Bot_0.71.2_Setup.exe` and writes to `windows/output/`:

| Output | Purpose |
| --- | --- |
| `Grok Bot Local/` | Portable folder; run `Grok Bot.exe` inside it |
| `GrokBotLocal-0.71.2-x64-portable.zip` | Portable archive; extract and run |
| `GrokBotLocal-0.71.2-x64-Setup.exe` | Per-user installer into `%LOCALAPPDATA%\Programs\Grok Bot Local`, no administrator rights |

Open the client and enter your Host address and six-character pairing code. To use an existing original installer, `app-64.7z` or installed original folder, pass `--source`; `--no-installer` builds the portable outputs only.

The installer accepts `/S` (silent) and `/D=folder` (last). Uninstall from Settings → Apps or run `Uninstall Grok Bot Local.exe` in the installation folder; pairing and settings live in `%APPDATA%\Grok Bot Local` and can be kept.

Use an absolute path for a custom destination. Choose a new or empty folder, or an existing ProkBot Plus installation. The installer refuses other non-empty folders; the uninstaller refuses official and portable clients.

## Notes

- The original package is extracted with the `tar.exe` included in Windows 11; on Windows 10 install 7-Zip (or set `GROKBOT_7Z` to `7z.exe`).
- The patch updates the ASAR integrity value embedded in `Grok Bot.exe` and removes the official signature that the change invalidates. If SmartScreen appears on first run, choose Run anyway; computers with Smart App Control enabled block unsigned programs.
- Supported: conversations, notifications (notification-area icon, Start menu shortcut), attachments, Tailcat, local command execution and Codex delegation. The original graphical computer-use helper exists only for macOS, so the Windows client does not offer local mouse and keyboard control yet.
- Local commands use the original executor. When the client is started normally it runs Windows PowerShell with the original UTF-8 output option turned on, so non-ASCII output is not garbled. Start the client from the Start menu or the desktop shortcut: when it is started from Git Bash, the original executor switches to Git Bash, which rewrites arguments such as `cmd /c`.
- Codex delegation uses the local `codex.exe` (including npm installs) with this computer's Codex sign-in and model.

## Maintenance

- `patchers/desktop/original.mjs`: carves `app-64.7z` out of the official installer and extracts it; the Android patcher uses it too.
- `tools/port-desktop-recipes.mjs`: derives the Windows recipes from the Mac recipes and both originals, checking that every copied range keeps its structure.
- `installer/`: installer source (Go standard library only), `go build -trimpath -ldflags="-H=windowsgui -s -w" -o ../dist/installer/grokbot-setup-stub.exe .`
- `dist/network/grokbot-tailcat.exe`: `python host/network/build-tailcat.py --target windows-amd64 --output windows/dist/network`
- Tests: `node --test "windows/tests/*.test.mjs"`

## License and support

Noncommercial use only. See [LICENSE](../LICENSE). Most code in this project was generated with AI assistance.
