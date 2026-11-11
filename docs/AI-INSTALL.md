# AI 部署手册

[English](AI-INSTALL.en.md)

这份手册写给帮用户部署 ProkBot Plus 的 AI，人也可以照着做。从上往下一步一步执行，**不要跳步**。

**用户要的是更新已有的部署，而不是新装的话**，不用做第 0 步的清单，直接看[附录 A「更新到新版本」](#附录-a日常运维)。

## 先读这一节

**阅读规则**

- `<尖括号>` 是占位符，执行前换成真实值。
- 每一步都写了「应该看到」。没看到就先查本步的「如果失败」，再查文末的[故障排查](#附录-b故障排查)。问题没解决之前，不要继续往下做。
- 用户的密码和 API Key：
  - 在服务器上只保存在私有文件夹 `~/grokbot/secrets/`（第 4 步创建，只有部署用户能读）；Host 自己也会在数据卷里保存一份。
  - 不要写进会被分享的文档，不要提交到任何仓库，也不要放进命令行参数（服务器上的其他用户能通过 `ps` 看到命令行参数）。
  - 它们出现在你和用户的对话里无法避免，但不要再复制到别处。
- **任何情况下都不要删除 Docker 数据卷**，也就是名字以 `grokbot_` 开头的卷。

**谁来做**

| 工作 | 谁做 |
| --- | --- |
| 在服务器上执行命令 | 你（AI） |
| 生成 Windows、Mac 或 Android 客户端 | 你运行在那台电脑上，就由你做；否则把命令交给用户执行 |
| 输入 SSH 密码、sudo 密码 | 用户。你没法在密码提示里输入 |
| 双击安装客户端、在客户端里填写地址和配对码、在管理页里点选、发消息验收 | 用户。这些是图形界面操作，你在旁边一项一项告诉他怎么做 |

**怎么在服务器上执行命令（重要）**

你通常是通过 SSH 执行命令。**每次 SSH 调用都是一个新会话**：上一次定义的变量和函数，下一次都不存在了。

所以，服务器上的每一段操作都写成一个完整的脚本，通过标准输入整段发过去：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
# 这一步的命令
EOF
```

- `'bash -s'` 和 `<<'EOF'` **都要带单引号**。这样 `$变量`、`$(命令)` 会在服务器上展开，而不是在你的电脑上展开。
- 在 Windows 上，用 Git Bash 执行。**不要用 Windows PowerShell**：它不支持这种写法，还会弄坏管道里的数据。电脑上没有 Git Bash 的话，先请用户安装 Git for Windows（https://git-scm.com/download/win ，一路默认选项即可）。
- 你本身就运行在这台服务器上的话，把脚本内容直接交给 bash 执行即可，不需要 ssh。
- **脚本里凡是可能读取输入的命令**（`docker compose exec`、`apt-get`、备份恢复脚本等），末尾都要加 `< /dev/null`。否则它会把脚本后面的内容当成输入读走，后面的命令就不会执行，而且不报任何错。本手册的命令已经加好了。

**公共开头**

第 5 步以后，凡是用到 `$DC`、`hostadmin`、`$LOCAL_URL`、`$MODEL_API_KEY` 的服务器脚本，开头都先写这几行。下文写 `<公共开头>` 的地方，就是原样放这几行：

```sh
cd ~/grokbot
PORT=18080                                      # 第 1 步换了端口的话，改这里
LOCAL_URL=http://127.0.0.1:$PORT                # 按附录 B 把监听地址改成具体 IP 的话，把 127.0.0.1 也换成那个 IP
DC="docker compose --env-file .env -p grokbot -f src/host/release/compose.yaml"
hostadmin() { docker run --rm --network host -v ~/grokbot/src/host:/src:ro -e GROKBOT_URL -e GROKBOT_ADMIN_PASSWORD -e GROKBOT_SETUP_KEY -e MODEL_API_KEY node:22-bookworm-slim node /src/tools/host-admin.mjs "$@"; }
export GROKBOT_URL=$LOCAL_URL
[ -f secrets/admin-password ] && export GROKBOT_ADMIN_PASSWORD="$(cat secrets/admin-password)"
[ -f secrets/model-api-key ] && export MODEL_API_KEY="$(cat secrets/model-api-key)"
```

`hostadmin` 是仓库自带的命令行管理工具，在 Docker 容器里运行，服务器上不需要装 Node.js。第一次运行时，如果服务器上还没有 `node:22-bookworm-slim` 镜像，会自动下载。

**整体流程**

```text
第 0 步 告诉用户要准备什么 → 第 1 步 检查服务器 → 第 2 步 放代码 → 第 3 步 构建镜像
→ 第 4 步 写配置并启动 → 第 5 步 初始化管理员 → 第 6 步 配置模型 → 第 7 步 联网和生图（可选）
→ 第 8 步 外网访问（可选）→ 第 9 步 生成客户端并配对 → 第 10 步 验收 → 第 11 步 交付
```

第 3 步的构建要几十分钟，这段时间可以同时做第 9 步里的「生成客户端」（只生成，先不配对）。

---

## 第 0 步：先把准备清单发给用户

开始任何操作前，先把下面这段话发给用户（可以改写措辞，但内容不能少）。等用户回复后再做第 1 步。

```text
部署 ProkBot Plus 需要你准备下面这些东西。必需项缺一不可，可选项可以以后再加。

【必需】
1. 一台服务器：x86_64 架构的 Linux（推荐 Ubuntu 22.04/24.04 或 Debian 12；支持 Docker 的 NAS 也可以）。
   - 内存 8 GB 左右或更多，空闲磁盘 30 GB 以上，能访问外网（首次构建要下载约 8 GB）。
   - 告诉我：IP 地址、SSH 用户名。
   - 我需要能用 SSH 密钥免密码登录。目前只能用密码登录的话，告诉我，我教你配置密钥（几分钟就好）。
   - 这个用户执行 sudo 时要不要输密码？要的话，安装软件那一步需要你自己执行我给的命令。
   - 如果我现在就运行在这台 Linux 上，直接告诉我"就用这台"。
2. 一个大模型接口：
   - 接口格式：Anthropic Messages / OpenAI Responses / OpenAI Chat Completions 三选一。不清楚的话，把服务商名字告诉我，我来判断和测试。
   - 接口地址（Base URL）、API Key、想用的模型（例如 Claude Sonnet、GPT-5.5、DeepSeek V4。确切的模型名我可以帮你查）。
   - 模型必须支持工具调用（function calling）；想让 Bot 操作电脑，还要支持图片输入。
3. 你要在哪些设备上用：
   - Windows 10/11（64 位）电脑：
     - 是不是我现在运行的这台？
     - 有没有装 Node.js 22.12 或更新版本，以及 Git for Windows（自带 Git Bash）？
     - 「Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」是不是开着？
   - Apple Silicon 芯片的 Mac：
     - 是不是我运行的这台？
     - 有没有装 Node.js 22.12+ 和 git？
     - 有没有装官方的 Grok Bot？
   - iPhone：难度较高，需要你自己准备 Grok Bot 1.16.0 的砸壳 IPA 和签名证书。
   - Android 手机（Android 9 及以上）：
     - 要在一台电脑上生成安装包（Windows、Mac、Linux 都可以，需要 Node.js 22.12+），这台电脑是不是我现在运行的这台？
     - 手机能不能连到这台电脑（USB 数据线，或者把 APK 文件传到手机上）？
     - Android 版不支持 Tailcat，出门在外要用的话需要 VPN、内网穿透或 HTTPS 域名。

【需要你选择】
4. 在哪里用：
   A. 只在家里或公司的局域网里用（默认，最简单）；
   B. 出门在外也要用：用内置的 Tailcat，不需要公网 IP 和域名；
   C. 你已经有域名和 HTTPS 反向代理：告诉我域名，反向代理用的是 Caddy 还是 Nginx，它是直接装在系统里还是运行在 Docker 里。
5. 管理员密码：12 到 128 个字符。不提供的话我随机生成一个告诉你。

【可选】
6. 联网搜索、读网页、生成图片：你的模型接口如果支持，告诉我；不确定也没关系，我可以测试。
7. 时区（默认 Asia/Shanghai）。
8. 部署说明文档（含密码）保存在你电脑上的哪个文件夹。
```

收到回复后，逐条核对：

| 情况 | 怎么办 |
| --- | --- |
| 必需项没给全，例如缺 API Key | 再问一次，只问缺的那几项。不要猜 |
| 只说了模型的大概名字，例如「Claude Sonnet」 | 先继续。第 6 步列出模型后，请用户确认确切的模型名 |
| SSH 只能用密码登录 | 按下面「配置 SSH 密钥」做 |
| sudo 需要密码 | 第 1 步安装软件、第 4.1 步修改反向代理配置时，把命令整段发给用户，让他自己登录服务器执行。其余步骤都不需要 sudo |
| 只有 Windows 电脑，没有 Linux 服务器 | 服务端不能直接部署在 Windows 上，请用户准备一台 Linux 机器或云服务器。也可以试 WSL2 + Docker，但没有经过充分测试，要先说明 |
| 服务器是 ARM 架构 | 镜像只有 amd64 版本，用不了，换 x86_64 机器 |
| Windows 开着「智能应用控制」 | 生成的客户端没有代码签名，会被直接拦截。可以在 Windows 安全中心关掉它（**关掉后就不能再打开，除非重装系统**，先告诉用户），或者换一台电脑用 |
| 不知道接口格式 | 看第 6 步的「怎么选接口格式」 |
| 要用 Android 手机，又选了 B（Tailcat） | Android 版不支持 Tailcat。问用户能不能改用 VPN、内网穿透或 HTTPS 域名（C 方案）；不能的话，Android 手机只能在局域网里用 |

**配置 SSH 密钥**（用户只能用密码登录时）：

1. 你运行在用户的电脑上的话，由你生成一把**没有口令**的专用密钥；否则把这条命令交给用户：

   ```sh
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/grokbot_ed25519
   ```

2. 在 `~/.ssh/config` 末尾加上下面几行（文件不存在就新建）。之后 `ssh <服务器IP>` 就会自动用这把密钥和这个用户名：

   ```text
   Host <服务器IP>
     User <用户>
     IdentityFile ~/.ssh/grokbot_ed25519
   ```

3. 请用户**另开一个终端窗口**（Windows 用 Git Bash），执行下面这条命令。第一次连接会问主机指纹，输入 `yes`，再输入一次 SSH 密码：

   ```sh
   ssh-copy-id -i ~/.ssh/grokbot_ed25519.pub <用户>@<服务器IP>
   ```

4. 你来验证。不报错、没有询问任何东西，就说明成功：

   ```sh
   ssh -o BatchMode=yes <用户>@<服务器IP> true
   ```

   报 `Host key verification failed` 的话，请用户在自己的终端里执行一次 `ssh <用户>@<服务器IP> true`，输入 `yes` 接受主机指纹。

---

## 第 1 步：检查服务器

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
uname -m
free -h
for c in docker python3 git curl openssl; do command -v $c >/dev/null && echo "有 $c" || echo "缺 $c"; done
docker info --format 'Docker {{.ServerVersion}}，数据目录 {{.DockerRootDir}}' 2>&1 | tail -1
docker compose version
python3 --version
df -h "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib)" ~ /tmp
ls -d ~/grokbot 2>/dev/null && echo "已有 ~/grokbot"
docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '_host-data$' && echo "已有 ProkBot 数据卷"
docker ps -a --filter ancestor=grokbot-host:local --format '{{.Names}}' 2>/dev/null | grep . && echo "已有 ProkBot 容器"
ss -ltn | grep -w 18080 || echo "18080 未被占用"
EOF
```

**应该看到：**

- `uname -m` 输出 `x86_64`；
- 内存 7.5 GiB 以上（标称 8 GB 的机器通常显示 7.5–7.8 GiB）；
- 五个工具都显示「有」；
- `Docker 29.x.x，数据目录 /var/lib/docker` 这样的一行。有版本号就说明 Docker 正常。实测用的是 Docker 29；发行版自带的版本低一些也可以，构建时出现旧版构建器（legacy builder）的提示可以忽略；
- `docker compose version` 有版本号（Compose v2）；Python 是 3.10 或更新版本；
- Docker 数据目录所在的磁盘空闲 ≥ 30 GB，`/tmp` 空闲 ≥ 5 GB；
- **没有**「已有 ~/grokbot」「已有 ProkBot 数据卷」「已有 ProkBot 容器」，最后一行是「18080 未被占用」。

**如果失败：**

- **Docker 已经装了，但那一行报错**：**不要重新安装 Docker**，否则可能把服务器上原有的 Docker 换掉。按报错处理：
  - 含 `permission denied`：当前用户没有 docker 权限。执行 `sudo usermod -aG docker "$USER"`，下一次 SSH 连接生效；
  - 含 `Cannot connect to the Docker daemon`：Docker 没在运行。执行 `sudo systemctl enable --now docker`。
- **缺软件（显示「缺 docker」等）**：sudo 免密的话，你直接执行；需要密码的话，把对应的命令发给用户，让他登录服务器后执行：

  - Ubuntu：

    ```sh
    sudo apt-get update < /dev/null
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 python3 git curl openssl < /dev/null
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER"
    ```

  - Debian 和其他发行版（用 Docker 官方安装脚本）：

    ```sh
    sudo apt-get update < /dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3 git curl openssl < /dev/null    # 非 Debian 系换成对应的包管理器
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    ```

  装好后，**下一次 SSH 连接**才会获得 docker 权限，然后重新执行本步的检查。不要靠在命令前加 `sudo` 来绕过：构建和备份脚本内部也会调用 docker，加了 sudo 会出问题。
- **出现「已有 ~/grokbot」「已有 ProkBot 数据卷」或「已有 ProkBot 容器」**：这台机器已经部署过，**不要重新部署，也不要换个端口再装一套**。问用户是要更新（见附录 A「更新到新版本」），还是只想修改配置。
- **18080 被别的程序占用**：选一个空闲端口（例如 18081）。「公共开头」里的 `PORT=`，以及第 4 步脚本里的三处 18080，都要改成它。
- **内存明显不足 8 GB 或磁盘不够**：告诉用户，换机器或扩容。

---

## 第 2 步：把代码放到服务器

约定：部署目录是 `~/grokbot`，仓库放在 `~/grokbot/src`（`src` 里面直接就是仓库根目录，有 `host/`、`windows/` 等文件夹）。

**方法一：服务器能访问 GitHub（推荐）**

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
mkdir -p ~/grokbot/logs ~/grokbot/backups
git clone --depth 1 https://github.com/ferretgeek/prokbot-plus.git ~/grokbot/src
EOF
```

只用这个地址，不要从别的仓库或镜像站获取代码。

**方法二：服务器访问不了 GitHub**

1. 在用户电脑上获取仓库：`git clone`，或下载 ZIP 后解压。
2. 在仓库根目录打开 **Git Bash**（Mac 用「终端」）。不要用 Windows PowerShell 5.1。
3. 执行下面三条命令。第三条是必须的：从 Windows 上传的文件会丢掉「可执行」权限，要补回来。

```sh
ssh <用户>@<服务器IP> "mkdir -p ~/grokbot/src ~/grokbot/logs ~/grokbot/backups"
tar -cf - --exclude=./.git --exclude=./windows/output --exclude=./windows/.cache --exclude=./mac/output.noindex . | ssh <用户>@<服务器IP> "tar -C ~/grokbot/src -xf -"
ssh <用户>@<服务器IP> "cd ~/grokbot/src && chmod +x host/bin/grokbot-tailcat mac/dist/network/grokbot-tailcat"
```

**应该看到：** 执行 `ssh <用户>@<服务器IP> "ls ~/grokbot/src/host/release/build-docker.py"`，能列出这个文件。

**如果失败：**

- **方法一 `git clone` 超时**：改用方法二。
- **换行符问题**：不要用会改换行符的方式传文件，例如某些 FTP 工具的「文本模式」。仓库里的脚本必须保持 LF 换行。

---

## 第 3 步：构建镜像

构建要下载原版 Host 和约 7.7 GB 的官方 Linux 桌面镜像。首次构建需要 10 到 40 分钟，以后再构建约 6 分钟。用 `nohup` 放到后台，SSH 断开也不影响：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
cd ~/grokbot/src
nohup python3 host/release/build-docker.py > ~/grokbot/logs/build.log 2>&1 < /dev/null &
echo "已在后台开始构建"
EOF
```

每隔 3–5 分钟检查一次：

```sh
ssh <用户>@<服务器IP> 'tail -n 5 ~/grokbot/logs/build.log; pgrep -f "[b]uild-docker.py" >/dev/null && echo "仍在构建" || echo "构建进程已结束"'
```

**应该看到：** 「构建进程已结束」，并且日志最后一行是一段 JSON，包含 `"image": "grokbot-host:local"`。

**如果失败：**

- **「构建进程已结束」但没有那段 JSON**：看日志里的报错。
- **下载失败**：构建要能访问下面这些地方：
  - Docker Hub（`node` 镜像）；
  - Debian 软件源和 npm 源；
  - `public.ecr.aws`（桌面镜像）；
  - AWS S3（原版 Host）。

  服务器需要通过代理上网时，三处都要配置，然后重新执行本步（构建可以重复执行）：
  1. **Docker 拉取镜像**：给 Docker 服务配置代理（systemd 的 `HTTP_PROXY` / `HTTPS_PROXY`），然后重启 Docker；
  2. **构建过程中的 apt 和 npm**：在 `~/.docker/config.json` 的 `proxies` 里配置代理，Docker 会把它传进构建容器；
  3. **下载原版 Host**：启动构建时带上环境变量，例如 `https_proxy=http://<代理地址> nohup python3 host/release/build-docker.py ...`。

  具体写法以 Docker 官方文档为准。
- **报 `Unsupported Box image identity` 或 `Unsupported Host archive SHA-256`**：下载到的原版文件和固定版本不一致，常见原因是 Docker 镜像加速器返回了别的镜像。临时关掉加速器后重试，并确认代码是第 2 步那个仓库的。
- **磁盘空间不足**：清理后重新执行本步。

---

## 第 4 步：写配置并启动

先按第 0 步用户选的访问方式，确定 `.env` 里的两个值，**两个值都要按表填**：

| 用户选择 | `<监听地址>` | `<对外地址>` |
| --- | --- | --- |
| A 局域网 | `0.0.0.0` | `http://<服务器局域网IP>:18080` |
| B Tailcat | `0.0.0.0` | `http://<服务器局域网IP>:18080`，Tailcat 在第 8 步开启 |
| C 已有 HTTPS 反向代理 | `127.0.0.1` | `https://<域名>`，不带端口，也不带路径（只能用整个域名，不能放在 `https://<域名>/某个路径` 下） |

客户端填写的 Host 地址必须和 `<对外地址>`（也就是 `GROKBOT_PUBLIC_URL`）**完全一样**，包括 `http`/`https`、IP 或域名、端口。用 Tailcat 时填的是 Tailcat 链接，见第 8 步。

然后写配置、建私有文件夹、启动。端口不是 18080 的话，`GROKBOT_PUBLIC_PORT`、最后一行 `curl`，以及 A、B 方案 `<对外地址>` 里的端口都要改：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
cd ~/grokbot
cat > .env <<'ENV'
GROKBOT_LISTEN_ADDRESS=<监听地址>
GROKBOT_PUBLIC_PORT=18080
GROKBOT_PUBLIC_URL=<对外地址>
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

**应该看到：** `grokbot-host-1` 显示 `healthy`，`grokbot-box-1` 显示 `Up`；最后一行是 `{"ok":true,"initialized":false}`。

A、B 方案：在用户的电脑上（不是服务器上）执行 `curl -s <对外地址>/healthz`，确认局域网里能连通。C 方案先做第 4.1 步，再从用户电脑上检查。

**如果失败：**

- **还没变成 `healthy`**：再等 1 分钟，用 `<公共开头>` 加 `$DC ps` 再看。
- **一直起不来**：用 `$DC logs --tail 100 host` 看报错。
- **A、B 方案：服务器上正常、用户电脑访问不了**：
  - 检查 `GROKBOT_LISTEN_ADDRESS` 是不是 `0.0.0.0`；
  - 云服务器还要在安全组里放行这个端口。
- **C 方案**：不要把监听地址改成 `0.0.0.0`，也不要在安全组开放 18080。问题在反向代理，见第 4.1 步。

### 4.1 配置 HTTPS 反向代理（只有 C 方案要做）

要求：

- 反向代理把整个域名（根路径 `/`）转发到 `http://127.0.0.1:18080`；
- 要支持 WebSocket 和流式输出（Caddy 默认就支持，Nginx 要按下面的写法配置）。

**先确认这个域名没有在给别的网站用。** 配置文件里已经有这个域名，而且指向别的程序的话，**停下来**，请用户换一个专用的子域名（例如 `bot.<域名>`）。不要覆盖原来的网站。

**修改前先备份原来的配置文件**，只加或只改这个域名对应的那一段，不要动别的网站。改配置需要 sudo。

Caddy（配置文件通常是 `/etc/caddy/Caddyfile`）：

```text
<域名> {
    reverse_proxy 127.0.0.1:18080
}
```

检查并生效：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

Nginx（在这个域名的 `server { ... }` 里，证书相关的行保持原样）：

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

检查并生效：

```sh
sudo nginx -t && sudo systemctl reload nginx
```

注意：

- **反向代理运行在 Docker 里时**：
  - 配置文件是容器挂载进去的那个文件，用 `docker inspect <容器名>` 查看 `Mounts`，找到它在服务器上的位置；
  - 生效命令改为 `docker exec <容器名> caddy reload --config /etc/caddy/Caddyfile`（Nginx 是 `docker exec <容器名> nginx -s reload`）；
  - `127.0.0.1` 指的是它自己的容器，连不到 ProkBot。这时要：
    - 把上面的 `127.0.0.1` 换成服务器的局域网 IP；
    - 把 `.env` 的 `GROKBOT_LISTEN_ADDRESS` 也改成这个 IP，执行 `$DC up -d`；
    - 把「公共开头」的 `LOCAL_URL` 也改成这个 IP。
- **云服务器的安全组只需要放行 443**（申请证书需要的话再放行 80）。**不要放行 18080**。
- 经过反向代理后，管理页的登录限流对所有访问者共用一个计数。公网上有人乱试密码时，你自己登录也可能遇到 `HTTP 429`，等 1 分钟即可。所以管理员密码一定要足够长。

**应该看到：** 在用户的电脑上执行 `curl -s https://<域名>/healthz`，返回 `{"ok":true,"initialized":false}`。

**如果失败：**

- 返回 502：反向代理连不到 `127.0.0.1:18080`。检查 Host 是否在运行，以及反向代理是不是运行在 Docker 里（见上面的注意事项）。
- 证书错误或连接超时：检查域名解析、安全组的 443 端口、反向代理的日志。

---

## 第 5 步：初始化管理员

先把管理员密码写进私有文件。**两种情况二选一，只执行其中一段。**

用户给了密码：把 `<管理员密码>` 整个换成真实密码（12–128 个字符，前后不要加空格）：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
cd ~/grokbot && umask 077
cat > secrets/admin-password <<'PW'
<管理员密码>
PW
EOF
```

用户没给密码：随机生成，并把输出的密码记下来，交付时告诉用户：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
cd ~/grokbot && umask 077
openssl rand -base64 18 > secrets/admin-password && cat secrets/admin-password
EOF
```

然后初始化：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
<公共开头>
export GROKBOT_SETUP_KEY="$($DC exec -T host cat /data/setup-key < /dev/null)"
hostadmin setup
EOF
```

**应该看到：** 输出 `管理员已设置`。

**如果失败：**

- **`GROKBOT_ADMIN_PASSWORD 需要 12–128 位`**：
  - 先执行 `ssh <用户>@<服务器IP> "wc -c ~/grokbot/secrets/admin-password"`，看密码文件是否存在、长度对不对；
  - 文件不存在就回到上面写密码；
  - 内容还是 `<管理员密码>` 这几个字的话，说明忘了替换。
- **`HTTP 429`**：初始化和登录太频繁，每个 IP 每分钟最多 5 次，等 1 分钟。
- **`cat: /data/setup-key: No such file`**：已经初始化过了，跳过这一步，把原来的管理员密码写进 `secrets/admin-password`。原来的密码找不到的话，见附录 B「忘记管理员密码」。

---

## 第 6 步：配置对话模型

### 怎么选接口格式

| 服务商 | `--format` | `--base-url` 填什么 |
| --- | --- | --- |
| Anthropic 官方 | `anthropic` | **根地址** `https://api.anthropic.com` |
| OpenAI 官方 | `openai-responses` | `https://api.openai.com/v1` |
| DeepSeek 等大多数「OpenAI 兼容」服务 | `openai` | 服务商文档里 `/chat/completions` 前面的部分，例如 `https://api.deepseek.com/v1` |
| 聚合网关，要用 Claude | 先试 `anthropic`；不行再用 `openai` | `anthropic` 填根地址，`openai` 填 `/v1` 地址 |
| 聚合网关，要用其他模型；或实在不确定 | `openai` | `/v1` 地址 |

地址规则：

- 两种 OpenAI 格式：填到 `/chat/completions` 或 `/responses` **之前**的部分，大多数以 `/v1` 结尾。
- Anthropic 格式：填根地址，也就是去掉 `/v1` 的部分，例如 `https://gw.example.com`。

**判断聚合网关能不能用 `anthropic`**：先写好 Key（见下面第一段），然后用 `--test-only` 试一次。成功就用 `anthropic`；「模型服务返回」401、404 或 405，就改用 `openai` 格式和 `/v1` 地址。返回 401 往往说明这个网关的 Anthropic 接口不认这种 Key 的传法，不一定是 Key 写错了。

### 执行

先把 API Key 写进私有文件：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
cd ~/grokbot && umask 077
cat > secrets/model-api-key <<'KEY'
<API Key>
KEY
EOF
```

列出模型：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
<公共开头>
hostadmin model-catalog --format <格式> --base-url <地址>
EOF
```

**应该看到：** 每行一个模型，格式是 `模型名  支持的思考强度  上下文长度`。

- 用户只说了大概的名字（例如「Claude Sonnet」）的话，从列表里挑出候选，请用户确认确切的模型名。
- 有些服务商的列表只返回一部分，**列表里没有不代表不能用**。用户确定模型名的话，直接做下面的测试。

**思考强度怎么选：**

- 用户指定了就用用户的。
- 没指定的话，看这个模型在列表里的思考强度：有 `high` 就用 `high`；为空或者没有 `high`，就用 `default`。

测试并保存：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
<公共开头>
hostadmin model-set --format <格式> --base-url <地址> --model <模型名> --effort <思考强度>
hostadmin status
EOF
```

`model-set` 会先发一次真实请求测试，成功后才保存，再等待 Host 应用。只想测试、不保存的话，加 `--test-only`。

**应该看到：** 测试结果里有 `"ok": true`，接着输出 `已应用`；`status` 中 `hostConnected` 为 `true`，`reload` 为 `applied`。

这个测试只发一句简单的话，不带工具。模型能不能正确调用工具，要到第 10 步验收时才能确认。

**如果失败：** 报错一般长这样：`错误：POST /admin/api/model/test → HTTP 502 模型服务返回 HTTP 401：...`。外层的 502 是 Host 自己返回的，**要看「模型服务返回」后面那个状态码**：

| 模型服务返回 | 处理 |
| --- | --- |
| 401 / 403 | Key 错误或没有权限。用的是聚合网关的 `anthropic` 格式时，改用 `openai` 格式试试 |
| 404 / 405 | 地址写错。对照上面的地址规则；不要把 `/chat/completions`、`/responses` 重复写两次 |
| 400，提到思考强度或 effort | 换成列表里的值，或用 `--effort default` |
| `支持的思考强度为 [无]` | 模型名带了前缀之类，Host 认不出它支持哪些强度。用 `--effort default`，或者加 `--efforts low,medium,high` 手动写明 |
| 外层就是 `HTTP 429` | 模型测试每分钟最多 5 次，等 1 分钟 |
| 400 / 403，提到需要验证组织（organization verification） | OpenAI 的部分模型要求先在 OpenAI 平台完成组织验证。请用户完成验证，或换一个模型 |

---

## 第 7 步：联网和生成图片（可选）

Bot 的「搜索网页」「读取网页」「生成图片」三个工具，要在 Host 上配置服务商后才会出现。用户不需要的话，跳到第 8 步。

这里有两种地址，别混淆：

- **根地址**：例如 `https://api.anthropic.com`；
- **`/v1` 地址**：根地址后面加 `/v1`，例如 `https://api.anthropic.com/v1`。

**联网工具和图片供应商一律填 `/v1` 地址**，Anthropic 也一样。这和第 6 步对话模型的 Anthropic 根地址不同。

联网用的模型和对话模型没有关系，可以不一样。一般选同一个服务商里便宜一些、支持联网的模型。

**先测试接口支持什么，不要猜**（Key 通过管道传给 curl，不会出现在命令行参数里）：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
<公共开头>
# 三段测试按接口情况选着跑，不适用的整段删掉
# 1. Claude 原生联网（只适用于 Anthropic 格式的接口）：输出「支持联网」才算支持
printf 'x-api-key: %s\n' "$MODEL_API_KEY" | curl -s <根地址>/v1/messages -H @- -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"<Claude模型>","max_tokens":2000,"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":1}],"messages":[{"role":"user","content":"Use the web_search tool: today news"}]}' \
  | grep -q web_search_tool_result && echo "支持联网" || echo "不支持或请求失败"
