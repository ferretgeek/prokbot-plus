# ProkBot Plus web client

[简体中文](README.md)

Use the Bots on your own Host from a browser on a computer, phone or tablet, without installing a client. Computers and landscape tablets get the official desktop layout; phones get the official phone layout.

The interface is the same as the Android client's, taken from the official Windows installer you download yourself (1.1.0 recommended, 0.71.2 if it does not work). You build an "interface bundle" on a computer and upload it to your own Host, which serves it only to browsers signed in with a pairing code. The project does not distribute the bundle.

<p align="center"><img src="../docs/images/web-en.png" alt="Web client in a desktop browser and on an iPhone" width="860"></p>

## Usage

You need:

- a deployed Host whose admin page you can open (ProkBot Plus 1.5.0 or later; 1.15.0 or later strongly recommended, since earlier releases serve the web client on the admin page's address, where code in the bundle can borrow the administrator's session);
- a computer (Windows, macOS or Linux) with Node.js 22.12+ and the complete web client package (with `web/`, `android/`, `windows/` and `mac/`) or the complete repository.

### 1. Build the bundle

From the repository root:

```sh
node web/patchers/patch.mjs
```

The tool downloads and verifies the official `Grok_Bot_1.1.0_Setup.exe` (the same file the Windows and Android clients use) and writes `web/output/GrokBotLocal-web-1.1.0.zip`.

If the 1.1.0 interface does not work for you, add `--version 0.71.2` to use the 0.71.2 interface instead, or pass a downloaded 0.71.2 installer with `--source`. The tool recognises the version by its hash.

| Option | Effect |
| --- | --- |
| `--source <file or directory>` | Use a downloaded official installer, `app-64.7z` or an installed original directory; 1.1.0 or 0.71.2 is recognised by hash |
| `--version <1.1.0\|0.71.2>` | Choose the interface version. Default 1.1.0 (recommended); fall back to 0.71.2 only when needed |
| `--output <directory>` | Output directory, default `web/output/` |
| `--force` | Overwrite existing output |
| `--upload <Host address>` | Install the bundle on that Host after building and enable the web client; see the next step |
| `--password-file <file>` | File with the administrator password for `--upload` |
| `--verify-only` | Check the original, run the Windows recipe, and check the web entry and interface patches in a temporary directory, without writing files |

### 2. Upload it to the Host

Either:

- **Admin page**: open **Web client** on the Host admin page, click **Choose a file and upload** and pick the ZIP you just built. The web client is enabled when the upload finishes.
- **Command line**: add `--upload` when building, for example `node web/patchers/patch.mjs --upload https://bot.example.org`. The administrator password is read from the `GROKBOT_ADMIN_PASSWORD` environment variable, the file given with `--password-file`, or the terminal; it never goes on the command line.

The Host checks the size and SHA-256 of every file against the bundle's own manifest. If anything does not match, nothing is installed and the previous bundle stays in place.

### 3. Sign in

1. On the device you want to use, open the web client address in a browser. The web client has its own Host port and address, apart from the admin page: by default the Host's host name with port 18081, for example `http://192.168.1.10:18081/web/`; behind an HTTPS reverse proxy, the address set up for it, for example `https://web.bot.example.org/web/` (see the [Host guide](../host/README.en.md#web-client)). The **Web client** page of the admin page shows this address with a copy button; old `<admin address>/web/` links redirect there.
2. Create a 6-character pairing code under **Devices & notifications** on the admin page and enter it. Each browser pairs separately; a code is valid for 5 minutes and works once.
3. In the browser where the admin page is open, click **Open in this browser** at the top right of the **Web client** page instead. No pairing code is needed: the admin page issues a one-time ticket, valid for two minutes, and the new tab uses it to sign in on the web client's address.

The browser then remembers the device (the cookie lasts 400 days), so closing and reopening it does not sign you out. Signed-in browsers appear under **Devices & notifications** with the platform **Web client**, and each can be revoked on its own.

### Add to home screen

The web client can open from the home screen like an app, full screen and without an address bar:

- **iPhone / iPad**: open the web client in Safari, tap **Share**, then **Add to Home Screen**;
- **Android**: open the web client in Chrome, open the menu, then **Add to Home screen** or **Install app**;
- **Computers**: Chrome and Edge show an **Install** button at the right of the address bar.

## Features

