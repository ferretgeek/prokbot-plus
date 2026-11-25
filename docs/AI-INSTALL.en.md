# Deploy ProkBot Plus

[简体中文](AI-INSTALL.md) · [Architecture and extensions](ARCHITECTURE.en.md) · [Split deployment](#split-host) · [Volume recovery](#volume-recovery)

**One route for a person or their AI: choose a machine, check it, start the server, connect a model, then send a message.** A healthy container is not proof of a working conversation. Run server commands from the repository root or the equivalent directory in the Host release package.

## Choose a deployment

**Already have a Host and updating only a client?** Skip all server commands below. Use the client ZIP, keep `.env`, the project name and volumes, and do not run `init`, `up` or `update` for a client-only change.

| Machines available | Deployment | What to expect |
| --- | --- | --- |
| One x86_64 Linux server | Default: native Host and execution desktop | Minimum 2 cores / 4 GB, recommended 4 cores / 8 GB; 2 cores / 2 GB failed in testing. See [server requirements](../README.en.md#server-requirements) |
| One ARM64 Linux server, such as Oracle Ampere A1 | Default: native Host and amd64 desktop under QEMU | **Experimental**. The desktop is not native ARM. Run `doctor` first; performance depends on the workload |
| ARM64 Linux plus an amd64 Linux machine | Put `--host-only` before `doctor` and `init` on the Host; put the desktop on the second machine | ARM does not download or emulate the desktop. Not retested on ARM with the current version |

<a id="split-host"></a>
**Split deployment:** `--host-only` omits the local desktop; it is not a desktop-free chat mode. Deploy the execution node on a separate amd64 Linux machine, then enter its address and key in the Host console and enable it. Until both a model and the node are configured, the console and setup health check can work while the chat core is not running. An unreachable node is not a successful deployment. The matching Host package's `host/README.en.md` has the offline-input and node setup steps.

If you saved the model first, Overview shows **Execution node required** and the CLI reports the model as **saved, not applied**; do not re-enter it. Use **Set up node** to enable the node, confirm the Host is connected, then test chat.

Ask once: is this an installation or an upgrade? Which server and SSH access? How will clients reach it (local, private network, HTTPS domain)? Which model API, model ID and clients? Let the owner enter passwords and API keys in the console, not in chat, issues or logs. Do not change existing services, DNS, proxies or firewalls by default. Run upgrade, recovery and load tests only on dedicated, authorized non-production instances, never with production services, volumes or credentials.

Requirements: Python 3.10+, Docker with Compose v2, and Git or an extracted Host package. With Docker Engine 26.0+ (API 1.45+) and Compose 2.26.0+, `up`, `update` and `recover` on a same-machine deployment also turn on memory reading: the five memory trees are mounted read-only into the execution desktop, so the Bot can look things up but not change them. With older versions the tools say so and skip this part; the deployment goes ahead. `memoryMounts` in the `doctor` output tells whether it can be turned on. Older Engines ignore the subpath and would mount all of `host-data`, model keys included, into the execution desktop, so never add `host/release/compose.memory.yaml` by hand on them. `--host-only` mounts none of these trees. With the desktop on the same machine, the minimum is 2 cores, 4 GB RAM and 30 GB free disk; 4 cores, 8 GB and 50 GB are recommended. Build caches and backups also consume disk; see [server requirements](../README.en.md#server-requirements) for the basis. A local ARM desktop also needs a registered x86-64 QEMU/binfmt interpreter; ask the owner before changing system configuration.

On fresh Ubuntu 24.04 install `docker.io docker-compose-v2 docker-buildx python3 git` from the distribution, enable Docker, grant the deployment user access and log in again. Tested in November 2026, its updates provide Docker 29.1 and Compose 2.40, which meet the minimums; other distributions' packages may be older, so install Engine, Buildx and the Compose v2 plugin from Docker's official repository there. For a local ARM desktop only, install `qemu-user-static binfmt-support`, enable the interpreter with `sudo update-binfmts --enable qemu-x86_64`, then run `doctor`, which also checks the versions. Only fill gaps on existing installations; membership in the `docker` group grants administrative control of the host.

## Check and start

**Both examples below are for a fresh installation with the Host and desktop on the same machine.** For a separate desktop, use `python3 host/deploy.py --host-only doctor` for the first check and `python3 host/deploy.py --host-only init` for initialization. Keep the original project name when upgrading and read [volume backup and recovery](#volume-recovery) first. For [split deployment](#split-host), the desktop node commands are under “Separate execution computer” in `host/README.en.md` in the matching Host package.

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

A successful `doctor` prints JSON with `ok: true`, the Host platform, desktop mode, `memoryMounts`, resources and volumes; with an existing `.env` it also gives the web client address `webClientUrl` and checks that no other container holds the admin or web client port. `hostDataVolumes` includes Host volumes under other project names. If you find an existing instance, confirm its `.env`, project name and topology, then **update** it. Do not change project names to reinstall. A failed probe stops before the large desktop download. For a new instance:

```sh
cd "$HOME/grokbot/src"
python3 host/deploy.py init < /dev/null
python3 host/deploy.py up < /dev/null
python3 host/deploy.py status < /dev/null
```

`init` creates `~/grokbot/.env` once. The default address `http://127.0.0.1:18080` is local to the server. The web client has its own port and address, apart from the admin page: the port defaults to `--port` plus one (18081; change it with `--web-port`), and `webClientUrl` in the `init` output is the web client address. **A remote phone cannot pair with the server's loopback address.** Choose your access method before `init`:

- Existing HTTPS reverse proxy: add `--public-url https://bot.example.org` to `init`, substituting your domain. Proxy to loopback port 18080 and support WebSockets. There is no need to expose port 18080 publicly. For the web client, **give it an entry of its own**: preferably a subdomain such as `https://web.bot.example.org`, proxied to loopback port 18081, also with WebSockets, and add `--web-public-url https://web.bot.example.org` to `init`. Never put it under the admin address with a path such as `https://bot.example.org/web/`.
- Private network or LAN: add `--listen PRIVATE_SERVER_IP --public-url http://PRIVATE_SERVER_IP:18080`; the web client is then at `http://PRIVATE_SERVER_IP:18081/web/`. Bind the intended interface and restrict access to trusted devices. Do not send credentials or pairing codes over public HTTP.
- Separate desktop: run `python3 host/deploy.py --host-only init`; subsequent operations remember this mode. Use `--home` and `--project` for a custom instance; global options precede the command. Old `.env` files have no mode marker: for a split deployment always pass `--host-only` and the original project name.

<a id="91-windows-1011-x64"></a><a id="92-mac-apple-silicon"></a><a id="94-android-phone"></a>
## Connect and verify

1. Run `python3 host/deploy.py setup-key` in a private terminal; do not forward the output to chat. Use it in the console to set a 12–128 character admin password. This first-use code is not a device pairing code.
2. For a split deployment, connect the execution node in the console first. In Models, add each model service first (API format, endpoint, and key), then create profiles that bind a service and model ID. OpenAI Chat and Responses normally use a `/v1` base; Anthropic Messages accepts the root. Match the provider's actual API. After setting a default route, individual Bots can override the primary model, reasoning effort and ordered fallbacks (switching rules are in the [technical documentation](ARCHITECTURE.en.md#model-adapter-layer)), without a Jev key. Test each profile before saving and wait for the Host to connect. Search, image generation, voice and push are optional.
3. Generate a 6-character, single-use pairing code in the console (valid for five minutes). Enter the same address as `GROKBOT_PUBLIC_URL` and the code in the client. Pair each device separately. On the Windows and Mac connect screen, turn on the Tailcat switch only when pasting the connection link from Remote access; leave it off for a private network or HTTPS address. Android and the web client need a private network address or HTTPS; they do not support Tailcat links.

<a id="client-packages"></a>
**Choose a client package:** every ZIP includes this guide, but only the tools that platform needs. The paths below start at the root of the indicated ZIP. Use the matching patch release; other packages are not expected to contain these files.

| Client | Pinned input and guide inside its package |
| --- | --- |
| Windows 10/11 x64 | Windows ZIP: `windows/README.en.md`. Build a portable client or installer from the official 1.2.3 x64 installer by default; if 1.2.3 does not work, add `--version 1.1.0` or `--version 0.71.2` to fall back. Keep the shared `mac/` directory in the same package. |
| Mac (Apple Silicon or Intel) | Mac ZIP: `mac/README.en.md`. Use the official 1.2.3 original; the tool picks the Apple Silicon or Intel build for the Mac's chip. Local graphical control also requires `--identity auto` certificate signing and OS permissions. |
| Linux desktop (x64 or ARM64) | Linux ZIP: `linux/README.en.md`. Build a portable folder, `.tar.gz` and per-user `install.sh` (no root needed) from the official 1.2.3 `.deb`; keep the shared `mac/` and `host/bin/` files in the same package. On Ubuntu 24.04+ with AppArmor userns restrictions, run the bundled `sudo …/setup-apparmor.sh` once. |
| iPhone | iOS ZIP: the Signing section of `ios/README.en.md`. Supply a decrypted 1.27.0 (29519, recommended), 1.26.0 (29388, fallback) or 1.16.0 (23152, fallback) IPA and follow `extension-signing.json` to configure signing for the main app and each of its three extensions. |
| Android 9+ | Android ZIP: `android/README.en.md`. Build an APK from the interface in the official Windows 1.1.0 installer (the same file as the Windows client) and the project shell by default; add `--version 0.71.2` if the 1.1.0 interface does not work. The official Android APK is not used. Back up your signing key separately; upgrades need the same key. |
| Web client (any browser) | Web client ZIP: `web/README.en.md`. On a computer, build the interface bundle from the official Windows 1.1.0 installer (the same file as the Windows and Android clients) and add `--upload <GROKBOT_PUBLIC_URL>` to install and enable it on the Host (pass the administrator password through `GROKBOT_ADMIN_PASSWORD`), or upload it on the admin page's Web client page; add `--version 0.71.2` if the 1.1.0 interface does not work. Then open the web client address in each device's browser (the `Web client` line printed by `init` and `update`: the host name with port 18081 by default, or `GROKBOT_WEB_PUBLIC_URL` behind an HTTPS reverse proxy) and sign in with a pairing code; old `<GROKBOT_PUBLIC_URL>/web/` links redirect there. Keep the shared `android/`, `windows/` and `mac/` directories in the same package. The bundle contains the official interface: install it only on the owner's own Host and never forward or publish it. |

See the [client version table](../README.en.md#client-versions) before obtaining originals. The store and stable feeds can move ahead of the patches; the tools require the inputs in the right column. The Android shell has its own app version, separate from the renderer and minimum OS version.

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
| Restore | Prepare a fresh project using the [volume recovery checklist](#volume-recovery); never restore over the original volumes |

Two things change when updating from 1.14.0 or earlier. The web client moves to its own port (18081 when `.env` has no `GROKBOT_WEB_PUBLIC_PORT`, with the host name of `GROKBOT_PUBLIC_URL`). If browsers reach it through an HTTPS reverse proxy, give the web client its own entry before updating and add `GROKBOT_WEB_PUBLIC_URL` to the instance `.env`. Several instances on one machine each need their own `GROKBOT_WEB_PUBLIC_PORT`; the tool refuses a port in use before building. Also, the execution desktop of 1.7.0–1.14.0 mounts the memory trees writable; `update` replaces them with read-only mounts.

An update builds the candidate first, then stops the original project, backs up its volumes and switches. If startup fails, check whether shutdown was confirmed; never attach the old image to potentially migrated volumes. Do not delete volumes or use `down -v`.

<a id="volume-recovery"></a>
### Volume backup and recovery

The backup contains archives of the project's managed data volumes and a checksum manifest. **It does not include Docker images, the instance directory's `.env`, or the host operating system.** A local deployment archives `host-data`, `box-home` and `box-workspace`. In split mode the Host archives only `host-data`; back up `gateway-data`, `box-home` and `box-workspace` separately on the execution machine. Volumes can contain device credentials, model keys, conversations and workspace files. Keep backups private to the owner.

1. Retain the volume backup, original `.env`, matching code revision and images separately. `serviceImages` in the manifest records full IDs, not image contents. The target daemon must already have those exact images; a tag with the same name is not sufficient.
2. Confirm that the original instance and every copy of its identity on other daemons are stopped. Coordinate writes on both machines for a split backup. Project locks apply only within one Docker daemon. Across daemons the operator must serialize operations and prevent two copies of the identity from running. Do not start recovery while this is uncertain.
3. Use a fresh instance directory, project name and volumes. Recreate the original topology and public address. The Data and backups section in the Host package's `host/README.en.md` contains the `init` and `recover` example and a volume-only alternative. After startup, use the previously paired device to read its messages, attachments and settings, then test new chat and desktop operations. Extracting the archives alone does not establish recovery.

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
| The web client does not open, or fails after the `/web/` redirect | The web client has its own port (18081 by default). Check that the firewall and reverse proxy give it an entry and that `GROKBOT_WEB_PUBLIC_URL` in `.env` is the address browsers actually use; it must differ from `GROKBOT_PUBLIC_URL` |

Use the platform guides for client-specific problems. Include architecture, code revision, steps and redacted logs in reports; exclude passwords, pairing codes and backups.
