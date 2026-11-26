<div align="center">

# ProkBot Plus

**Run Grok Bot on your own server, with the models you choose.**

<p>
<!-- client-badges:start -->
  <a href="#client-versions"><img alt="Windows official 1.3.0 x64" src="https://img.shields.io/badge/Windows%20official-1.3.0%20x64-0078D4?logo=windows&logoColor=white"></a>
  <a href="#client-versions"><img alt="Windows patch accepts 1.3.0 x64 (recommended), 1.2.3, 1.1.0, 0.71.2" src="https://img.shields.io/badge/Windows%20patch%20accepts-1.3.0%20x64%20(recommended)%2C%201.2.3%2C%201.1.0%2C%200.71.2-237E55?logo=windows&logoColor=white"></a>
  <a href="#client-versions"><img alt="Linux official 1.3.0 x64 / ARM64" src="https://img.shields.io/badge/Linux%20official-1.3.0%20x64%20%2F%20ARM64-237E55?logo=linux&logoColor=white"></a>
  <a href="#client-versions"><img alt="macOS official 1.3.0 ARM64 / Intel" src="https://img.shields.io/badge/macOS%20official-1.3.0%20ARM64%20%2F%20Intel-111111?logo=apple&logoColor=white"></a>
  <a href="#client-versions"><img alt="iOS official 1.28.0" src="https://img.shields.io/badge/iOS%20official-1.28.0-111111?logo=apple&logoColor=white"></a>
  <a href="#client-versions"><img alt="Android shell 1.1.0" src="https://img.shields.io/badge/Unofficial%20Android-1.1.0-237E55?logo=android&logoColor=white"></a>
  <a href="#client-versions"><img alt="Web client 1.1.0" src="https://img.shields.io/badge/Web%20client-1.1.0-237E55?logo=googlechrome&logoColor=white"></a>
<!-- client-badges:end -->
  <img alt="Noncommercial License" src="https://img.shields.io/badge/License-Noncommercial-6B7280">
  <a href="https://linux.do"><img alt="LINUX DO" src="https://img.shields.io/badge/Community-LINUX%20DO-F5A623"></a>
</p>

[简体中文](README.md) · **English**

</div>

<p align="center">
  <img src="docs/images/hero-en.jpg" alt="Three clients: on the left the Windows client, where the Bot searched the web and drew a picture; in the middle the web client in a browser; on the right a chat in the Android app">
</p>

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/images/card-search.jpg" alt="Windows client: the Bot looks up when to see the red autumn leaves at Fragrant Hills, lists its sources and paints a watercolor"><br><b>Web search and images</b><br><sub>Sources are listed, and pictures appear right in the chat.</sub></td>
    <td width="50%" valign="top"><img src="docs/images/card-approve.jpg" alt="Before the Bot runs a command on the Windows PC, a card offers Always allow, Allow once and Never"><br><b>Commands on your own PC</b><br><sub>In the Windows client, the Bot asks first.</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/images/card-phone-en.jpg" alt="The Bot list on a phone and a chat with Trip Planner, where the Bot lays out a weekend in Edinburgh as a table"><br><b>On your phone</b><br><sub>Laid out like the official phone app; the Android app and the web client share this interface.</sub></td>
    <td valign="top"><img src="docs/images/card-tablet-en.jpg" alt="The web client on an iPad in landscape: the Bot list on the left and a Python script from Code Helper on the right"><br><b>Tablets and any browser</b><br><sub>The web client adapts to the screen; sign in with a pairing code.</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/images/card-models-en.jpg" alt="The chat model page on the Host admin site: two model services, anthropic and openai-responses, and two model profiles"><br><b>Your own models</b><br><sub>Anthropic, OpenAI Responses or OpenAI Chat APIs, with a model and fallbacks per Bot.</sub></td>
    <td valign="top"><img src="docs/images/card-pair-en.jpg" alt="First connection in the Android app: enter the Host address and the 6-character pairing code"><br><b>Pair with a code</b><br><sub>Enter the Host address and a 6-character code from the admin page.</sub></td>
  </tr>
</table>
<p align="center"><sub>All screenshots use demo data. The Windows screenshots show the Chinese interface; the clients also support English.</sub></p>

## What it is

Grok Bot is xAI's AI assistant app. Besides chatting, its Bots have their own Linux computer where they run commands, use a browser and work with files, and they have memory and scheduled tasks. The official app only connects to the official cloud.

[ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) moves the server side onto your own server with Docker and patches the official clients to connect to it. **ProkBot Plus** builds on it with:

- **More clients**: Windows and Linux (x64 / ARM64) desktop clients, our own Android app and a web client that runs in any browser;
- **More model APIs**: Anthropic Messages, OpenAI Responses and OpenAI Chat, with a main model, reasoning effort and fallback models per Bot;
- **Fixes**: web search, image generation, message order, automatic review and more;
- **Deployment tools**: one command to check, start, update and back up, plus a deployment guide an AI can follow.

