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

The installer accepts `/S` (silent) and `/D=folder` (last). For a regular install, uninstall from Settings → Apps or run `Uninstall Grok Bot Local.exe` in its folder. The new uninstaller keeps pairing, settings and personal files.

Use an absolute path for a new or empty folder, or a ProkBot Plus installation with an ownership receipt. The uninstaller refuses official, portable and receipt-less clients.

### Upgrading a legacy install

Quit the old client from its tray menu. When the new setup recognizes an install without a receipt, choose the side-by-side option, or run this PowerShell command from the folder containing the **new** setup. For a custom install, replace `$old` with the old folder's absolute path:

```powershell
$old = Join-Path $env:LOCALAPPDATA 'Programs\Grok Bot Local'
.\GrokBotLocal-0.71.2-x64-Setup.exe --migrate-legacy "/D=$old"
```

The new files go to a sibling named `<old folder> (side-by-side)`. The setup does not copy or delete legacy files or replace its uninstall entry. Run `Grok Bot.exe` directly from the new folder. Both versions use `%APPDATA%\Grok Bot Local`; run only one at a time. To go back, quit the new client and open the old executable. To remove **only the new copy**, run the uninstaller in the **side-by-side** folder, not the old uninstaller or its Settings → Apps entry. Repeat the same setup command for later upgrades; add `/S` before `/D=` for silent use.

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
