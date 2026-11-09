# AI deployment guide

[简体中文](AI-INSTALL.md)

This guide is written for an AI that deploys ProkBot Plus for a user. People can follow it too. Run it one step at a time, from top to bottom. **Do not skip steps.**

**If the user wants to update an existing deployment rather than install a new one**, skip the list in step 0 and go straight to [appendix A, "Update to a new version"](#appendix-a-day-to-day-operations).

## Read this first

**How to read this guide**

- `<angle brackets>` are placeholders. Replace them with real values before you run anything.
- Every step lists what you should see. If you don't see it, first check the "If it fails" part of that step, then the [troubleshooting](#appendix-b-troubleshooting) section at the end. Do not go on until the problem is solved.
- The user's passwords and API keys:
  - On the server, keep them only in the private folder `~/grokbot/secrets/` (created in step 4, readable only by the deployment user). The Host also keeps its own copy in its data volume.
  - Do not put them in documents that will be shared, do not commit them to any repository, and do not put them in command-line arguments (other users on the server can see command-line arguments with `ps`).
  - They will show up in your conversation with the user, which can't be avoided, but do not copy them anywhere else.
- **Never delete Docker volumes, under any circumstances.** These are the volumes whose names start with `grokbot_`.

**Who does what**

| Task | Who |
| --- | --- |
| Run commands on the server | You (the AI) |
| Build the Windows or Mac client | You, if you are running on that computer. Otherwise give the commands to the user |
| Type SSH passwords and sudo passwords | The user. You can't type into a password prompt |
| Double-click to install the client, enter the address and pairing code in the client, click through the admin page, send messages to check the result | The user. These are graphical interface tasks. Tell them what to do, one item at a time |

**How to run commands on the server (important)**

You usually run commands over SSH. **Every SSH call is a new session**: variables and functions defined in one call no longer exist in the next.

So write each piece of work on the server as one complete script, and send the whole script over standard input:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
# Commands for this step
EOF
```

- `'bash -s'` and `<<'EOF'` **both need the single quotes**. This way `$variable` and `$(command)` are expanded on the server, not on your computer.
- On Windows, run it in Git Bash. **Do not use Windows PowerShell**: it doesn't support this syntax, and it corrupts data in pipes. If the computer has no Git Bash, first ask the user to install Git for Windows (https://git-scm.com/download/win ; the default options are fine).
- If you are running on the server itself, just give the script to bash directly. You don't need ssh.
- **Every command in the script that may read input** (`docker compose exec`, `apt-get`, the backup and restore scripts and so on) needs `< /dev/null` at the end. Otherwise it reads the rest of the script as its input, the commands after it never run, and no error is shown. The commands in this guide already have it.

**Common preamble**

From step 5 on, every server script that uses `$DC`, `hostadmin`, `$LOCAL_URL` or `$MODEL_API_KEY` starts with these lines. Wherever this guide says `<common preamble>`, paste these lines unchanged:

```sh
cd ~/grokbot
PORT=18080                                      # Change this if you switched to another port in step 1
LOCAL_URL=http://127.0.0.1:$PORT                # If you set the listen address to a specific IP as in appendix B, replace 127.0.0.1 with that IP too
DC="docker compose --env-file .env -p grokbot -f src/host/release/compose.yaml"
hostadmin() { docker run --rm --network host -v ~/grokbot/src/host:/src:ro -e GROKBOT_URL -e GROKBOT_ADMIN_PASSWORD -e GROKBOT_SETUP_KEY -e MODEL_API_KEY node:22-bookworm-slim node /src/tools/host-admin.mjs "$@"; }
export GROKBOT_URL=$LOCAL_URL
[ -f secrets/admin-password ] && export GROKBOT_ADMIN_PASSWORD="$(cat secrets/admin-password)"
[ -f secrets/model-api-key ] && export MODEL_API_KEY="$(cat secrets/model-api-key)"
```

`hostadmin` is the command-line admin tool that comes with the repository. It runs in a Docker container, so the server doesn't need Node.js. The first time it runs, it downloads the `node:22-bookworm-slim` image automatically if the server doesn't have it yet.

**Overall flow**

```text
Step 0 Tell the user what to prepare → Step 1 Check the server → Step 2 Put the code on the server → Step 3 Build the images
→ Step 4 Write the config and start → Step 5 Set up the administrator → Step 6 Configure the model → Step 7 Web access and images (optional)
→ Step 8 Access from outside your network (optional) → Step 9 Build the clients and pair → Step 10 Check the result → Step 11 Hand over
```

The build in step 3 takes tens of minutes. In the meantime you can do the "build the clients" part of step 9 (build only, don't pair yet).

---

## Step 0: Send the user the list of things to prepare

Before you do anything else, send the user the text below (you can change the wording, but don't leave anything out). Wait for the user's reply before you start step 1.

```text
To deploy ProkBot Plus, you need to prepare the following. Every required item is needed; optional items can be added later.

[Required]
1. A server: x86_64 Linux (Ubuntu 22.04/24.04 or Debian 12 recommended; a NAS that supports Docker also works).
   - About 8 GB of memory or more, 30 GB or more of free disk, and internet access (the first build downloads about 8 GB).
   - Tell me: the IP address and the SSH user name.
   - I need to be able to log in with an SSH key, without a password. If you can only log in with a password right now, tell me and I'll show you how to set up a key (it takes a few minutes).
   - Does this user have to type a password for sudo? If so, you will need to run the commands I give you for the software install step yourself.
   - If I'm already running on this Linux machine, just tell me "use this one".
2. A large language model API:
   - API format: one of Anthropic Messages / OpenAI Responses / OpenAI Chat Completions. If you're not sure, tell me the name of the provider and I'll work it out and test it.
   - The API address (Base URL), API key and the model you want (for example Claude Sonnet, GPT-5.5, DeepSeek V4. I can help you find the exact model name).
   - The model must support tool calls (function calling). For the Bot to operate a computer, it also needs image input.
3. Which devices you want to use it on:
   - A Windows 10/11 (64-bit) PC:
     - Is it the one I'm running on now?
     - Does it have Node.js 22.12 or newer, and Git for Windows (which includes Git Bash), installed?
     - Is "Windows Security → App & browser control → Smart App Control" turned on?
   - A Mac with an Apple Silicon chip:
     - Is it the one I'm running on?
     - Does it have Node.js 22.12+ and git installed?
     - Does it have the official Grok Bot installed?
   - An iPhone: harder. You need to provide your own decrypted Grok Bot 1.16.0 IPA and a signing certificate.

[Your choice]
4. Where you'll use it:
   A. Only on your home or office LAN (default, simplest);
   B. Also when you're out: use the built-in Tailcat, no public IP or domain needed;
   C. You already have a domain and an HTTPS reverse proxy: tell me the domain, whether the reverse proxy is Caddy or Nginx, and whether it is installed directly on the system or runs in Docker.
5. Administrator password: 12 to 128 characters. If you don't give me one, I'll generate a random one and tell you.

[Optional]
6. Web search, reading web pages, generating images: tell me if your model API supports them. If you're not sure, that's fine. I can test it.
7. Time zone (default Asia/Shanghai).
8. Which folder on your computer to save the deployment notes in (they include passwords).
```

After the user replies, check each item:

| Situation | What to do |
| --- | --- |
| Some required items are missing, for example the API key | Ask again, only for the missing items. Don't guess |
| Only a rough model name was given, for example "Claude Sonnet" | Go on for now. After step 6 lists the models, ask the user to confirm the exact model name |
| SSH only allows password login | Follow "Set up an SSH key" below |
| sudo needs a password | When you install software in step 1 or change the reverse proxy config in step 4.1, send the whole command block to the user and let them log in to the server and run it. None of the other steps need sudo |
| Only a Windows PC, no Linux server | The server can't be deployed directly on Windows. Ask the user to get a Linux machine or a cloud server. WSL2 + Docker is also worth a try, but it is not well tested; tell the user this first |
| The server is ARM | The images are amd64 only and won't work. Use an x86_64 machine |
| Windows has "Smart App Control" turned on | The built client is not code-signed and will be blocked outright. The user can turn it off in Windows Security (**once turned off, it can't be turned back on without reinstalling Windows**; tell the user this first), or use another computer |
| The user doesn't know the API format | See "How to choose the API format" in step 6 |

**Set up an SSH key** (when the user can only log in with a password):

1. If you are running on the user's computer, generate a dedicated key **with no passphrase** yourself. Otherwise give this command to the user:

   ```sh
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/grokbot_ed25519
   ```

2. Add the lines below to the end of `~/.ssh/config` (create the file if it doesn't exist). After that, `ssh <server IP>` uses this key and this user name automatically:

   ```text
   Host <server IP>
     User <user>
     IdentityFile ~/.ssh/grokbot_ed25519
   ```

3. Ask the user to **open a separate terminal window** (Git Bash on Windows) and run the command below. On the first connection it asks about the host fingerprint: type `yes`, then type the SSH password once:

   ```sh
   ssh-copy-id -i ~/.ssh/grokbot_ed25519.pub <user>@<server IP>
   ```

4. Check it yourself. If there is no error and nothing is asked, it worked:

   ```sh
   ssh -o BatchMode=yes <user>@<server IP> true
   ```

   If it reports `Host key verification failed`, ask the user to run `ssh <user>@<server IP> true` once in their own terminal and type `yes` to accept the host fingerprint.

---

## Step 1: Check the server

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
uname -m
free -h
for c in docker python3 git curl openssl; do command -v $c >/dev/null && echo "found $c" || echo "missing $c"; done
docker info --format 'Docker {{.ServerVersion}}, data directory {{.DockerRootDir}}' 2>&1 | tail -1
docker compose version
python3 --version
df -h "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib)" ~ /tmp
ls -d ~/grokbot 2>/dev/null && echo "~/grokbot already exists"
docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '_host-data$' && echo "ProkBot volumes already exist"
docker ps -a --filter ancestor=grokbot-host:local --format '{{.Names}}' 2>/dev/null | grep . && echo "ProkBot containers already exist"
ss -ltn | grep -w 18080 || echo "18080 is not in use"
EOF
```

**You should see:**

- `uname -m` prints `x86_64`;
- 7.5 GiB of memory or more (a machine sold as 8 GB usually shows 7.5–7.8 GiB);
- All five tools show "found";
- A line like `Docker 29.x.x, data directory /var/lib/docker`. A version number means Docker works. Testing was done with Docker 29. The somewhat older version that comes with the distribution also works, and you can ignore the legacy builder notice during the build;
- `docker compose version` shows a version number (Compose v2); Python is 3.10 or newer;
- The disk that holds the Docker data directory has ≥ 30 GB free, and `/tmp` has ≥ 5 GB free;
- **No** "~/grokbot already exists", "ProkBot volumes already exist" or "ProkBot containers already exist" line, and the last line is "18080 is not in use".

**If it fails:**

- **Docker is installed, but that line shows an error**: **do not reinstall Docker**, or you may replace the Docker that is already on the server. Handle it based on the error:
  - It contains `permission denied`: the current user has no docker access. Run `sudo usermod -aG docker "$USER"`. It takes effect from the next SSH connection;
  - It contains `Cannot connect to the Docker daemon`: Docker is not running. Run `sudo systemctl enable --now docker`.
- **Software is missing (it shows "missing docker" and so on)**: if sudo needs no password, run the commands yourself. If it needs a password, send the matching commands to the user and let them log in to the server and run them:

  - Ubuntu:

    ```sh
    sudo apt-get update < /dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 python3 git curl openssl < /dev/null
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER"
    ```

  - Debian and other distributions (with the official Docker install script):

    ```sh
    sudo apt-get update < /dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3 git curl openssl < /dev/null    # On non-Debian systems, use the matching package manager
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    ```

  After the install, docker access only works from the **next SSH connection** on. Then run the check in this step again. Don't work around it by putting `sudo` in front of commands: the build and backup scripts also call docker internally, and adding sudo causes problems.
- **"~/grokbot already exists", "ProkBot volumes already exist" or "ProkBot containers already exist" shows up**: this machine already has a deployment. **Do not deploy again, and do not install a second copy on another port.** Ask the user whether they want to update (see "Update to a new version" in appendix A) or only change the configuration.
- **Port 18080 is used by another program**: pick a free port (for example 18081). Change `PORT=` in the "common preamble" and the three 18080s in the script in step 4 to that port.
- **Clearly less than 8 GB of memory, or not enough disk**: tell the user to switch machines or add capacity.

---

## Step 2: Put the code on the server

Convention: the deployment directory is `~/grokbot`, and the repository goes in `~/grokbot/src` (`src` directly contains the repository root, with folders such as `host/` and `windows/`).

**Option 1: the server can reach GitHub (recommended)**

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
mkdir -p ~/grokbot/logs ~/grokbot/backups
git clone --depth 1 https://github.com/ferretgeek/prokbot-plus.git ~/grokbot/src
EOF
```

Use only this address. Don't get the code from any other repository or mirror site.

**Option 2: the server can't reach GitHub**

1. Get the repository on the user's computer: `git clone`, or download the ZIP and extract it.
2. Open **Git Bash** in the repository root (on Mac, use "Terminal"). Do not use Windows PowerShell 5.1.
3. Run the three commands below. The third one is required: files uploaded from Windows lose their "executable" permission, and it has to be restored.

```sh
ssh <user>@<server IP> "mkdir -p ~/grokbot/src ~/grokbot/logs ~/grokbot/backups"
tar -cf - --exclude=./.git --exclude=./windows/output --exclude=./windows/.cache --exclude=./mac/output.noindex . | ssh <user>@<server IP> "tar -C ~/grokbot/src -xf -"
ssh <user>@<server IP> "cd ~/grokbot/src && chmod +x host/bin/grokbot-tailcat mac/dist/network/grokbot-tailcat"
```

**You should see:** running `ssh <user>@<server IP> "ls ~/grokbot/src/host/release/build-docker.py"` lists this file.

**If it fails:**

- **`git clone` in option 1 times out**: use option 2 instead.
- **Line ending problems**: don't transfer files in a way that changes line endings, for example the "text mode" of some FTP tools. The scripts in the repository must keep LF line endings.

---

## Step 3: Build the images

The build downloads the original Host and the official Linux desktop image, which is about 7.7 GB. The first build takes 10 to 40 minutes. Later builds take about 6 minutes. Run it in the background with `nohup`, so a dropped SSH connection doesn't affect it:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
cd ~/grokbot/src
nohup python3 host/release/build-docker.py > ~/grokbot/logs/build.log 2>&1 < /dev/null &
echo "Build started in the background"
EOF
```

Check every 3–5 minutes:

```sh
ssh <user>@<server IP> 'tail -n 5 ~/grokbot/logs/build.log; pgrep -f "[b]uild-docker.py" >/dev/null && echo "Still building" || echo "Build process has exited"'
```

**You should see:** "Build process has exited", and the last line of the log is a JSON object that contains `"image": "grokbot-host:local"`.

**If it fails:**

- **"Build process has exited" but no JSON line**: look for the error in the log.
- **A download fails**: the build needs to reach these places:
  - Docker Hub (the `node` image);
  - Debian package sources and the npm registry;
  - `public.ecr.aws` (the desktop image);
  - AWS S3 (the original Host).

  If the server reaches the internet through a proxy, set the proxy in all three places below, then run this step again (the build can be run again safely):
  1. **Docker image pulls**: set a proxy for the Docker service (`HTTP_PROXY` / `HTTPS_PROXY` in systemd), then restart Docker;
  2. **apt and npm during the build**: set the proxy under `proxies` in `~/.docker/config.json`. Docker passes it into the build containers;
  3. **Downloading the original Host**: set the environment variable when you start the build, for example `https_proxy=http://<proxy address> nohup python3 host/release/build-docker.py ...`.

  For the exact syntax, follow the official Docker documentation.
- **`Unsupported Box image identity` or `Unsupported Host archive SHA-256`**: the downloaded original files don't match the pinned versions. A common cause is a Docker registry mirror that returned a different image. Turn off the mirror for now and try again, and make sure the code comes from the repository in step 2.
- **Not enough disk space**: free up space, then run this step again.

---

## Step 4: Write the config and start

First work out the two values for `.env` from the access method the user chose in step 0. **Fill in both values from the table**:

| User's choice | `<listen address>` | `<public URL>` |
| --- | --- | --- |
| A LAN | `0.0.0.0` | `http://<server LAN IP>:18080` |
| B Tailcat | `0.0.0.0` | `http://<server LAN IP>:18080`. Tailcat is turned on in step 8 |
| C Existing HTTPS reverse proxy | `127.0.0.1` | `https://<domain>`, with no port and no path (only a whole domain works; it can't be placed under `https://<domain>/some/path`) |

The Host address entered in the client must be **exactly the same** as `<public URL>` (that is, `GROKBOT_PUBLIC_URL`), including `http`/`https`, the IP or domain, and the port. With Tailcat, the client uses the Tailcat link instead; see step 8.

Then write the config, create the private folder, and start. If the port is not 18080, change `GROKBOT_PUBLIC_PORT`, the `curl` on the last line, and the port in `<public URL>` for options A and B:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
cd ~/grokbot
cat > .env <<'ENV'
GROKBOT_LISTEN_ADDRESS=<listen address>
GROKBOT_PUBLIC_PORT=18080
GROKBOT_PUBLIC_URL=<public URL>
TZ=Asia/Shanghai
ENV
chmod 600 .env
mkdir -p secrets && chmod 700 secrets
docker compose --env-file .env -p grokbot -f src/host/release/compose.yaml up -d
sleep 60
docker compose --env-file .env -p grokbot -f src/host/release/compose.yaml ps
curl -s http://127.0.0.1:18080/healthz; echo
EOF
```

**You should see:** `grokbot-host-1` shows `healthy` and `grokbot-box-1` shows `Up`; the last line is `{"ok":true,"initialized":false}`.

Options A and B: run `curl -s <public URL>/healthz` on the user's computer (not on the server) to confirm that it can be reached over the LAN. For option C, do step 4.1 first, then check from the user's computer.

**If it fails:**

- **Not `healthy` yet**: wait one more minute, then check again with `<common preamble>` plus `$DC ps`.
- **It never comes up**: look at the errors with `$DC logs --tail 100 host`.
- **Options A and B: works on the server, but the user's computer can't reach it**:
  - Check that `GROKBOT_LISTEN_ADDRESS` is `0.0.0.0`;
  - On a cloud server, also open this port in the security group.
- **Option C**: don't change the listen address to `0.0.0.0`, and don't open 18080 in the security group. The problem is in the reverse proxy; see step 4.1.

### 4.1 Set up the HTTPS reverse proxy (option C only)

Requirements:

- The reverse proxy forwards the whole domain (the root path `/`) to `http://127.0.0.1:18080`;
- It must support WebSocket and streaming output (Caddy supports both by default; for Nginx, configure it as shown below).

**First make sure this domain is not already used by another site.** If the config file already has this domain and it points to another program, **stop** and ask the user for a dedicated subdomain instead (for example `bot.<domain>`). Don't overwrite the existing site.

**Back up the existing config file before you change it.** Only add or change the block for this domain, and don't touch other sites. Changing the config needs sudo.

Caddy (the config file is usually `/etc/caddy/Caddyfile`):

```text
<domain> {
    reverse_proxy 127.0.0.1:18080
}
```

Check and apply:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

Nginx (inside the `server { ... }` block for this domain; keep the certificate lines as they are):

```text
location / {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Check and apply:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Notes:

- **When the reverse proxy runs in Docker**:
  - The config file is the one mounted into the container. Run `docker inspect <container name>` and look at `Mounts` to find where it is on the server;
  - The apply command becomes `docker exec <container name> caddy reload --config /etc/caddy/Caddyfile` (for Nginx, `docker exec <container name> nginx -s reload`);
  - `127.0.0.1` means the proxy's own container and can't reach ProkBot. In that case:
    - Replace `127.0.0.1` above with the server's LAN IP;
    - Change `GROKBOT_LISTEN_ADDRESS` in `.env` to this IP as well, and run `$DC up -d`;
    - Change `LOCAL_URL` in the "common preamble" to this IP as well.
- **The cloud server's security group only needs to allow 443** (and 80 if getting the certificate needs it). **Do not open 18080.**
- Behind a reverse proxy, the login rate limit of the admin page uses one shared counter for all visitors. If someone on the internet keeps guessing passwords, you may also get `HTTP 429` when you log in; just wait one minute. This is why the administrator password must be long enough.

**You should see:** running `curl -s https://<domain>/healthz` on the user's computer returns `{"ok":true,"initialized":false}`.

**If it fails:**

- A 502 response: the reverse proxy can't reach `127.0.0.1:18080`. Check that the Host is running, and whether the reverse proxy runs in Docker (see the notes above).
- Certificate errors or connection timeouts: check the DNS records for the domain, port 443 in the security group, and the reverse proxy logs.

---

## Step 5: Set up the administrator

First write the administrator password to a private file. **There are two cases. Run only one of the two blocks.**

If the user gave a password, replace all of `<admin password>` with the real password (12–128 characters, no spaces before or after it):

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
cd ~/grokbot && umask 077
cat > secrets/admin-password <<'PW'
<admin password>
PW
EOF
```

If the user didn't give a password, generate a random one. Write down the password it prints, and give it to the user at handoff:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
cd ~/grokbot && umask 077
openssl rand -base64 18 > secrets/admin-password && cat secrets/admin-password
EOF
```

Then set up the administrator:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
<common preamble>
export GROKBOT_SETUP_KEY="$($DC exec -T host cat /data/setup-key < /dev/null)"
hostadmin setup
EOF
```

**You should see:** the output `管理员已设置` (administrator set).

**If it fails:**

- **`GROKBOT_ADMIN_PASSWORD 需要 12–128 位`** (must be 12 to 128 characters):
  - First run `ssh <user>@<server IP> "wc -c ~/grokbot/secrets/admin-password"` to check that the password file exists and has the right length;
  - If the file doesn't exist, go back and write the password as above;
  - If its content is still the text `<admin password>`, the placeholder was not replaced.
- **`HTTP 429`**: too many setup or login attempts. Each IP gets at most 5 per minute. Wait one minute.
- **`cat: /data/setup-key: No such file`**: the Host has already been set up. Skip this step and write the existing administrator password to `secrets/admin-password`. If the existing password can't be found, see "Forgot the administrator password" in appendix B.

---

## Step 6: Configure the chat model

### How to choose the API format

| Provider | `--format` | What to put in `--base-url` |
| --- | --- | --- |
| Anthropic itself | `anthropic` | **The root URL** `https://api.anthropic.com` |
| OpenAI itself | `openai-responses` | `https://api.openai.com/v1` |
| DeepSeek and most other "OpenAI-compatible" services | `openai` | The part before `/chat/completions` in the provider's docs, for example `https://api.deepseek.com/v1` |
| Aggregator gateway, for Claude | Try `anthropic` first; if it doesn't work, use `openai` | The root URL for `anthropic`, the `/v1` URL for `openai` |
| Aggregator gateway, for other models; or really not sure | `openai` | The `/v1` URL |

URL rules:

- The two OpenAI formats: use the part **before** `/chat/completions` or `/responses`. Most of these end in `/v1`.
- The Anthropic format: use the root URL, which is the part without `/v1`, for example `https://gw.example.com`.

**Checking whether an aggregator gateway works with `anthropic`**: write the key first (see the first block below), then try once with `--test-only`. If it succeeds, use `anthropic`. If "模型服务返回" (the model service returned) shows 401, 404 or 405, switch to the `openai` format and the `/v1` URL. A 401 often means that the gateway's Anthropic endpoint doesn't accept the way the key is sent. It doesn't necessarily mean the key is wrong.

### Run

First write the API key to a private file:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
cd ~/grokbot && umask 077
cat > secrets/model-api-key <<'KEY'
<API key>
KEY
EOF
```

List the models:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
<common preamble>
hostadmin model-catalog --format <format> --base-url <base URL>
EOF
```

**You should see:** one model per line, in the form `model name  supported thinking efforts  context length`.

- If the user only gave a rough name (for example "Claude Sonnet"), pick the candidates from the list and ask the user to confirm the exact model name.
- Some providers return only part of their model list. **A model that is missing from the list may still work.** If the user is sure of the model name, go straight to the test below.

**How to choose the thinking effort:**

- If the user named one, use it.
- If not, look at the thinking efforts listed for this model: if it has `high`, use `high`; if the list is empty or has no `high`, use `default`.

Test and save:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
<common preamble>
hostadmin model-set --format <format> --base-url <base URL> --model <model name> --effort <thinking effort>
hostadmin status
EOF
```

`model-set` first sends a real request as a test, saves only if the test succeeds, and then waits for the Host to apply the change. To test without saving, add `--test-only`.

**You should see:** the test result contains `"ok": true`, followed by the output `已应用` (applied). In `status`, `hostConnected` is `true` and `reload` is `applied`.

This test sends only one simple message, without tools. Whether the model calls tools correctly is only confirmed in the check in step 10.

**If it fails:** the error usually looks like this: `错误：POST /admin/api/model/test → HTTP 502 模型服务返回 HTTP 401：...` (error: ... HTTP 502, the model service returned HTTP 401: ...). The outer 502 comes from the Host itself. **Look at the status code after "模型服务返回" (the model service returned)**:

| Model service returned | Fix |
| --- | --- |
| 401 / 403 | Wrong key, or no permission. If you are using the `anthropic` format with an aggregator gateway, try the `openai` format instead |
| 404 / 405 | Wrong URL. Check it against the URL rules above. Don't write `/chat/completions` or `/responses` twice |
| 400, mentioning thinking effort or effort | Use a value from the list, or use `--effort default` |
| `支持的思考强度为 [无]` (supported thinking efforts: [none]) | The model name has something like a prefix, so the Host can't tell which efforts it supports. Use `--effort default`, or add `--efforts low,medium,high` to list them by hand |
| The outer error itself is `HTTP 429` | Model tests are limited to 5 per minute. Wait one minute |
| 400 / 403, mentioning organization verification | Some OpenAI models require organization verification on the OpenAI platform first. Ask the user to complete verification, or use another model |

---

## Step 7: Web access and image generation (optional)

The Bot's three tools "Search the web", "Read web page" and "Generate image" only appear after a provider is configured on the Host. If the user doesn't need them, skip to step 8.

There are two kinds of URL here. Don't mix them up:

- **Root URL**: for example `https://api.anthropic.com`;
- **`/v1` URL**: the root URL followed by `/v1`, for example `https://api.anthropic.com/v1`.

**Web tools and image providers always use the `/v1` URL**, including Anthropic. This is different from the Anthropic root URL used for the chat model in step 6.

The model used for web access is separate from the chat model, and the two can be different. Usually pick a cheaper model from the same provider that supports web access.

**Test what the API supports first. Don't guess** (the key is passed to curl through a pipe, so it doesn't appear in command-line arguments):

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
<common preamble>
# Run whichever of the three tests fit the API; delete any whole block that doesn't apply
# 1. Claude native web search (Anthropic-format APIs only): it is supported only if this prints "Web search supported"
printf 'x-api-key: %s\n' "$MODEL_API_KEY" | curl -s <root URL>/v1/messages -H @- -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"<Claude model>","max_tokens":2000,"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":1}],"messages":[{"role":"user","content":"Use the web_search tool: today news"}]}' \
  | grep -q web_search_tool_result && echo "Web search supported" || echo "Not supported or request failed"