The interface, tool calls, memory, scheduled tasks and approvals are the official ones. Chats, files and memory stay on your server; telemetry and automatic updates are off.

> Unofficial and not affiliated with xAI. Noncommercial use only; see [License and notices](#license-and-notices).

<a id="server-requirements"></a><a id="what-you-need"></a>
## Server requirements

Models run through their APIs, so **the server needs no GPU**. It runs two containers: the Host and the Bot's Linux computer.

| | Minimum | Recommended |
| --- | --- | --- |
| CPU / memory | 2 cores / 4 GB | 4 cores / 8 GB |
| Free disk space | 30 GB | 50 GB |
| System | 64-bit Linux, Docker with Compose v2, Python 3.10+ | Ubuntu 24.04 (its own Docker packages are enough); with Docker 26+ and Compose 2.26+ the Bot can read its memory on its own computer |

- Fresh deployments on 2 cores / 4 GB and 4 cores / 8 GB both worked in testing; 2 cores / 2 GB did not. Sized for one person or a household; heavy simultaneous use by several people is untested.
- Typical use: the Host takes about 0.7 GB of memory and the Bot's computer about 0.8 GB (peak 1.7 GB); the images take about 13 GB.
- x86_64 is simplest. An ARM64 machine (such as an Oracle A1) can run just the Host, with the Bot's computer on a second x86_64 machine. Emulating the Bot's computer on ARM also works but is much slower and experimental. ARM setups have not been retested with the current version.

You also need a model API with tool calling (and image input, if the Bot should operate a computer), a computer with Node.js 22.12+ to build the clients, and the official installers, downloaded yourself. Web search, image generation, voice, push notifications and an HTTPS domain are optional.

## Clients

<a id="client-versions"></a>
<!-- client-versions:start -->
**Which official version should I download?** The one in the right column; the patches accept only those versions. Where two versions are listed, use the recommended newer one first and switch to the older one only if it does not work. The left column is the latest official release (checked 2026-11-25); when it is newer, wait until this project supports it.

| Platform | Latest official | Version this project needs |
| --- | --- | --- |
| Windows x64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand) | **1.3.0** (recommended); 1.2.3, 1.1.0, 0.71.2 if it does not work |
| Linux x64 / ARM64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand) | 1.3.0 (.deb archive; tested on Ubuntu 24.04 x64 in a container with a virtual display; native desktops and ARM64 untested) |
| macOS ARM64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand) | 1.3.0 (tested working on an Apple Silicon Mac with 1.3.0) |
| macOS Intel (x64) | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/darwin-x64/sand) | 1.3.0 (tested working on an Intel Mac with 1.3.0) |
| iOS | [1.28.0](https://apps.apple.com/us/app/grok-bot/id6794501026) (not supported by this patch) | 1.27.0 (build 29519; pairing, messaging and App Intents verified on an iPad) |
| Android 9+ (unofficial) | Does not use the official Android app | App **1.1.0** (build 10100), interface taken from the Windows **1.1.0** installer (recommended; 0.71.2 if it does not work) |
| Web client (browser, unofficial) | Nothing to install | Interface taken from the Windows **1.1.0** installer (recommended; 0.71.2 if it does not work), built once and uploaded to your Host |
| Linux server | n/a | Host `d0a4baa`; Bot computer `9d2ac1b` (x86_64) |

ProkBot Plus has its own version numbers; see the [latest release](https://github.com/ferretgeek/prokbot-plus/releases/latest). The upstream ProkBot baseline is `3e9fe8c`.
<!-- client-versions:end -->

| Client | Requirements | Notes |
| --- | --- | --- |
| Windows | Windows 10 / 11 x64 | New in Plus. Portable version or installer, no administrator rights needed. The Bot can run commands on your PC and asks you first. Tested on Windows 11 (1.2.3 and earlier; 1.3.0 not yet tested). |
| Linux | Linux x64 / ARM64 desktop | New in Plus. Portable folder, `.tar.gz` and per-user install script, no root needed. Supports Tailcat, local commands and Codex; no local mouse/keyboard GUI control. 1.2.3 was tested on Ubuntu 22.04 x64 under WSL2; 1.3.0, native Linux desktops and ARM64 are untested. |
| Android | Android 9+, system WebView 89+ | Our own app, not the official Android app. Tested on Android 15 / 16 emulators, not on a real phone. |
| Web client | Current Chrome, Edge, Firefox or Safari | Served by your Host and adapts to phones, tablets and computers; sign in with a pairing code. It works with the Bot's computer only, never your own device. |
| Mac | Apple Silicon or Intel | Supports official 1.3.0 on both Apple Silicon and Intel Macs (1.3.0 has been live-tested on both Apple Silicon and Intel Macs; if you still need 1.2.3, use the ProkBot Plus v1.15.0 Mac package). |
| iPhone / iPad | Your own decrypted IPA and signing certificate | Supports official 1.27.0 (build 29519, recommended), with 1.26.0 and 1.16.0 fallbacks. The contributor tested upgrading, pairing, chat and attachments with 1.27.0 on an iPad; iPhone has not been fully tested. |

<a id="android-client"></a><a id="web-client"></a>
**The Android app** does not modify the official Android app (it is tamper-protected). It puts the official desktop interface into a shell written by this project. You can watch the Bot's computer live and take control, and notifications work without Google push. You sign the APK with your own key.

**The web client** is built on a computer and uploaded to your Host. Then open the web client address (its own Host port, 18081 by default, apart from the admin page) in a browser on any device and enter a pairing code; you can also add it to the home screen. Use HTTPS when you access it from outside, with an entry of its own for the web client. See the [web client guide](web/README.en.md).

## Install

The easiest way: send this to an AI that can run commands (Claude Code, Codex, Cursor and the like):

```text
Please deploy ProkBot Plus for me: https://github.com/ferretgeek/prokbot-plus
First read docs/AI-INSTALL.en.md in the repository in full, then follow its steps exactly.
Ask about my machines, any existing instance, model and access method. Run doctor first. Never remove volumes, disclose keys or treat container startup as acceptance. Verify a two-turn client chat and a desktop action at the end.
```

To do it yourself, follow the [deployment guide](docs/AI-INSTALL.en.md): on the server run `doctor` → `init` → `up` → `status`, then set up the model and create a pairing code on the admin page, and connect with a client.

The [latest release](https://github.com/ferretgeek/prokbot-plus/releases/latest) has seven tool packages: Host, Windows, Mac, Linux, iOS, Android and web client. Download the one you need. The packages contain no official programs; you build the clients on your own computer from the official installers.

## Compared with official Grok Bot

**Benefits**: you choose the models and providers; your data stays with you, and LAN-only use works; and there are a few extras, such as editing the system prompt, usage statistics, webhooks, your own apps, and backup and restore.

**Costs**:

- you maintain a Linux server yourself;
- client versions are pinned: a new official release has to be adapted first, and there are no automatic updates;
- results depend on the model you choose;
- some official features are off (virtual cards, external message drafts, passkey forwarding), and voice, push and image generation need your own providers;
- Bots shared on the official website ("Add to Grok Bot" on x.ai/bot/… pages) cannot be added, because those templates live in the official cloud; Bots are shared between Hosts as ZIP files;
- the clients are not code-signed: Windows shows a SmartScreen prompt, you sign the iPhone app yourself, and Android needs installs from unknown sources allowed;
- on Windows and Linux the Bot can run commands but cannot yet control the mouse and keyboard;
- patching the official clients may break the official terms of use; you do so at your own risk.

## Documentation

| Document | Contents |
| --- | --- |
| [Deployment guide](docs/AI-INSTALL.en.md) | Deployment, models, building clients, operations, backup and restore, troubleshooting |
| [Architecture](docs/ARCHITECTURE.en.md) | How it works, what Plus changes, layout, tests, maintenance and releases, known limits |
| [Linux client guide](linux/README.en.md) | Building, portable launch, rootless install and AppArmor sandboxing for Linux (x64 / ARM64) |
| [Web client guide](web/README.en.md) | Building, uploading and signing in to the web client; browser support |
| [Changelog](CHANGELOG.md) | What changed in each release |

Each platform has its own README under `host/`, `windows/`, `mac/`, `linux/`, `android/`, `web/` and `ios/`, shipped with its tool package.

## Community

- Discussion and release posts are on [LINUX DO](https://linux.do);
- report bugs as [issues](https://github.com/ferretgeek/prokbot-plus/issues) and security problems privately as described in [SECURITY.md](SECURITY.md);
- see [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

<a id="license-and-notices"></a>
## License and notices

- Derived from [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) (commit `3e9fe8c`) and under its [ProkBot Noncommercial License 1.0](LICENSE): personal use, study, modification and noncommercial distribution are allowed; no commercial use of any kind, including paid deployment, paid services and internal business use. Origins and the list of changes are in [NOTICE](NOTICE).
- The repository and releases contain no official Grok Bot programs, and no patched clients, APKs, IPAs or web client bundles; `android/dist/` holds only this project's own shell.
- Grok, Grok Bot and related marks belong to their owners. This project is not affiliated with them.
- Most of the code was written with AI assistance. Maintained by 6.2Astra and Opus5.5 together, provided as is, without any warranty.
