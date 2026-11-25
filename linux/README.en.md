# ProkBot Plus Linux Client Patch

[简体中文](README.md)

Patches the official Grok Bot 1.3.0 Linux desktop client (`x64` and `arm64`) to connect to your own Host, producing a portable folder, a `.tar.gz` archive and a per-user install script (no root required, works across distributions). Requires Node.js 22.12+ and `tar` with xz support (`xz-utils`).

See the [deployment guide](../docs/AI-INSTALL.en.md#client-packages) for setup and the [technical documentation](../docs/ARCHITECTURE.en.md#linux-client) for internals.

## Build the client

From the repository root (or the extracted Linux release package):

```sh
node linux/patchers/desktop/patch.mjs
```

- Without `--source`, the tool downloads and verifies the pinned official 1.3.0 `.deb` archive; without `--arch`, it picks `x64` or `arm64` from the `.deb` size or the host CPU (`--arch x64` / `--arch arm64` overrides).
- If you already have the official `.deb` or an extracted app directory, pass `--source /path/to/grok-bot_1.3.0_amd64.deb`.
- Default output in `linux/output/`:
  - `grokbot-local/`: portable directory (run `./grokbot-local` directly);
  - `GrokBotLocal-1.3.0-<arch>-linux.tar.gz`: portable archive for copying to a Linux desktop (skip with `--no-archive`);
  - `GrokBotLocal-1.3.0-<arch>.patch.json`: build verification manifest.
- `--verify-only` verifies the pinned original and replays the recipes in a temporary directory without writing output; it also runs on Windows. See the [version table](../README.en.md#client-versions) for accepted inputs and the latest official releases.

## Install and run

Run `./grokbot-local` directly from the portable folder, or install the desktop launcher, icon, `grokbot-local://` URL handler and CLI symlink for the current user (no root needed):

```sh
sh grokbot-local/install.sh
```

Installs to `~/.local/share/grokbot-local` and links `~/.local/bin/grokbot-local` by default (`--dir` and `--bin-dir` override). Uninstall with `sh ~/.local/share/grokbot-local/uninstall.sh` (keeps settings and credentials in `~/.config/Grok Bot Local`). The install script replaces only an empty directory or an earlier Grok Bot Local install, and the uninstall script removes only a Grok Bot Local install; both refuse when `--dir` points anywhere else.

On first launch, enter your Host address and a 6-character pairing code. Turn on the Tailcat switch only when pasting a connection link from the Host admin page's Remote access view; leave it off for LAN or HTTPS addresses.

## Runtime notes

- **Libraries**: same desktop libraries as the official Electron client (`libgtk-3-0`, `libnss3`, `libnotify4`, `libsecret-1-0`, `libasound2`, etc.; `libappindicator3-1` / GNOME AppIndicator extension recommended for the tray icon).
- **Ubuntu 24.04+ AppArmor sandbox**: on kernels with `kernel.apparmor_restrict_unprivileged_userns=1`, user-level portable installs cannot use unprivileged user namespaces by default. To keep the Chromium sandbox enabled, run the bundled helper once:
  ```sh
  sudo ~/.local/share/grokbot-local/setup-apparmor.sh
  ```
  As a temporary fallback without sandboxing, launch with `GROKBOT_NO_SANDBOX=1 grokbot-local`.
- **Credential storage**: uses the desktop keyring (GNOME Keyring / KWallet) when running; on minimal window managers without a Secret Service daemon, matches the official Linux client by opting into Electron's `basic_text` backend (still stored `0600` inside a `0700` directory).
- **Capabilities and limits**: supports built-in Tailcat networking, local command and file execution (with approvals), local Codex CLI delegation and desktop notifications; like Windows, local mouse/keyboard GUI control is unavailable. Uses its own profile directory and `grokbot-local://` scheme so it can coexist with the official client. Local commands and Codex need a 1.10.0 or later Host.
- **Tested so far**: the previous 1.2.3 was tested on Ubuntu 22.04 x64 under WSL2 (WSLg): building, launch, pairing, chat, local commands with approval, restoring after a restart, and the install and uninstall scripts. 1.3.0 has only passed the offline recipe replay and is not tested yet. Native GNOME / KDE desktops, Wayland, Tailcat, the tray, ARM64 and the AppArmor script on Ubuntu 24.04 are untested too; please open an issue if something breaks. If you still need 1.2.3, build it with the **v1.15.0** Linux release package.

## Maintenance and tests

- `patchers/desktop/recipes/` and `patchers/desktop/arm64/recipes/` are generated from the same anchored rules via `windows/tools/desktop-recipes/build.mjs` (`--target linux-x64` / `--target linux-arm64`); run `node --test "linux/tests/*.test.mjs"` to verify.
- Linux Tailcat binaries are shared with the server at `host/bin/grokbot-tailcat` (x64) and `host/bin/linux-arm64/grokbot-tailcat` (ARM64).

## License and support

Noncommercial use only; see [LICENSE](LICENSE). Most code in this project was written with AI assistance.