# 2. GPT native web search (OpenAI Responses APIs only): it is supported only if this prints "Web search supported"
printf 'Authorization: Bearer %s\n' "$MODEL_API_KEY" | curl -s <OpenAI-format /v1 URL>/responses -H @- -H "content-type: application/json" \
  -d '{"model":"<GPT model>","tools":[{"type":"web_search"}],"tool_choice":"required","input":"Search the web: today news"}' \
  | grep -q web_search_call && echo "Web search supported" || echo "Not supported or request failed"
# 3. Image models (OpenAI-compatible APIs only): lists models with image in the name
printf 'Authorization: Bearer %s\n' "$MODEL_API_KEY" | curl -s <OpenAI-format /v1 URL>/models -H @- | grep -oE '"id": *"[^"]*image[^"]*"' | head
EOF
```

Then configure it in the **admin page**. Open `GROKBOT_PUBLIC_URL` in a browser and log in with the administrator password. The user does this part, and you tell them what to fill in, one field at a time. **Always choose the "API type" first, then fill in the URL**, because switching the API type resets the URL to the official default:

1. **Web tools → Providers → Add:**
   - Name: anything, for example `claude-web`;
   - API type: "Native · Anthropic" (Claude, can both search and fetch web pages). If the API doesn't support it, choose "Native · Responses" instead (GPT, search only);
   - Endpoint URL: the `/v1` URL; API key; Model ID: the name of the model used for web access.

   After saving, in "Routing", set both "Search" and "Fetch" in the "Default" row to this provider (for "Native · Responses", set only "Search" and leave "Fetch" at "Off"), then click "Save".

   Then check it with "Test" at the bottom of the page: set "Tool" to "Search" and enter "today's news" in "Query or URL". If you chose "Native · Anthropic", also set it to "Fetch", enter `https://example.com/`, and test once more.
