# ProkBot Plus Host

[简体中文](README.md)

A self-hosted Grok Bot server. The Host builds on Linux amd64 / arm64; the official execution desktop is amd64 only, so an ARM machine pairs with a separate amd64 node or emulates it (experimental). Requires Python 3.10+, Docker and Compose v2; with Docker Engine 26.0+ (API 1.45+) and Compose 2.26.0+, a same-machine deployment also lets the Bot read its memory (see [Data and backups](#data-and-backups)).

See the [deployment guide](../docs/AI-INSTALL.en.md) for the full steps and the [technical documentation](../docs/ARCHITECTURE.en.md) for how it works.

## Usage

Run in the `host/` directory:

```sh
python3 deploy.py doctor
python3 deploy.py init
python3 deploy.py up
```

A new installation listens only on loopback by default; set a custom address during `init` (`python3 deploy.py init --help`). For an existing instance use `update`, not another `init`. First-time setup, models and pairing are in the deployment guide. The web client has its own port and address; see [Web client](#web-client).

## Web client

The admin page's **Web client** section accepts a web interface bundle (see the [web client guide](../web/README.en.md) for building one); browsers can then sign in with a pairing code. Nothing changes until one is uploaded.

The web client is served on a second Host port (8001 in the container); the admin page and the apps keep using 8000. The two ports are two different origins: the bundle contains the official interface's code, and on an origin of its own that code cannot call the admin API, even in a browser that has signed in to the admin page. The web client port serves only the sign-in page, the bundle and the device API the web client uses; old `/web/` links on the admin address redirect there.

- **Port**: Compose maps the web client to `GROKBOT_WEB_PUBLIC_PORT` in `.env` (`init --web-port`, by default `--port` plus one, that is 18081; instances from before 1.15.0 lack the setting and get 18081). It listens on the same address as the admin page, set by `GROKBOT_LISTEN_ADDRESS`. Direct access by IP address or host name plus port needs nothing else: the web client address is the same host name with the web client port.
- **Several instances**: each instance on one machine needs its own `GROKBOT_PUBLIC_PORT` and `GROKBOT_WEB_PUBLIC_PORT`. `up`, `update`, `recover` and `doctor` refuse ports another container or program already uses, or two equal ports, before building, stopping or unpacking anything.
- **HTTPS reverse proxy**: give the web client an entry of its own, preferably its own subdomain, and tell the Host both addresses: add `--web-public-url https://web.bot.example.org` to `init` for a new instance, or add `GROKBOT_WEB_PUBLIC_URL` to the `.env` of an existing one and run `update`. The two addresses must differ, or the Host refuses to start, and `up`, `update`, `recover` and `doctor` refuse them before changing anything; do not put the web client under a path of the admin address either, such as `https://bot.example.org/web/`.
- **Web client address**: `webClientUrl` in the `init` output, the `Web client` line at the end of `up` and `update`, `webClientUrl` in `doctor` and the admin page's **Web client** section all show it.

```sh
GROKBOT_PUBLIC_URL=https://bot.example.org
GROKBOT_WEB_PUBLIC_URL=https://web.bot.example.org
```

The web client entry forwards to `127.0.0.1:18081` and allows WebSocket, which the Bot computer view and realtime voice use. With nginx:

```nginx
server {
    listen 443 ssl;
    server_name web.bot.example.org;
    # ssl_certificate and ssl_certificate_key for your certificate
    location / {
        proxy_pass http://127.0.0.1:18081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

## Environment variables

Settings in the instance `.env` file tune the Host container (applied to both single-machine and standalone Host deployments):

- `GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES`: Byte threshold for fast-opening large `conversation-blobs.db` files, defaulting to `33554432` (32 MiB). When a database exceeds this size and has no pending recovery marker, open runs a structural probe to avoid startup stalls and then runs `PRAGMA quick_check(1)` off the main event loop in a worker thread using `node:sqlite`; if corruption is found, a `.quickcheck-required` marker is written so the next open falls back to the stock full quarantine and salvage flow. Note that `quick_check(1)` only stops after reporting the first error and still scans the entire file for healthy large databases; the verified stamp tracks `(size, mtimeMs)`, which WAL checkpoints update, so active large databases will typically rescan in the background on cold restarts. Set this to `infinity` to restore the original synchronous `quick_check` on every open.
- `GROKBOT_DESKTOP_PARK_ENABLED`: Opt-in toggle for automatic idle parking of per-Bot `Fork` desktops on the shared execution Box (`0` / disabled by default; set to `1` to enable). When enabled, Fork desktops with no active turn, pending approval or handoff, running background shell work, in-flight Box command, or attached VNC viewer are parked via `/usr/local/bin/stop-window --park` after `GROKBOT_DESKTOP_PARK_IDLE_MINUTES` (default `30` minutes) — stopping Chrome, `Xvfb`, `x11vnc`, `exec-daemon`, and processes tagged with `SAND_DESKTOP_UNIT=:N` or using that Chrome profile while preserving seat ownership and the `Fork-<N>` directory for transparent wake-up (note: detached background commands lose their parent and display, GUI programs, active Chrome downloads, and in-memory session cookies or open tabs may be interrupted/unrecoverable while persistent cookies remain; Chrome restarts on wake, so the first browser action may fail with "could not capture the current page state", as it does in the stock Host after a Box restart, and a retry works). When Box `MemAvailable` drops below `GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT` (default `15`%) or memory PSI `avg10` exceeds `GROKBOT_DESKTOP_PARK_PRESSURE_PSI` (default `10`) — reflecting machine-wide memory in single-host deployments — least-recently-used Fork desktops idle for at least `GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES` (default `5` minutes) are parked early. `GROKBOT_DESKTOP_PARK_MAX_PER_TICK` (default `5`, allows `0`) and `GROKBOT_DESKTOP_PARK_INTERVAL_MS` (default `60000`, minimum `10000`) control batch size and poll cadence; when disabled (`0`), no Computer/Box overrides are installed and stock behavior is preserved unchanged.
- `GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS`: Maximum attempts for the Shell and MCP auto-review classifier, defaulting to `2` (valid range `1`–`5`), so a single transient 10 s classifier timeout retries automatically instead of immediately rejecting the action.

## Model capability sync and cache

Each model profile can choose `auto` or `manual` independently. Existing profiles upgraded from earlier releases (including unmigrated legacy single-provider `model.env`, even with context `0`) remain `manual` in both the admin UI and runtime, never silently applying built-in context-window guesses. `host-admin.mjs model-set` switches to `manual` only when `--context` / `--efforts` is passed, preserving the existing mode otherwise.

- **Cache files**: the admin service writes upstream `/models` context limits (≥ 1024), supported reasoning efforts, and sync switches to `/data/model-context-cache.json`; the Host runtime writes learned overflow ceilings to `/data/model-context-observed.json` (kept for 30 days, persisted only on comparison errors such as `a + b > c` or two consistent observations). Both files are keyed by SHA-256 digests of format, base URL, and model ID, without plaintext API keys or URLs.
- **Manual mode and self-healing**: `manual` profiles are never clamped by observed ceilings, and both `manual` profiles and admin UI recommendations use 75% of the full window for the summary threshold. `auto` context mode uses only upstream `/models` values and runtime observed ceilings (built-in reference values appear only as suggestions in the admin UI until explicitly applied as `manual`), computing the summary threshold as 75% of the input budget after deducting output reserves (for example, 102K for a 200K Anthropic model after deducting the default 64K `max_tokens`). Observed ceilings can be cleared via "Clear observed ceiling", manual "Sync upstream", or saving the configuration: a save clears only profiles whose provider format, URL, key, model or context settings changed, and all profiles when none of these changed (an unchanged save, a rename or a route edit). Observations produced before clearing are discarded.
- **Background sync switches**: under "Upstream sync settings" on the admin Model page, "Auto-sync upstream model capabilities" (on by default) fetches `/models` with your API key at startup, on save, and every 6 hours only for providers with at least one `auto` profile (skipping when all profiles are `manual`; turning the toggle off stops all background requests); "Probe Codex client manifest parameter" (`?client_version=0.160.0`) is off by default and sent only when explicitly enabled.

## Offline builds

By default the build downloads the originals from pinned sources and verifies them strictly; versions are in `recipes/host/manifest.json`. With the originals already at hand:

```sh
python3 deploy.py up --host-archive /path/to/host.tgz --box-archive /path/to/box.tar.gz
```

- A verified Box archive is tagged `grokbot-box-input:9d2ac1b` and used by Compose directly. Offline archives are checked by their config digest, whatever image store Docker uses.
- For an existing instance replace `up` with `update`; to build without starting, `release/build-docker.py` takes the same options.
- These options only replace the original downloads. A fully offline build also needs the base images, system packages and npm dependencies cached, and a single ARM machine needs amd64 `busybox:1.37`. A standalone ARM Host takes no `--box-archive`.
- `release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` generates the Host files on their own, with fixed byte copies and additions only, no decompilation.

## Data and backups

```sh
python3 deploy.py backup < /dev/null
```

- A single-machine deployment backs up `host-data`, `box-home` and `box-workspace`; a standalone Host has only `host-data`, and the execution node backs up `gateway-data` and the two desktop volumes separately.
- A backup holds only volume archives and a checksum manifest, **not images, the instance's `.env` or the host system**. Volumes hold pairing identities, model keys, chats and workspace files; keep backups private.
- A backup pauses running containers and restores their state afterwards. `update` builds the candidate first, then stops the old services and backs up. A split deployment is not an atomic snapshot across machines; stop writes on both sides.
- **The Bot reading its memory**: on a same-machine deployment with Docker Engine 26.0+ (API 1.45+) and Compose 2.26.0+, `up`, `update` and `recover` add `release/compose.memory.yaml`, which mounts the five data trees `agents`, `user-memory`, `workflows`, `plugins` and `managed-skills` **read-only** at `/data/runtime/host-data/<tree>` in Box. The Bot can look through its memory but cannot change any Bot's settings, memory or automations. `agent-transcripts`, `connector-secrets`, `model.env`, `auth.json`, `projects` and internal tokens are never exposed to Box; the databases inside `agents/<id>/` are visible to the Bot's Shell but refused to the Read tool, as in the official same-machine setup. With older versions the tool says so and deploys without it; `memoryMounts` in `doctor` tells whether it can be turned on, and `--host-only` mounts none of these trees. Data initialization changes ownership and mode only on directories it creates, never existing top-level trees. Deployment, backup and recovery validate the mount set. Boxes of 1.7.0–1.14.0 mount these trees writable; `backup` still backs them up, and `update` replaces them with read-only mounts.

**Recover into a new instance**: keep the volume backup, the original `.env`, the matching code revision and the images separately; `serviceImages` in the manifest records full image IDs, and the target Docker must already have those images. First confirm that the original instance and any copy of its identity elsewhere are stopped, and never run `down -v` on the original project. The example below is a single-machine loopback setup; replace the directory and project name. To keep existing pairings working, recreate the original address with `--listen`, `--port` and `--public-url` on `init` (and `--web-port` and `--web-public-url` for the web client); `recover` refuses ports another container or program already uses before unpacking. A standalone Host adds `--host-only` before `init`.

```sh
python3 deploy.py --home "$HOME/grokbot-restored" --project grokbot-restored init < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" recover --directory /path/to/backup < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" status < /dev/null
```

`recover` checks the volumes, project name, topology and local image IDs, unpacks only into the new project and starts it with the recorded images only, without building, pulling or touching the original volumes. Afterwards, read old chats and files back with an original device. If startup fails, the new project's volumes are kept and the original instance is not restarted automatically.

If an old manifest lacks complete `serviceImages`, or the exact images are not on this machine, the instance cannot be brought back automatically; do not guess a version from a `:local` tag. To restore data only, use `python3 release/backup.py restore --project grokbot-data-only --directory /path/to/backup --image <verified image ID> < /dev/null`; it starts nothing, and a standalone execution node uses the same entry point. To start a same-machine deployment by hand with Compose afterwards, `-f release/compose.yaml` is enough, but leaves memory reading off. Turn it on only after confirming Docker Engine 26.0+ and Compose 2.26.0+: run the first command below once to create the directories the Bot's computer mounts (only where missing), then pass both files to every later Compose command. Engine before 26 ignores the subpath and mounts all of `host-data`, model keys and sign-in credentials included, into the Bot's computer, and Compose before 2.26 refuses to start. `deploy.py` decides and does this automatically in `up`, `update` and `recover`.

```sh
docker compose --env-file <instance directory>/.env -p <project> -f release/compose.yaml run --rm --no-deps --user 0:0 --entrypoint python3 host /opt/grokbot/release/data_init.py /data/runtime/host-data < /dev/null
docker compose --env-file <instance directory>/.env -p <project> -f release/compose.yaml -f release/compose.memory.yaml up -d < /dev/null
```

On one Docker daemon, the deployment tool uses locks so that a project is not changed concurrently and a recovered copy does not go online twice. Different daemons share no locks; the operator makes sure each identity runs only once. A crash can leave a lock behind: check the services and running operations first, and do not treat removing locks as a routine step. A project whose name ends in `_restore-in-progress` is an unfinished recovery; do not start it, and retry with another empty project.

## Separate execution computer

On the Host machine run `python3 deploy.py --host-only init`, then `python3 deploy.py up`. Deploy the execution node from `host/` on a second **amd64 Linux** machine:

```sh
python3 release/build-docker.py --box-only
# Set a random GROKBOT_NODE_TOKEN of at least 32 characters; add --box-archive above for an offline image
docker compose -f release/compose.execution.yaml up -d --build
```

Then enter the node's address and key on the Host admin page and enable it. In `--host-only` mode the chat core starts only after a model is configured and the node is enabled; without a node the admin page opens and the container may look healthy, but chat does not work.

- LAN access: set `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`; the default port is 18443.
- Embedded network: set `GROKBOT_TAILCAT_ENABLED=1`; advanced options are `GROKBOT_TAILCAT_RELAY` and `GROKBOT_TAILCAT_DERP_MAP_URL`.

<a id="capacity-benchmark"></a>
## Whole-machine benchmark

`bench/` compares the whole-machine resource use of two versions on the same machine. It is not a backup tool and does not set hardware minimums. Run it only on dedicated, authorized non-production Linux virtual machines, never with production services, volumes or credentials.

| `--mode` | What is sampled |
| --- | --- |
| `x86-local` | Single machine: `host` and `box` on an amd64 Host |
| `arm-split` | Split: `host` on the arm64 Host; `gateway` and `box` on a second amd64 machine (with `--role desktop`), both with the same `--run-id` |
| `arm-emulated` | Emulated single machine (experimental): `host` and the emulated amd64 `box` on arm64 |
| `host-only` | `host` only, for setup and idle diagnostics; no capacity verdict |

```sh
R=/path/to/private-bench
python3 -B bench/bench.py sample --isolated-guest --mode x86-local --role host \
  --project benchdemo --run-id before-1 --out "$R/BEFORE/1/host.jsonl" --interval 5 --duration 5400
python3 -B bench/bench.py validate "$R/BEFORE/1" > "$R/round-report.json"
python3 -B bench/bench.py compare --before "$R/BEFORE" --after "$R/AFTER" > "$R/comparison.json"
```

- The sampler needs a VM recognized by `systemd-detect-virt --vm`, cgroup v2 and the local Docker socket; bare metal, WSL, containers and remote or rootless Docker are refused. Start building or loading only after stderr reports `sampling-ready`.
- Each round directory needs `run.json`, `actions.jsonl` and each role's samples. The rules for fields and phases (`build`, `cold`, `idle`, `chat`, `desktop`, `restart`, `soak`, `concurrent`) are in [`bench/evidence.py`](bench/evidence.py), with examples in [`tests/benchmark_checks.py`](tests/benchmark_checks.py). Only measurements from real clients against an external model API count; `soak` needs at least one hour of real load per round.
- `compare` needs at least three pairs of baseline and candidate rounds under the same conditions, keeping failed rounds. Exit code `0` means reviewable (not a hardware certification), `1` failed, incomplete or too few rounds, `2` invalid input or mismatched conditions. How metrics are computed is in [`bench/telemetry.py`](bench/telemetry.py).
- Offline self-test: `python3 -B bench/bench.py selftest`; regression tests: `node --test "tests/benchmark*.test.mjs"`.

The homepage minimum and recommendation come from functional tests and real usage, not from this comparison; see the [technical documentation](../docs/ARCHITECTURE.en.md#capacity-evidence).

## App development

Apps on the admin page manage remote MCP services, apps with code and their bundled skills in one place. An app is a single `grokbot-app` JSON package; old plugin JSON files can be imported too.

- The built-in "Write an app" provides the guide, format validation and a submit tool. After a Bot submits an app, the user adds and authorizes it under Connected apps in the client.
- Import and export are a single JSON file with code, icon, description and skills; saved settings and credentials are never exported.
- Code apps run as MCP processes on the execution computer, with no extra container, sharing that computer's user permissions, files and network with its other tasks.
- OAuth supports PKCE, one-time state and refresh on expiry. Developers declare the authorization URL, token URL and scopes; users enter the Client ID/Secret and open the provider's authorization page from the client.
- App versions cannot be overwritten; after an upgrade you can restore the previous version.

The full package format, runnable examples and OAuth examples are in [server/application-guide.md](server/application-guide.md), the same guide Bots read when they write apps.

## License

Noncommercial use only; see [LICENSE](LICENSE). Most of this project's code was written with AI assistance.