# 2. GPT 原生联网（只适用于 OpenAI Responses 接口）：输出「支持联网」才算支持
printf 'Authorization: Bearer %s\n' "$MODEL_API_KEY" | curl -s <OpenAI格式的/v1地址>/responses -H @- -H "content-type: application/json" \
  -d '{"model":"<GPT模型>","tools":[{"type":"web_search"}],"tool_choice":"required","input":"Search the web: today news"}' \
  | grep -q web_search_call && echo "支持联网" || echo "不支持或请求失败"
# 3. 图片模型（只适用于 OpenAI 兼容接口）：列出名字里带 image 的模型
printf 'Authorization: Bearer %s\n' "$MODEL_API_KEY" | curl -s <OpenAI格式的/v1地址>/models -H @- | grep -oE '"id": *"[^"]*image[^"]*"' | head
EOF
```

然后在**管理页**里配置。用浏览器打开 `GROKBOT_PUBLIC_URL`，用管理员密码登录。这部分请用户操作，你一项一项告诉他怎么填。**每次都先选「接口类型」，再填地址**，因为切换接口类型时，地址会被自动改成官方默认值：

1. **联网工具 → 供应商 → 添加：**
   - 名称：随便起，例如 `claude-web`；
   - 接口类型：「模型原生 · Anthropic」（Claude，能搜索也能抓取网页）；接口不支持时改选「模型原生 · Responses」（GPT，只能搜索）；
   - 接口地址：`/v1` 地址；API Key；模型 ID：用来联网的模型名。

   保存后，在「使用方式」里把「默认」那一行的「搜索」和「抓取」都选成它（「模型原生 · Responses」只选「搜索」，「抓取」留「停用」），点「保存」。

   然后在页面下方的「测试」里验证：「工具」选「搜索」，「关键词或网址」填「今天的新闻」；选的是「模型原生 · Anthropic」的话，再选「抓取」，填 `https://example.com/` 测一次。
