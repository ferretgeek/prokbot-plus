# Deploy ProkBot Plus

[简体中文](AI-INSTALL.md) · [Architecture and extensions](ARCHITECTURE.en.md) · [Restore, offline inputs and execution nodes](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/host/README.en.md)

**One route for a person or their AI: choose a machine, check it, start the server, connect a model, then send a message.** A healthy container is not proof of a working conversation. Run server commands from the repository root or the equivalent directory in the Host release package.

**Already have a Host and updating only a client?** Skip all server commands below. Use the client ZIP; keep the existing `.env`, project name and volumes. Do not run `init`, `up` or `update` for a client-only change.

## Choose a deployment

| Machines available | Deployment | What to expect |
| --- | --- | --- |
| One x86_64 Linux server | Default: native Host and execution desktop | Existing end-to-end conversation coverage |
| One ARM64 Linux server, such as Oracle Ampere A1 | Default: native Host and amd64 desktop under QEMU | **Experimental**. The desktop is not native ARM. Run `doctor` first; performance depends on the workload |
| ARM64 Linux plus an amd64 Linux machine | Put `--host-only` before `doctor` and `init` on the Host; put the desktop on the second machine | Recommended for ARM. Chat and desktop control were verified on a native A1 Host without downloading or emulating the desktop on ARM. See [execution node setup](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/host/README.en.md#separate-execution-computer) |

Ask once: is this an installation or an upgrade? Which server and SSH access? How will clients reach it (local, private network, HTTPS domain)? Which model API, model ID and clients? Let the owner enter passwords and API keys in the console, not in chat, issues or logs. Do not change existing services, DNS, proxies or firewalls by default.

Requirements: Python 3.10+, access to a Linux Docker daemon, Docker Compose v2 with `up --wait`, and Git or an extracted Host package. Earlier planning allowed 8 GB RAM and 30 GB free disk for a local desktop, not a measured minimum or recommendation; the first build downloads about 8 GB. Leave extra headroom for emulation. A local ARM desktop also needs a registered x86-64 QEMU/binfmt interpreter; ask the owner before changing system configuration.

On fresh Ubuntu 24.04 install `docker.io docker-compose-v2 docker-buildx python3 git` from the distribution, enable Docker, grant the deployment user access and log in again. For a local ARM desktop only, install `qemu-user-static binfmt-support`, enable the interpreter with `sudo update-binfmts --enable qemu-x86_64`, then run `doctor`. Only fill gaps on existing installations; membership in the `docker` group grants administrative control of the host.

## Check and start

For SSH use Bash (Git Bash on Windows). Each SSH block starts a fresh session. Use `set -eu`, change to the same source directory and redirect commands that might read the script from stdin with `< /dev/null`. For example, on a new installation:

```sh
ssh USER@SERVER 'bash -s' <<'EOF'
set -eu
mkdir -p "$HOME/grokbot"
git clone https://github.com/ferretgeek/prokbot-plus.git "$HOME/grokbot/src" < /dev/null
cd "$HOME/grokbot/src"
python3 host/deploy.py doctor < /dev/null
EOF
```

Do not clone over existing code. Without GitHub access on the server, run `git archive --format=tar.gz -o prokbot-host-src.tar.gz HEAD host` on the client, transfer only that archive, and extract it into a fresh source directory. Never upload your working tree or private files. Builds still require access to the pinned upstream inputs and dependencies.

A successful `doctor` prints JSON with `ok: true`, the Host platform, desktop mode, resources and volumes. `hostDataVolumes` includes Host volumes under other project names. If you find an existing instance, confirm its `.env`, project name and topology, only **update** it when a server upgrade is intended. Do not change project names to reinstall. A failed probe stops before the large desktop download. For a new instance:

```sh
cd "$HOME/grokbot/src"
python3 host/deploy.py init < /dev/null
python3 host/deploy.py up < /dev/null
python3 host/deploy.py status < /dev/null
```

`init` creates `~/grokbot/.env` once. The default address `http://127.0.0.1:18080` is local to the server. **A remote phone cannot pair with the server's loopback address.** Choose your access method before `init`:

- Existing HTTPS reverse proxy: add `--public-url https://bot.example.org` to `init`, substituting your domain. Proxy to the loopback port and support WebSockets. There is no need to expose port 18080 publicly.
- Private network or LAN: add `--listen PRIVATE_SERVER_IP --public-url http://PRIVATE_SERVER_IP:18080`. Bind the intended interface and restrict access to trusted devices. Do not send credentials or pairing codes over public HTTP.
- Separate desktop: run `python3 host/deploy.py --host-only init`; subsequent operations remember this mode. Use `--home` and `--project` for a custom instance; global options precede the command. Old `.env` files have no mode marker: for a split deployment always pass `--host-only` and the original project name.

<a id="91-windows-1011-x64"></a><a id="92-mac-apple-silicon"></a><a id="94-android-phone"></a>
<a id="client-packages"></a>
## Connect and verify

A client-only update does not require a server redeploy. Check the [accepted original and shell versions](../README.en.md#client-versions) and reuse the Android signing key for an in-place update. Follow the guide inside your chosen release archive; do not substitute the default branch for a tagged release.

1. Run `python3 host/deploy.py setup-key` in a private terminal; do not forward the output to chat. Use it in the console to set a 12–128 character admin password. This first-use code is not a device pairing code.
2. For a split deployment, connect the execution node in the console first. In Models, enter the endpoint, model ID and API key. OpenAI Chat and Responses normally use a `/v1` base; Anthropic Messages accepts the root. Match the provider's actual API. Test before saving and wait for the Host to connect. Search, image generation, voice and push are optional.
3. Generate a six-character, single-use pairing code in the console (valid for five minutes). Enter the same address as `GROKBOT_PUBLIC_URL` and the code in the client. Pair each device separately. Android needs a private network address or HTTPS; it does not support Tailcat links.

| Client | Build and install |
| --- | --- |
| Windows 10/11 x64 | [Windows instructions](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/windows/README.en.md) |
| Mac (Apple Silicon) | [Mac instructions](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/mac/README.en.md) |
| iPhone | [iOS patching and signing](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/ios/README.en.md) |
| Android 9+ | [Independently developed, unofficial Android client](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/android/README.en.md) |

For scripted administration, run `python3 host/deploy.py admin help`. Pass `GROKBOT_ADMIN_PASSWORD` and `MODEL_API_KEY` through the environment, not arguments; never print the environment. `admin session` checks initialization, `admin status` checks the core, and `admin model-set --test-only` tests the specified API, endpoint and model without saving.

**Acceptance**: ask a question from a client, then ask a follow-up about that answer. Have the Bot run `uname -m` on its execution desktop, return the result, and open its desktop view. These check chat, retained context and execution separately. On single-machine ARM, the desktop should report `x86_64` while Host `doctor` reports `linux/arm64`. Hand over the address, revision, mode, backup location, and passed or outstanding checks, never the credentials.

<a id="appendix-a-routine-operations"></a>
## Operations

Run these in the original source directory:

| Task | Command |
| --- | --- |
| Status / recent logs | `python3 host/deploy.py status` / `python3 host/deploy.py logs` |
| Backup | `python3 host/deploy.py backup < /dev/null`; the reported directory belongs to the owner |
| Upgrade | For Git use `git pull --ff-only`; unpack a release into a fresh source directory. Only after obtaining the new code run `python3 host/deploy.py update < /dev/null` |
| Restore | [Host backup and restore](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/host/README.en.md#data-and-backups): restore into a new project, never over the original volumes |

Upgrade briefly pauses containers for backup, then builds and starts the new version. Backup or build failure does not switch running containers. A startup failure is not an automatic rollback. Never delete volumes or use `down -v`. Repeat the conversation and desktop checks. Rebuild clients only for client changes; Android updates require the original signing key.

<a id="appendix-b-troubleshooting"></a>
## Troubleshooting

| Symptom | Next step |
| --- | --- |
| `doctor` cannot connect to Docker or find Compose | Check the daemon, user permissions and Compose v2. Do not reinstall a working Docker setup |
| ARM reports `exec format error` or probe timeout | Distinguish pull failures from architecture errors. Check the x86-64 binfmt interpreter and `F` flag, rerun `doctor`, or use a separate amd64 node |
| Existing volumes, project or `.env` conflict | Find the original project and topology; use `update`. Do not delete data to silence the error |
| Image digest mismatch | Check the pinned input version and download integrity; do not bypass verification |
| Console works but chat does not | Check `logs` and test the model. For split mode, check the execution node. `healthy` is not a model test |
| Chat works but desktop fails or is slow | Check box with `status` or check the second machine. Prefer a separate node when ARM emulation is too slow |
| Address mismatch or pairing fails | Compare `.env` and the client address, check the reverse proxy and WebSockets, then issue a fresh code. Wait a minute on HTTP 429 |

Use the platform guides for client-specific problems. Include architecture, code revision, steps and redacted logs in reports; exclude passwords, pairing codes and backups.
