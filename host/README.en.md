# ProkBot Plus Host Patch

Self-host the Grok Bot server. Requires Python 3.10+ and Docker Compose; the runtime uses Linux amd64. Tested on Ubuntu 24.04 with Docker 29 (the distribution's `docker.io` and `docker-compose-v2`). Apple Silicon can also build the amd64 image.

For the full deployment steps see the [AI install guide](../docs/AI-INSTALL.en.md); for how it works see the [technical documentation](../docs/ARCHITECTURE.en.md).

[简体中文](README.md)

## Use

```sh
python3 release/build-docker.py
docker compose -f release/compose.yaml up -d
docker compose -f release/compose.yaml exec host cat /data/setup-key
```

Open `http://127.0.0.1:18080`, use the setup code to create an administrator account, configure a model (OpenAI Chat, OpenAI Responses or Anthropic Messages API) and create a six-character pairing code.

- LAN access: run `export GROKBOT_LISTEN_ADDRESS=0.0.0.0` before starting Compose. Set the port with `GROKBOT_PUBLIC_PORT`.
- Remote access: use an HTTPS reverse proxy, or enable Tailcat in the console.

## Offline builds

By default the build tool downloads the original files from pinned sources and verifies them strictly; see `recipes/host/manifest.json` and `release/build-docker.py` for the versions. If you already have the original files:

```sh
python3 release/build-docker.py --host-archive /path/to/sand-host-bundle-d0a4baa.tgz --box-archive /path/to/box.tar.gz
```

After verification the Box archive is tagged `grokbot-box-input:9d2ac1b`, and Compose uses that local image. New Docker 29 installations use the containerd image store, where the image ID is the pinned manifest digest; the build tool accepts it. Offline archives are verified by their config digest regardless of the store.

`release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` generates the Host files on their own and records the patch time. It only copies fixed bytes and applies added rules; it does not call an AI or decompile anything.

## Data and backups

Data lives in three volumes: `host-data`, `box-home` and `box-workspace`. A backup pauses the running containers, saves all volumes with checksums, then resumes them. Restore into a new Compose project so the existing volumes are not overwritten:

```sh
python3 release/backup.py backup --project grokbot --directory backups/2026-10-21 --image grokbot-host:local
python3 release/backup.py restore --project grokbot-restored --directory backups/2026-10-21 --image grokbot-host:local
docker compose -p grokbot-restored -f release/compose.yaml up -d
```

Restore with the image version that matches the backup. The restored instance has the same identity as the original; stop the original before starting it.

## Separate execution computer

Use `release/compose.host.yaml` to deploy the Host alone. Deploy an execution node on another computer:

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