- The full official desktop interface: conversations, Bot management, skills, marketplace, library, routines and settings, in Chinese and English, with dark mode following the system.
- **Responsive layout**:
  - computers and landscape tablets (792 pixels wide and up) get the official desktop layout, with the sidebar beside the conversation;
  - portrait tablets and narrower windows fold the sidebar away; it slides in from the left when needed;
  - phones (under 600 pixels wide) get the official phone layout, as in the [Android client](../android/README.en.md#features): the home screen is the Bot list, a Bot opens a full-screen conversation, and menus and dialogs rise from the bottom;
  - the browser's back button and back gesture go back one step at a time: first closing an open panel, then returning from a conversation to the Bot list, and only then leaving the page;
  - when a phone keyboard opens, the message field moves up with it instead of being covered; the iPhone notch and home indicator areas are kept clear.
- **The Bot's computer**: conversation details show the live screen of the Bot's computer. In the large view you can operate it directly with mouse, keyboard or touch.
- Attachments: upload files from the device (large files in chunks), download files the Bot sends, view images full screen.
- Notifications: while the page is open, new messages from Bots you are not looking at show as browser notifications; clicking one opens that Bot. The Bot on screen does not notify again.
- The link `<web client address>?agent=<Bot ID>` (for example `https://web.bot.example.org/web/?agent=<Bot ID>`) opens a Bot's conversation directly.

## Notes and limitations

- **Only the Bot's computer on the Host.** The web client cannot let a Bot operate the device you are using or run commands on it; use the Windows, Mac or Linux client for that. "Teach the Bot a task" (recording a demonstration) is not available.
- **No Tailcat.** For access from outside, use a VPN, a tunnel or an HTTPS domain; behind an HTTPS reverse proxy the web client needs an entry of its own. The web client connects only to the Host that serves the page; to use another Host, open that Host's web client.
- **Plain http works, but a few features need https.** Browsers allow the microphone, dictation and notifications only on https (or local `localhost`), so these are unavailable on an http address, and the Bot's computer screen shows a one-line "not encrypted" note (operation is unaffected). Always set up https for use over the internet.
- **No notifications once the page is closed.** For background notifications, use the Android or iOS client, or set up Bark push on the admin page.
- Browsers: recent versions of Chrome, Edge, Firefox and Safari. On iPhone and iPad every browser uses Safari's engine and behaves like Safari.
- Settings and interface state are stored in the browser. In another browser, or after clearing site data, settings return to their defaults (conversations and Bots live on the Host and are unaffected). Clearing site data also clears the sign-in, so pair again.

### Testing

Before every release, Playwright runs the full flow at 8 emulated device sizes (Chromium and Firefox on Windows, WebKit on Mac, Android phone and tablet, iPhone 15, iPhone SE, iPad Pro in landscape) with both the 1.1.0 and 0.71.2 interfaces. Uploading, LAN http sign-in, real model chats and the live view of the Bot's computer were also verified on a real server. It has not been tested in browsers on real devices; please [open an issue](https://github.com/ferretgeek/prokbot-plus/issues) if something goes wrong on yours.

## Security

- The bundle is stored only on your Host. Visitors who have not signed in see only the sign-in page and cannot fetch any file of the bundle.
- The web client and the admin page use different ports and addresses (since 1.15.0). The bundle runs the official interface's code; even in a browser signed in to the admin page, that code cannot call the admin API. Do not put the web client under a path of the admin address with a reverse proxy; the Host also refuses a configuration where both addresses are the same.
- The sign-in credential is an HttpOnly, SameSite=Strict cookie that page scripts cannot read; on https it is also Secure. Only requests that carry the cookie and come from the web client's address can call the Host's web client API; the admin page's port ignores the cookie.
- Each browser is a separate device that you can revoke under **Devices & notifications**. Web client devices have no desktop execution permission.
- Sign-in is rate limited, and a pairing code expires after 5 minutes and works once.

## Updating and removing

- **Update the interface**: build and upload a new bundle. It replaces the old one as a whole; signed-in browsers keep their pairing and only need a reload. After upgrading ProkBot Plus, build the bundle again with the tools from the same release.
- **After upgrading the Host from 1.14.0 or earlier**: the web client moves to its own address. When the host name stays the same (only the port changes), signed-in browsers keep working at the new address, since cookies do not depend on the port; after moving to a subdomain behind a reverse proxy, pair again and revoke the old device entries under **Devices & notifications**.
- **Pause**: turn off **Enable the web client** on the **Web client** page. The bundle stays, and signed-in browsers cannot open the web client until you turn it back on.
- **Delete**: click **Delete the bundle**. The web client is disabled. Signed-in browsers stay listed under **Devices & notifications**, where you can revoke them.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `/web/` says the web client is not enabled yet | Upload a bundle on the **Web client** page of the admin page and turn on **Enable the web client** |
| Upload says the bundle format is unsupported | The bundle was built with tools from a different release than the Host. Build it again with the package matching the Host |
| Building reports a hash mismatch | Only unmodified official Windows x64 1.1.0 or 0.71.2 installers are supported. Leave out `--source` to let the tool download one |
| The pairing code is rejected | Codes expire after 5 minutes and work once. Create a new one under **Devices & notifications** |
| The page suddenly returns to sign-in | This browser was revoked under **Devices & notifications**, or its site data was cleared. Pair again |
| Microphone, dictation or notifications do not work | The address is http. Open the web client over https |
| The redirect from `/web/` on the admin address leads nowhere | The web client has its own port (18081 by default). Check the firewall; behind an HTTPS reverse proxy give the web client an entry of its own and set `GROKBOT_WEB_PUBLIC_URL` in `.env`; see the [Host guide](../host/README.en.md#web-client) |
| The web client's domain changed | The sign-in only applies to the old domain. Pair again on the new one |

## Maintenance

- `client/` holds the browser-only code (`native.js`, `web-shell.js`, `boot-data.js`, `web.css`); the rest of the bridge is shared with the Android client (`android/client/`). `patchers/` builds and uploads bundles; the Host side is `host/server/web-client.mjs` and `web-routes.mjs`.
- How it works is in the [technical documentation](../docs/ARCHITECTURE.en.md#web-client); test commands and the environment variables they need are under [tests and maintenance](../docs/ARCHITECTURE.en.md#testing).

## License and support

Non-commercial use only; see [LICENSE](../LICENSE). Most of this project's code was written with AI assistance. A generated bundle contains the official program's interface: install it only on your own Host and do not share it publicly.
