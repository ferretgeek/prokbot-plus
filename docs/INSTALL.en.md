# Installation

[简体中文](INSTALL.md)

This is the short version for people. If you want an AI to do it, or want the checks and troubleshooting for every step, read the [AI install guide](AI-INSTALL.en.md).

## 1. Deploy the server

You need an x86_64 Linux server (8 GB RAM and 30 GB free disk at minimum) with Docker, Docker Compose and Python 3.10+. On Ubuntu the distribution packages work: `sudo apt-get install -y docker.io docker-compose-v2 python3 git`. On Debian and other distributions, use Docker's install script: `curl -fsSL https://get.docker.com | sudo sh`. Then add yourself to the docker group (`sudo usermod -aG docker "$USER"`) and log in again.

```sh
mkdir -p ~/grokbot && cd ~/grokbot
git clone --depth 1 https://github.com/ferretgeek/prokbot-plus.git src
python3 src/host/release/build-docker.py        # first build: 10-40 minutes, downloads about 8 GB
```

Put the access settings in `~/grokbot/.env` (LAN example):

```ini
GROKBOT_LISTEN_ADDRESS=0.0.0.0
GROKBOT_PUBLIC_PORT=18080
GROKBOT_PUBLIC_URL=http://<server LAN IP>:18080
TZ=Asia/Shanghai
```

Start it and read the setup key:

```sh
DC="docker compose --env-file .env -p grokbot -f src/host/release/compose.yaml"
$DC up -d
$DC exec host cat /data/setup-key
```

Open `GROKBOT_PUBLIC_URL` in a browser:

1. Set the admin password with the setup key.
2. Under "Chat model", choose the API format (Anthropic Messages, OpenAI Responses or OpenAI Chat), enter the URL, key and model, then test and save.
3. Optional: set up search and image generation under "Web tools" and "Images & video".
4. Create a 6-character pairing code under "Devices & notifications".

You can do the same without the web page using `host/tools/host-admin.mjs`. See steps 5 and 6 of the AI install guide.

## 2. Build the clients

| Client | Build on | Command (from the repository root) | Output |
| --- | --- | --- | --- |
| Windows 10/11 x64 | A Windows PC with Node.js 22.12+ | `node windows/patchers/desktop/patch.mjs` | Installer and portable build in `windows/output/`, see the [Windows guide](../windows/README.en.md) |
| Mac (Apple Silicon) | A Mac with Node.js 22.12+ | `node mac/patchers/desktop/patch.mjs` | `mac/output.noindex/Grok Bot.app`, see the [Mac guide](../mac/README.en.md) |
| iOS | Any computer with Python 3.10+ | `python3 ios/release/patch-ios.py --input <decrypted.ipa> --output <dir>` | Unsigned IPA that you sign yourself, see the [iOS guide](../ios/README.en.md) |

The tools download and verify the matching official client. For iOS you supply your own decrypted Grok Bot 1.16.0 (23152) IPA.

Open the client and enter the Host address (exactly the same as `GROKBOT_PUBLIC_URL`) and a pairing code. Use a new pairing code for each device.

## 3. Use it away from home

- **Tailcat**: turn it on under "Remote access" in the admin page, and in the client's connection settings. No public IP or domain needed.
- **HTTPS reverse proxy**: set `GROKBOT_LISTEN_ADDRESS=127.0.0.1` and `GROKBOT_PUBLIC_URL=https://<domain>`, and forward the proxy to `127.0.0.1:18080`.
- If you already use Tailscale, the Tailscale address works too.

More: [Separate deployment and backups](../host/docs/DEPLOYMENT.en.md) · [App development](../host/PLUGINS.en.md)