2. **图片与视频 → 供应商 → 添加：**
   - 名称随便起；接口类型选「OpenAI Images」；填 `/v1` 地址和 Key。
3. **图片与视频 → 模型 → 添加：**
   - 供应商选刚才那个；模型 ID 填上面列出的图片模型名，选 `gpt-image` 开头的（例如 `gpt-image-2`）。`dall-e` 系列支持的尺寸不一样，不要选；
   - 名称随便起；功能选「图片生成」；保存。

   最后在「默认模型」的「图片生成」里选中它，点「保存」。

不需要别的设置：Bot 要求的画面比例会自动换算成标准尺寸，也能带参考图修改。想要更精确的比例或更多参数的话，可以写参数定义，这是进阶用法，见 [技术文档 · 联网与生成图片](ARCHITECTURE.md#联网与生成图片)。

**应该看到：**

- 测试「搜索」显示「找到 N 个来源」；测试「抓取」（如果测了）显示「已读取 N 个字符」。
- 第 10 步验收时，Bot 能搜索、能出图。

**如果失败：**

- 测试报 `Service returned HTTP 401`：Key 不对，或者这个服务的 Anthropic 接口不认这种 Key 的传法（第 6 步就是因为 401 改用 `openai` 格式的话，多半是后者）；`404`：地址不是 `/v1` 地址。
- **上面三段测试里，两种联网都不支持**：告诉用户这个接口不支持 Bot 联网，跳过联网的配置，继续做后面的步骤。生图可以照常配置。
- 生图失败：执行 `<公共开头>` 后运行 `$DC logs --tail 200 host`，查看相关报错。OpenAI 的 `gpt-image` 系列可能要求先完成组织验证。
- 只配了「模型原生 · Responses」的话，Bot 能搜索、不能读取网页，交付时告诉用户。

---

## 第 8 步：外网访问（可选，第 0 步选了 B 时做）

用户选了 A（局域网）或 C（已有 HTTPS）的话，跳过这一步。

请用户在管理页「远程访问」里：

1. 打开「启用 Tailcat」，点「保存」；
2. 等「状态」变成「已就绪」，点「测试连接」，应提示「连接成功」或「直接连接」；
3. 第 9 步配对时，点「复制连接链接」，得到一个以 `tailcat://connect/` 开头的链接。

这个链接相当于钥匙，只让用户自己复制粘贴到客户端，不要发到别处。

客户端用 Tailcat 时，在连接界面打开「Tailcat」开关，「Host 地址」里粘贴这个链接。在家里也可以继续用局域网地址连接。

---

## 第 9 步：生成客户端并配对

顺序很重要：**先生成并安装客户端，等用户准备好输入时，再生成配对码。** 配对码只有 5 分钟有效，而且只能用一次。

### 9.1 Windows 10/11 x64

在用户的 **Windows 电脑**上执行（你运行在这台电脑上就由你执行，否则交给用户）：

1. `node --version` 应显示 v22.12 或更新。没有的话请用户从 https://nodejs.org 安装 LTS 版本。Windows 10 还要安装 7-Zip。
2. 获取仓库（`git clone` 或下载 ZIP 解压），在仓库根目录执行（Git Bash、cmd、PowerShell 都可以）：

   ```sh
   node windows/patchers/desktop/patch.mjs
   ```

3. **应该看到：** 输出里有 `"verified": true`。`windows\output\` 下生成三样东西：

   | 文件 | 用法 |
   | --- | --- |
   | `GrokBotLocal-0.71.2-x64-Setup.exe` | 安装包（推荐）。装到当前用户目录，不需要管理员权限 |
   | `GrokBotLocal-0.71.2-x64-portable.zip` | 便携版压缩包，解压后运行 `Grok Bot.exe` |
   | `Grok Bot Local\` | 解压好的便携版文件夹 |

4. **请用户在文件资源管理器里双击 `Setup.exe` 安装**，然后从开始菜单或桌面打开「Grok Bot Local」，停在填写 Host 地址的界面。
   - 安装包是你用命令运行的话，安装结束问「现在打开 Grok Bot Local？」时选**否**，再让用户从开始菜单打开。原因：从终端里启动的客户端会继承终端的环境；从 Git Bash 启动时，Bot 在本机执行的命令会改用 Git Bash，`cmd /c` 这类参数会被改写。

**如果失败：**

- **下载原版失败**：让用户用浏览器下载 https://downloads.cursor.com/grokbot/stable/win32-x64/0.71.2/Grok_Bot_0.71.2_Setup.exe ，然后执行 `node windows/patchers/desktop/patch.mjs --source <下载的文件路径>`。
- **「输出已存在，不会覆盖」**：把旧的 `windows\output` 改名或删除后重新执行。
- **报缺少 `@electron/asar`**：在仓库根目录执行 `npm install --prefix mac/patchers/desktop`，或重新下载完整仓库。
- **打开时被 SmartScreen 拦截**：点「更多信息 → 仍要运行」。
- **被「智能应用控制」拦截**：见第 0 步的核对表。

### 9.2 Mac（Apple Silicon）

在用户的 **Mac** 上执行（你运行在这台 Mac 上就由你执行，否则交给用户）：

1. `node --version` 应显示 v22.12 或更新。版本低的话，请用户从 https://nodejs.org 下载安装 LTS 版本。
2. 在 Mac 上获取仓库：`git clone https://github.com/ferretgeek/prokbot-plus.git`，或下载 ZIP 解压。**不要从 Windows 电脑拷贝过来**，会丢掉文件的可执行权限。
3. 在仓库根目录执行：

   ```sh
   node mac/patchers/desktop/patch.mjs
   ```

   想让 Bot 控制这台 Mac 的图形界面，改用 `node mac/patchers/desktop/patch.mjs --identity auto`（Mac 上要已有代码签名证书），首次使用时在系统设置里授予「辅助功能」和「屏幕录制」权限。

4. **应该看到：** 输出里有 `"verified": true`，生成了 `mac/output.noindex/Grok Bot.app`。执行 `open mac/output.noindex` 会在访达里打开这个文件夹。
5. 请用户把它拖到「应用程序」，打开后停在填写 Host 地址的界面。
   - 生成的 App 和官方版同名。已经装了官方 Grok Bot 的话，拖进去时会提示替换。想保留官方版，先把官方版改名。

**如果失败：**

- **下载原版失败**：用 `--source <官方 Grok Bot.app 或 .dmg 的路径>` 指定已有的原版文件。
- **「输出已存在，不会覆盖」**：把旧的 `mac/output.noindex` 改名或删除后重新执行。
- **报缺少 `@electron/asar`**：在仓库根目录执行 `npm install --prefix mac/patchers/desktop`。
- **打开时提示无法验证开发者**：在「系统设置 → 隐私与安全性」里点「仍要打开」。

### 9.3 iPhone（iOS）

需要用户自己提供：

- Grok Bot 1.16.0（23152）arm64 的**砸壳** IPA，主程序和三个扩展都要解密；
- Python 3.10+；
- 签名工具和证书。

本仓库不提供任何原版或已修改的 IPA。

```sh
python3 ios/release/patch-ios.py --input <砸壳.ipa> --output ./ios-output --bundle-id <你的BundleID>
```

签名方法见 [ios/README.md](../ios/README.md#签名)。安装是否成功由用户确认，交付时如实说明进度。

### 9.4 Android 手机

Android 版不改官方 Android 安装包（它带有防篡改保护），而是用官方 Windows 安装包里的桌面版界面，加上本项目的 Android 外壳生成一个 APK。生成在电脑上进行，Windows、Mac、Linux 都可以（你运行在这台电脑上就由你执行，否则交给用户）：

1. `node --version` 应显示 v22.12 或更新。解压官方安装包要用到：Windows 11 自带的 `tar`（Windows 10 要装 7-Zip）；Mac 自带的 `tar`；Linux 要先装 `bsdtar` 或 7-Zip，例如 Ubuntu/Debian 上执行 `sudo apt-get install -y libarchive-tools < /dev/null`。
2. 在仓库根目录执行：

   ```sh
   node android/patchers/patch.mjs
   ```

3. **应该看到：** 输出里有 `"verified": true`，`android/output/` 下生成 `GrokBotLocal-0.71.2-android.apk`。第一次执行还会提示「已生成新的签名密钥」，密钥在 `~/.grokbot-local/android-signing.json`。**把这个文件的位置告诉用户并请他备份**：以后升级 App 必须用同一个密钥，丢了只能卸载重装、重新配对。
4. 把 APK 装到手机上，二选一：
   - 手机用 USB 连着这台电脑、并已开启「USB 调试」时：`adb install -r android/output/GrokBotLocal-0.71.2-android.apk`，应该看到 `Success`；
   - 否则把 APK 文件发到手机上（数据线、网盘、聊天软件都可以），请用户在手机上点开安装。系统提示「禁止安装未知应用」时，按提示允许这个来源。
5. 请用户打开「Grok Bot Local」，停在填写 Host 地址的界面。第一次进入工作区时，系统会问是否允许通知，请用户选「允许」。

**如果失败：**

- **下载原版失败**：同 9.1，用浏览器下载后执行 `node android/patchers/patch.mjs --source <下载的文件路径>`。
- **「无法解压原版程序包」**：按第 1 条安装 `bsdtar` 或 7-Zip；7-Zip 不在默认位置时，用环境变量 `GROKBOT_7Z` 指向 `7z`（Windows 上是 `7z.exe`）。
- **「输出已存在，不会覆盖」**：把旧的 `android/output` 改名或删除，或者加 `--force`。
- **手机提示「应用未安装」或签名冲突**：手机上装过用别的密钥签名的版本。先卸载旧版（会清除配对），再安装。
- **报缺少 `@electron/asar`**：在仓库根目录执行 `npm install --prefix mac/patchers/desktop`。

### 9.5 配对

用户说某台设备的客户端已经打开、停在填写界面后，再执行：

```sh
ssh <用户>@<服务器IP> 'bash -s' <<'EOF'
<公共开头>
hostadmin pair
EOF
```

请用户在客户端里填写：

- **配对码**：输出里的 `pairingKey`，6 位，由大写字母和数字组成，例如 `K7MPQ2`。
- **Host 地址**：
  - 局域网或 HTTPS：填输出里的 `hostUrl`；
  - Tailcat：打开「Tailcat」开关，粘贴第 8 步复制的连接链接（Android 版没有这个开关，只能填地址）。

**每台设备生成一个新的配对码。** 超过 5 分钟没用的话，重新执行一次。

**应该看到：** 客户端进入主界面；`hostadmin status` 的 `devices` 里出现这台设备。

---

## 第 10 步：验收

逐项检查，全部通过才算完成。前三项由你执行，其余的请用户在客户端里操作，你确认结果：

| 检查项 | 怎么查 | 通过标准 |
| --- | --- | --- |
| 服务端健康 | `<公共开头>` 后执行 `curl -s $LOCAL_URL/healthz` | `{"ok":true,"initialized":true}` |
| 模型可用 | `hostadmin status` | `hostConnected: true`，`reload: applied` |
| 设备已配对 | `hostadmin status` 的 `devices` | 列出每台已配对的设备 |
| 能对话 | 用户给 Bot 发「你好」 | 收到回复 |
| 工具调用和云电脑 | 用户发「在你自己的 Linux 云电脑上运行 uname -a，把结果告诉我」 | 回复里有 `Linux` |
| 联网（如已配置） | 用户发「搜一下今天的新闻并给出来源」 | 回答里有来源链接 |
| 生图（如已配置） | 用户发「画一张 16:9 的风景图」 | 客户端里显示图片 |
| 外网（如已配置 Tailcat） | 用户让设备连手机热点，再发一条消息 | 收到回复 |
| Android 后台通知（如有 Android） | 用户发「先执行 sleep 20，再回复好了」，马上回到手机桌面 | 半分钟左右收到系统通知，点开进入这个 Bot |

「工具调用」那项失败、日志里有 `native_thinking_replay_mismatch` 的话：这是一些网关用 Responses 格式转发 Claude 时的问题。回第 6 步，Claude 改用 `anthropic` 格式。

---

## 第 11 步：交付给用户

把下面的内容整理后发给用户：

```text
部署完成。
- 管理页：<GROKBOT_PUBLIC_URL>
- 管理员密码：<密码>（也保存在服务器的 ~/grokbot/secrets/admin-password）
- 客户端填写的 Host 地址：<GROKBOT_PUBLIC_URL>（C 方案就是你的 https 域名）；外网用 Tailcat 时，在管理页「远程访问」复制连接链接
- 已配对的设备：<列表>
- 对话模型：<格式> / <模型> / 思考强度 <值>
- 联网 / 生图：<已配置或未配置>
- 服务器部署目录：~/grokbot（配置 .env，密码和 Key 在 secrets/，数据在 Docker 数据卷 grokbot_host-data、grokbot_box-home、grokbot_box-workspace）
- 新设备配对：管理页「设备与通知」生成配对码
- Android 签名密钥：<电脑上的路径>（请备份；升级 Android 版必须用同一个密钥）
- 日常维护命令：见附录 A（已换成实际路径）
```

用户在第 0 步指定了**他电脑上**的文件夹的话，把以上内容、`.env` 的内容和附录 A 的命令写成一份交接文档放进去。密码和 Key 只写在这份私有文档里，并提醒用户不要外传。

---

## 附录 A：日常运维

以下每段都用 `ssh <用户>@<服务器IP> 'bash -s' <<'EOF' ... EOF` 执行，开头先写 `<公共开头>`。

```sh
$DC ps                      # 查看状态
$DC logs --tail 200 host    # Host 日志
$DC restart host            # 重启 Host，不丢数据
$DC up -d                   # 启动；修改 .env 后也用它生效
```

**备份**：会暂停容器几秒到几分钟。

```sh
cd ~/grokbot/src/host
python3 release/backup.py backup --project grokbot --directory ~/grokbot/backups/$(date +%F) --image grokbot-host:local < /dev/null
```

**恢复**：恢复成一个新项目 `grokbot-restored`，不会覆盖原来的数据。两个项目占用同一个端口，所以先停掉原来的：

```sh
$DC stop
cd ~/grokbot/src/host
python3 release/backup.py restore --project grokbot-restored --directory ~/grokbot/backups/<日期> --image grokbot-host:local < /dev/null
cd ~/grokbot && docker compose --env-file .env -p grokbot-restored -f src/host/release/compose.yaml up -d
```

确认恢复后的数据没问题，以后就用 `-p grokbot-restored` 管理它，「公共开头」里的 `DC` 也要改成这个项目名。想换回原来的：先执行 `docker compose --env-file .env -p grokbot-restored -f src/host/release/compose.yaml stop`，再执行 `$DC up -d`。

**更新到新版本：**

1. **先找到原来的部署。** 不是按本手册部署的（没有 `~/grokbot`），或者项目名不是 `grokbot`，先执行：

   ```sh
   docker ps -a --filter ancestor=grokbot-host:local --format '{{.Label "com.docker.compose.project"}} | {{.Label "com.docker.compose.project.config_files"}}'
   ```

   输出的是项目名和 compose 文件的路径。代码目录就是 compose 文件往上两级的仓库根目录。之后：
   - 把下面命令和「公共开头」里的 `~/grokbot/src`、`-p grokbot`、`-f ...compose.yaml` 换成实际的值；
   - 原来启动时用了 `.env` 的话，`--env-file` 也指向它。
2. 先备份（见上）。
3. 获取新代码。**代码更新失败就停下**，不要继续构建：

   ```sh
   cd ~/grokbot/src && git pull --ff-only && git log -1 --format='已更新到 %h %ad' --date=short
   ```

   没有输出「已更新到 …」就说明更新失败。网络问题的话，按第 2 步方法二重新上传代码。
4. 在后台重新构建：

   ```sh
   cd ~/grokbot/src && nohup python3 host/release/build-docker.py > ~/grokbot/logs/build.log 2>&1 < /dev/null &
   ```

5. 用第 3 步的方法检查构建，完成后执行 `$DC up -d`。
6. **更新客户端**（新版本的 CHANGELOG 写了客户端改动时才需要）：在生成客户端的电脑上进入仓库目录，执行 `git pull --ff-only`，再按第 9 步重新生成和安装对应的客户端。安装前先退出正在运行的客户端（Windows 在托盘图标上右键退出）。
   - Windows、Mac：先把旧的 `windows\output` 或 `mac/output.noindex` 改名或删除，再生成。
   - Android：生成时加 `--force` 覆盖旧的输出，签名密钥必须是第一次生成时的那一个。用 `adb install -r` 或在手机上点开新的 APK 覆盖安装，配对会保留。

**清理构建用的临时镜像**（可回收约 0.8 GB）：`docker image rm grokbot-patch-base:local`。不要删 `node:22-bookworm-slim`，`hostadmin` 要用它。

---

## 附录 B：故障排查

| 现象 | 处理 |
| --- | --- |
| 局域网里打不开管理页（A、B 方案） | `.env` 中 `GROKBOT_LISTEN_ADDRESS` 改为 `0.0.0.0`，执行 `$DC up -d`；云服务器还要在安全组放行端口 |
| 用域名打不开管理页（C 方案） | 检查反向代理，见第 4.1 步。不要改监听地址，也不要开放 18080 |
| Docker 发布的端口绕过了 ufw 防火墙 | 这是 Docker 的默认行为。只想让局域网访问的话，把 `GROKBOT_LISTEN_ADDRESS` 设为服务器的局域网 IP，**同时把「公共开头」的 `LOCAL_URL` 改成这个 IP** |
| host 一直不是 healthy | `$DC logs --tail 200 host`；检查磁盘空间；`$DC restart host` |
| 备份后 host 短暂显示 unhealthy | 暂停期间健康检查超时，一分钟内会自动恢复 |
| 客户端提示「Host 返回了不同的服务地址」 | 客户端填写的地址和 `GROKBOT_PUBLIC_URL` 不一致，改成完全一样 |
| 配对码无效 | 超过 5 分钟或已经用过，重新执行 `hostadmin pair` |
| 管理接口或 `hostadmin` 报 `HTTP 429` | 登录、初始化、模型测试都限制每分钟 5 次，等 1 分钟。经过反向代理时所有访问者共用这个计数 |
| 脚本执行到一半就没有输出了，后面的命令都没跑 | 某条命令读走了脚本的剩余内容。给 `docker compose exec`、`apt-get` 这类命令加上 `< /dev/null` |
| 忘记管理员密码 | 清空管理员后重新初始化，已配对的设备不受影响。依次执行：`$DC stop host`；`docker run --rm -v grokbot_host-data:/data node:22-bookworm-slim node -e "const f='/data/auth.json',fs=require('fs'),j=JSON.parse(fs.readFileSync(f));j.admin=null;j.sessions=[];fs.writeFileSync(f,JSON.stringify(j))"`；`$DC start host`。然后重做第 5 步 |
| 对话没有反应 | `hostadmin status` 看 `hostConnected`；用 `hostadmin model-set ... --test-only` 复测模型 |
| 日志出现 `[model] … retrying without …` | 服务商不支持某个可选参数，Host 已自动去掉并重试，不用处理 |
| 日志出现 `Local auto-review failed` | 自动安全审查的模型请求失败，Bot 的这次操作被拒绝。检查模型服务是否稳定 |
| Bot 不能操作云电脑 | `$DC ps` 看 box 是否在运行；`$DC restart box` |
| 管理页「远程访问」一直不是「已就绪」 | `$DC logs --tail 100 host` 查看 Tailcat 的报错；服务器要能访问外网 |
| Windows 10 解压原版失败 | 安装 7-Zip，或设置环境变量 `GROKBOT_7Z` 指向 `7z.exe` |
| Windows 上 Bot 执行的命令卡住或参数异常 | 客户端是从 Git Bash 里启动的。在托盘图标上右键退出，再从开始菜单打开 |
| Android 版收不到后台通知 | 配对页上的「后台接收通知」要打开。在手机的系统设置里允许 Grok Bot Local 发送通知和在后台运行，并关闭它的电池优化 |
| Android 版回到了填写 Host 地址的页面，或者通知「连接已失效，请打开 Grok Bot 重新配对」 | 这台设备在管理页被撤销了，或者 Host 的数据被重置过。执行 `hostadmin pair` 生成新的配对码，在这个页面重新填写 |

## 附录 C：管理接口（自己写脚本时参考）

- 先 `POST /admin/api/login`，请求体 `{"password":"..."}`，拿到 Cookie。之后所有非 GET 请求都要带请求头 `x-grokbot-csrf: 1`。
- 可以不带 `Origin` 请求头；如果带，必须和 `GROKBOT_PUBLIC_URL` 一致。
- 登录、初始化、模型测试，每个 IP 每分钟最多 5 次。
- 常用接口：

  | 接口 | 用途 |
  | --- | --- |
  | `GET /admin/api/status` | 查看状态 |
  | `GET` / `PUT /admin/api/model` | 读取或写入对话模型配置 |
  | `POST /admin/api/model/test` | 测试模型配置 |
  | `POST /admin/api/pairing-keys` | 生成配对码 |
  | `GET` / `PUT /admin/api/web-services` | 读取或写入联网工具配置 |
  | `POST /admin/api/web-services/test` | 测试联网工具 |
  | `GET` / `PUT /admin/api/media` | 读取或写入图片与视频配置 |

- 实现见 `host/server/index.mjs` 和 `host/server/media-api.mjs`。