2. **Images & video → Providers → Add:**
   - Any name; for the API type choose "OpenAI Images"; fill in the `/v1` URL and the key.
3. **Images & video → Model → Add:**
   - For the provider, choose the one you just added; set the model ID to an image model name listed above, one that starts with `gpt-image` (for example `gpt-image-2`). The `dall-e` models support different sizes, so don't choose them;
   - Any name; set the capability to "Image generation"; save.

   Finally, select it under "Image generation" in "Default model", and click "Save".

No other settings are needed: the aspect ratio the Bot asks for is converted to a standard size automatically, and editing with a reference image works too. If you want more exact ratios or more parameters, you can write a parameter definition. This is advanced usage; see [Technical notes · Web access and image generation](TECHNICAL.en.md#web-access-and-image-generation).

**You should see:**

- Testing "Search" shows "N sources found"; testing "Fetch" (if you tested it) shows "N characters fetched".
- In the check in step 10, the Bot can search and generate images.

**If it fails:**

- The test reports `Service returned HTTP 401`: the key is wrong, or this service's Anthropic endpoint doesn't accept the way the key is sent (if you switched to the `openai` format in step 6 because of a 401, it is most likely the latter). `404`: the URL is not the `/v1` URL.
- **Neither kind of web search works in the three tests above**: tell the user that this API doesn't support web access for the Bot, skip the web tools setup, and go on with the later steps. Image generation can still be set up as usual.
- Image generation fails: run `$DC logs --tail 200 host` after `<common preamble>` and look at the related errors. OpenAI's `gpt-image` models may require organization verification first.
- If only "Native · Responses" is configured, the Bot can search but can't read web pages. Tell the user this at handoff.

---

## Step 8: Access from outside your network (optional, if the user chose B in step 0)

If the user chose A (LAN) or C (existing HTTPS), skip this step.

Ask the user to do the following in the admin page under "Remote access":

1. Turn on "Use Tailcat" and click "Save";
2. Wait until "Status" shows "Ready", then click "Test connection". It should say "Connected" or "Direct connection";
3. When pairing in step 9, click "Copy link" to get a link that starts with `tailcat://connect/`.

This link works like a key. Only the user should copy it and paste it into the client. Don't send it anywhere else.

When a client uses Tailcat, turn on the "Tailcat" switch in the connection screen and paste this link into "Host address". At home, the client can also keep connecting with the LAN address.

---

## Step 9: Build the clients and pair

The order matters: **build and install the client first, and create the pairing code only when the user is ready to enter it.** A pairing code is valid for only 5 minutes and can be used only once.

### 9.1 Windows 10/11 x64

Run this on the user's **Windows PC** (if you are running on this PC, do it yourself; otherwise give it to the user):

1. `node --version` should show v22.12 or newer. If not, ask the user to install the LTS version from https://nodejs.org. Windows 10 also needs 7-Zip.
2. Get the repository (`git clone`, or download the ZIP and extract it), then run this in the repository root (Git Bash, cmd or PowerShell all work):

   ```sh
   node windows/patchers/desktop/patch.mjs
   ```

3. **You should see:** `"verified": true` in the output. Three things are created in `windows\output\`:

   | File | How to use it |
   | --- | --- |
   | `GrokBotLocal-0.71.2-x64-Setup.exe` | Installer (recommended). Installs into the current user's folder, no administrator rights needed |
   | `GrokBotLocal-0.71.2-x64-portable.zip` | Portable version as a zip. Extract it and run `Grok Bot.exe` |
   | `Grok Bot Local\` | The portable version, already extracted |

4. **Ask the user to double-click `Setup.exe` in File Explorer to install it**, then open "Grok Bot Local" from the Start menu or the desktop, and leave it on the screen where the Host address is entered.
   - If you ran the installer from a command, choose **No** when it asks "Open Grok Bot Local now?" at the end, then ask the user to open it from the Start menu. The reason: a client started from a terminal inherits the terminal's environment. When it is started from Git Bash, the commands the Bot runs on this computer use Git Bash instead, and arguments such as `cmd /c` get rewritten.

**If it fails:**

- **Downloading the original fails**: ask the user to download https://downloads.cursor.com/grokbot/stable/win32-x64/0.71.2/Grok_Bot_0.71.2_Setup.exe in a browser, then run `node windows/patchers/desktop/patch.mjs --source <path to downloaded file>`.
- **"输出已存在，不会覆盖" (output already exists, will not overwrite)**: rename or delete the old `windows\output`, then run it again.
- **It says `@electron/asar` is missing**: run `npm install --prefix mac/patchers/desktop` in the repository root, or download the full repository again.
- **SmartScreen blocks it when you open it**: click "More info → Run anyway".
- **"Smart App Control" blocks it**: see the checklist in step 0.

### 9.2 Mac (Apple Silicon)

Run this on the user's **Mac** (if you are running on this Mac, do it yourself; otherwise give it to the user):

1. `node --version` should show v22.12 or newer. If the version is older, ask the user to download and install the LTS version from https://nodejs.org.
2. Get the repository on the Mac: `git clone https://github.com/ferretgeek/prokbot-plus.git`, or download the ZIP and extract it. **Don't copy it over from a Windows PC.** The files would lose their executable permission.
3. Run this in the repository root:

   ```sh
   node mac/patchers/desktop/patch.mjs
   ```

   To let the Bot control the graphical interface of this Mac, use `node mac/patchers/desktop/patch.mjs --identity auto` instead (the Mac needs a code-signing certificate already), and on first use grant the "Accessibility" and "Screen Recording" permissions in System Settings.

4. **You should see:** `"verified": true` in the output, and `mac/output.noindex/Grok Bot.app` has been created. Running `open mac/output.noindex` opens this folder in Finder.
5. Ask the user to drag it to "Applications", open it, and leave it on the screen where the Host address is entered.
   - The built app has the same name as the official app. If the official Grok Bot is already installed, dragging it in asks whether to replace it. To keep the official app, rename it first.

**If it fails:**

- **Downloading the original fails**: use `--source <path to the official Grok Bot.app or .dmg>` to point to an original file you already have.
- **"输出已存在，不会覆盖" (output already exists, will not overwrite)**: rename or delete the old `mac/output.noindex`, then run it again.
- **It says `@electron/asar` is missing**: run `npm install --prefix mac/patchers/desktop` in the repository root.
- **It says the developer cannot be verified when opened**: click "Open Anyway" in "System Settings → Privacy & Security".

### 9.3 iPhone (iOS)

The user has to provide:

- A **decrypted** IPA of Grok Bot 1.16.0 (23152) arm64, with the main app and all three extensions decrypted;
- Python 3.10+;
- Signing tools and a certificate.

This repository does not provide any original or modified IPA.

```sh
python3 ios/release/patch-ios.py --input <decrypted.ipa> --output ./ios-output --bundle-id <your bundle ID>
```

For how to sign it, see [ios/docs/SIGNING.en.md](../ios/docs/SIGNING.en.md). The user confirms whether the install worked. When you hand over, report the actual progress honestly.

### 9.4 Pairing

Only after the user says the client on a device is open and waiting on the screen where the address is entered, run:

```sh
ssh <user>@<server IP> 'bash -s' <<'EOF'
<common preamble>
hostadmin pair
EOF
```

Ask the user to fill in, in the client:

- **Pairing code**: `pairingKey` from the output. It has 6 characters, made of uppercase letters and digits, for example `K7MPQ2`.
- **Host address**:
  - LAN or HTTPS: enter `hostUrl` from the output;
  - Tailcat: turn on the "Tailcat" switch and paste the connection link copied in step 8.

**Create a new pairing code for each device.** If a code isn't used within 5 minutes, run the command again.

**You should see:** the client goes to its main screen, and the device appears under `devices` in `hostadmin status`.

---

## Step 10: Check the result

Check each item. The deployment is done only when all of them pass. You run the first three. For the rest, ask the user to do them in the client, and you confirm the result:

| Check | How | Passes when |
| --- | --- | --- |
| Server is healthy | Run `curl -s $LOCAL_URL/healthz` after `<common preamble>` | `{"ok":true,"initialized":true}` |
| Model works | `hostadmin status` | `hostConnected: true`, `reload: applied` |
| Devices are paired | `devices` in `hostadmin status` | Lists every paired device |
| Chat works | The user sends "Hello" to the Bot | A reply comes back |
| Tool calls and cloud computer | The user sends "Run uname -a on your own Linux cloud computer and tell me the result" | The reply contains `Linux` |
| Web access (if configured) | The user sends "Search today's news and give the sources" | The answer has source links |
| Image generation (if configured) | The user sends "Draw a 16:9 landscape" | The image shows in the client |
| Access from outside your network (if Tailcat is configured) | The user connects the device to a phone hotspot and sends another message | A reply comes back |

If the "tool calls" item fails and the log shows `native_thinking_replay_mismatch`: this is a problem with some gateways when they forward Claude in the Responses format. Go back to step 6 and use the `anthropic` format for Claude.

---

## Step 11: Hand over to the user

Put the following together and send it to the user:

```text
Deployment complete.
- Admin page: <GROKBOT_PUBLIC_URL>
- Administrator password: <password> (also saved on the server in ~/grokbot/secrets/admin-password)
- Host address to enter in the clients: <GROKBOT_PUBLIC_URL> (with option C, this is your https domain); from outside your network with Tailcat, copy the connection link in the admin page under "Remote access"
- Paired devices: <list>
- Chat model: <format> / <model> / thinking effort <value>
- Web access / image generation: <configured or not configured>
- Deployment directory on the server: ~/grokbot (config in .env, passwords and keys in secrets/, data in the Docker volumes grokbot_host-data, grokbot_box-home, grokbot_box-workspace)
- Pairing a new device: create a pairing code in the admin page under "Devices & notifications"
- Maintenance commands: see appendix A (already filled in with the actual paths)
```

If in step 0 the user named a folder **on their computer**, write the content above, the content of `.env` and the commands from appendix A into a handoff document, and put it in that folder. Write passwords and keys only in this private document, and remind the user not to share it.

---

## Appendix A: Day-to-day operations

Run each block below with `ssh <user>@<server IP> 'bash -s' <<'EOF' ... EOF`, starting with `<common preamble>`.

```sh
$DC ps                      # Show status
$DC logs --tail 200 host    # Host logs
$DC restart host            # Restart the Host without losing data
$DC up -d                   # Start; also use this to apply changes to .env
```

**Backup**: pauses the containers for a few seconds to a few minutes.

```sh
cd ~/grokbot/src/host
python3 release/backup.py backup --project grokbot --directory ~/grokbot/backups/$(date +%F) --image grokbot-host:local < /dev/null
```

**Restore**: restores into a new project, `grokbot-restored`, and does not overwrite the existing data. The two projects use the same port, so stop the existing one first:

```sh
$DC stop
cd ~/grokbot/src/host
python3 release/backup.py restore --project grokbot-restored --directory ~/grokbot/backups/<date> --image grokbot-host:local < /dev/null
cd ~/grokbot && docker compose --env-file .env -p grokbot-restored -f src/host/release/compose.yaml up -d
```

Once you have confirmed that the restored data is correct, manage it with `-p grokbot-restored` from then on, and also change `DC` in the "common preamble" to this project name. To switch back to the original: first run `docker compose --env-file .env -p grokbot-restored -f src/host/release/compose.yaml stop`, then run `$DC up -d`.

**Update to a new version:**

1. **First find the existing deployment.** If it was not deployed with this guide (there is no `~/grokbot`), or the project name is not `grokbot`, first run:

   ```sh
   docker ps -a --filter ancestor=grokbot-host:local --format '{{.Label "com.docker.compose.project"}} | {{.Label "com.docker.compose.project.config_files"}}'
   ```

   The output shows the project name and the path of the compose file. The code directory is the repository root, two levels above the compose file. Then:
   - Replace `~/grokbot/src`, `-p grokbot` and `-f ...compose.yaml` in the commands below and in the "common preamble" with the actual values;
   - If `.env` was used when it was started, point `--env-file` at it as well.
2. Back up first (see above).
3. Get the new code. **If the code update fails, stop.** Don't go on to the build:

   ```sh
   cd ~/grokbot/src && git pull --ff-only && git log -1 --format='Updated to %h %ad' --date=short
   ```

   If "Updated to …" is not printed, the update failed. If it's a network problem, upload the code again as in option 2 of step 2.
4. Rebuild in the background:

   ```sh
   cd ~/grokbot/src && nohup python3 host/release/build-docker.py > ~/grokbot/logs/build.log 2>&1 < /dev/null &
   ```

5. Check the build the same way as in step 3. When it has finished, run `$DC up -d`.

**Remove the temporary build image** (frees about 0.8 GB): `docker image rm grokbot-patch-base:local`. Do not remove `node:22-bookworm-slim`. `hostadmin` needs it.

---

## Appendix B: Troubleshooting

| Symptom | Fix |
| --- | --- |
| The admin page doesn't open on the LAN (options A and B) | Set `GROKBOT_LISTEN_ADDRESS` in `.env` to `0.0.0.0` and run `$DC up -d`. On a cloud server, also open the port in the security group |
| The admin page doesn't open through the domain (option C) | Check the reverse proxy; see step 4.1. Don't change the listen address, and don't open 18080 |
| Ports published by Docker bypass the ufw firewall | This is the default behavior of Docker. To allow access only from the LAN, set `GROKBOT_LISTEN_ADDRESS` to the server's LAN IP, **and also change `LOCAL_URL` in the "common preamble" to this IP** |
| host never becomes healthy | `$DC logs --tail 200 host`; check disk space; `$DC restart host` |
| host shows unhealthy for a short time after a backup | The health check timed out while the containers were paused. It recovers on its own within a minute |
| The client says "Host returned a different server address." | The address entered in the client doesn't match `GROKBOT_PUBLIC_URL`. Make them exactly the same |
| Invalid pairing code | More than 5 minutes have passed, or the code has already been used. Run `hostadmin pair` again |
| The admin API or `hostadmin` reports `HTTP 429` | Login, setup and model tests are each limited to 5 per minute. Wait one minute. Behind a reverse proxy, all visitors share this counter |
| The script stops printing halfway, and the later commands never run | A command read the rest of the script as its input. Add `< /dev/null` to commands such as `docker compose exec` and `apt-get` |
| Forgot the administrator password | Clear the administrator and set it up again. Paired devices are not affected. Run, in order: `$DC stop host`; `docker run --rm -v grokbot_host-data:/data node:22-bookworm-slim node -e "const f='/data/auth.json',fs=require('fs'),j=JSON.parse(fs.readFileSync(f));j.admin=null;j.sessions=[];fs.writeFileSync(f,JSON.stringify(j))"`; `$DC start host`. Then do step 5 again |
| Chat doesn't respond | Check `hostConnected` in `hostadmin status`; test the model again with `hostadmin model-set ... --test-only` |
| The log shows `[model] … retrying without …` | The provider doesn't support an optional parameter. The Host has already removed it and retried. No action needed |
| The log shows `Local auto-review failed` | The model request for the automatic safety review failed, so this Bot action is rejected. Check that the model service is stable |
| The Bot can't operate the cloud computer | Check with `$DC ps` that box is running; `$DC restart box` |
| "Remote access" in the admin page never shows "Ready" | Look for Tailcat errors with `$DC logs --tail 100 host`. The server needs internet access |
| Extracting the original fails on Windows 10 | Install 7-Zip, or set the environment variable `GROKBOT_7Z` to the path of `7z.exe` |
| Commands the Bot runs on Windows hang or get wrong arguments | The client was started from Git Bash. Right-click the tray icon to quit, then open it again from the Start menu |

## Appendix C: Admin API (for writing your own scripts)

- First call `POST /admin/api/login` with the request body `{"password":"..."}` to get a cookie. After that, every non-GET request must include the header `x-grokbot-csrf: 1`.
- The `Origin` header is optional. If you send it, it must match `GROKBOT_PUBLIC_URL`.
- Login, setup and model tests are limited to 5 per minute for each IP.
- Common endpoints:

  | Endpoint | Purpose |
  | --- | --- |
  | `GET /admin/api/status` | Show status |
  | `GET` / `PUT /admin/api/model` | Read or write the chat model config |
  | `POST /admin/api/model/test` | Test a model config |
  | `POST /admin/api/pairing-keys` | Create a pairing code |
  | `GET` / `PUT /admin/api/web-services` | Read or write the web tools config |
  | `POST /admin/api/web-services/test` | Test the web tools |
  | `GET` / `PUT /admin/api/media` | Read or write the images and video config |

- The implementation is in `host/server/index.mjs` and `host/server/media-api.mjs`.
