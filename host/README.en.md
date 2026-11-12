# ProkBot Plus Host Patch

Self-host the Grok Bot server. The Host builds for Linux amd64 or arm64; the original execution desktop is amd64 only. ARM can use a separate amd64 node or local emulation (experimental). Requires Python 3.10+ and Docker Compose v2.

For the full deployment steps see the [AI install guide](../docs/AI-INSTALL.en.md); for how it works see the [technical documentation](../docs/ARCHITECTURE.en.md).

[简体中文](README.md)

## Use

```sh
python3 deploy.py doctor
python3 deploy.py init
python3 deploy.py up
```

Run these from `host/`; a new install defaults to loopback. Set a custom access address at `init` (see `python3 deploy.py init --help`). For an existing instance use `update`, not `init`. See the install guide for setup, model configuration and pairing.

## Offline builds

By default the build tool downloads the original files from pinned sources and verifies them strictly; see `recipes/host/manifest.json` and `release/build-docker.py` for the versions. If you already have the original files:

```sh
python3 deploy.py up --host-archive /path/to/host.tgz --box-archive /path/to/box.tar.gz
```

After verification the Box archive is tagged `grokbot-box-input:9d2ac1b`, and Compose uses that local image. New Docker 29 installations use the containerd image store, where the image ID is the pinned manifest digest; the build tool accepts it. Offline archives are verified by their config digest regardless of the store.

Select the instance with `init` first; use `update` instead of `up` for an existing instance. For build-only work `release/build-docker.py` accepts the same archive flags. These replace only upstream downloads. A fully offline build needs cached base images, OS packages, npm dependencies and, on local ARM, amd64 `busybox:1.37`. Omit `--box-archive` for a split ARM Host; amd64 Hosts still use Box as their base.

`release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` generates the Host files on their own and records the patch time. It only copies fixed bytes and applies added rules; it does not call an AI or decompile anything.

## Data and backups

Local mode has three volumes: `host-data`, `box-home` and `box-workspace`. In split mode back up each machine separately. Backup pauses running project containers, saves volumes with checksums, and resumes them. Keep the `.env` and corresponding code revision separately. Restore into a new project without overwriting existing volumes:

```sh
python3 deploy.py backup < /dev/null
python3 release/backup.py restore --project grokbot-restored --directory /path/to/backup --image grokbot-host:local < /dev/null
```

`restore` restores data without starting services. Use the matching image version and replace `/path/to/backup` with the reported backup directory. Confirm the original instance has stopped before starting the restored instance with the same identity. Run Compose with the original `--env-file` and `-p grokbot-restored`, using `release/compose.yaml` for a local desktop or `release/compose.host.yaml` for a split Host. For subsequent operations copy `.env` into a separate instance directory and update `PROKBOT_PROJECT`; never overwrite the original config.

## Separate execution computer

On the Host use `python3 deploy.py --host-only init` then `python3 deploy.py up`. Deploy the execution node from `host/` on a separate **amd64 Linux** machine:

```sh
python3 release/build-docker.py --box-only
# Set a random GROKBOT_NODE_TOKEN of at least 32 characters. Add --box-archive above for an offline image.
docker compose -f release/compose.execution.yaml up -d --build
```

Then enter the node's address and key in the Host console.

- LAN access: set `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`. The default port is 18443.
- Embedded networking: set `GROKBOT_TAILCAT_ENABLED=1`. Advanced options are `GROKBOT_TAILCAT_RELAY` and `GROKBOT_TAILCAT_DERP_MAP_URL`.

## App development

Applications in the console manage remote MCP services, apps with code and bundled skills. One app is one `grokbot-app` JSON package; old plugin JSON files can still be imported.

- The built-in "Write an app" tool provides the guide, format validation and submission. After a Bot submits an app, the user adds and authorizes it in the client's original Connected Apps screen.
- Import and export use a single JSON file with code, icon, description and skills. Saved configuration and credentials are never exported.
- Code apps run as MCP processes on the existing execution computer, without extra containers. They share that computer's user permissions, files and network with its other tasks.
- OAuth supports PKCE, one-time state and refresh on expiry. The developer declares the authorization URL, token URL and scopes; the user enters the Client ID/Secret and opens the provider's authorization page from the client.
- Substantial coding work calls Codex on a connected computer, with that computer's model settings and login.
- App versions are immutable; after an upgrade you can restore the previous version.

For the full package format, a runnable example and OAuth examples see [server/application-guide.md](server/application-guide.md). This is the same guide a Bot reads when it writes an app.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most code in this project was generated with AI assistance.
