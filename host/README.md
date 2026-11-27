# ProkBot Plus Host

[English](README.en.md)

自建 Grok Bot 服务端。Host 可在 Linux amd64 / arm64 上构建；官方执行桌面只有 amd64，ARM 机器可以接一台独立的 amd64 节点，或同机模拟（实验）。需要 Python 3.10+、Docker 和 Compose v2；Docker Engine 26.0+（API 1.45+）且 Compose 2.26.0+ 时，同机部署还会开启「Bot 读记忆」（见[数据与备份](#数据与备份)）。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md)，实现原理见[技术文档](../docs/ARCHITECTURE.md)。

## 使用

在 `host/` 目录运行：

```sh
python3 deploy.py doctor
python3 deploy.py init
python3 deploy.py up
```

新装默认只监听回环地址，自定义访问地址在 `init` 时指定（`python3 deploy.py init --help`）。已有实例用 `update`，不要重新 `init`。首次设置、模型和配对见部署手册。网页版有自己的端口和网址，见[网页版](#网页版)。

## 网页版

管理页的「网页版」可以上传网页版界面包（生成方法见[网页版说明](../web/README.md)），浏览器用配对码登录后就能使用；不上传就没有变化。

网页版由 Host 的第二个端口提供（容器内 8001），管理页和客户端仍然使用 8000。两个端口是两个不同的网址：界面包里是官方界面的代码，放在单独的网址上，即使同一个浏览器登录过管理页，这些代码也调用不了管理接口。网页版端口只提供登录页、界面包和网页版用到的设备接口；旧的 `/web/` 链接会从管理页地址跳转过去。

- **端口**：Compose 把网页版映射到 `.env` 的 `GROKBOT_WEB_PUBLIC_PORT`（`init --web-port`，默认是 `--port` 加 1，即 18081；1.15.0 以前的实例没有这一项，按 18081），监听地址和管理页一样由 `GROKBOT_LISTEN_ADDRESS` 决定。直接用 IP 或域名加端口访问时不需要别的设置，网页版地址就是同一个主机名加上网页版端口。
- **多个实例**：同一台机器上的每个实例要用不同的 `GROKBOT_PUBLIC_PORT` 和 `GROKBOT_WEB_PUBLIC_PORT`。`up`、`update`、`recover` 和 `doctor` 发现端口已被其他容器或本机其他程序占用，或两个端口相同时，在构建、停止或解包前拒绝。
- **HTTPS 反向代理**：给网页版单独配置一个入口，建议用单独的子域名，并让 Host 知道两个地址：新实例给 `init` 加 `--web-public-url https://web.bot.example.org`，已有实例在 `.env` 加 `GROKBOT_WEB_PUBLIC_URL` 再 `update`。两个地址不能相同，相同时 Host 不会启动，`up`、`update`、`recover` 和 `doctor` 会在改动任何东西之前拒绝；也不要用路径（例如 `https://bot.example.org/web/`）把网页版放在管理页的网址下面。
- **网页版地址**：`init` 输出的 `webClientUrl`、`up` 和 `update` 结束时的 `Web client` 一行、`doctor` 的 `webClientUrl` 和管理页「网页版」显示的都是它。

```sh
GROKBOT_PUBLIC_URL=https://bot.example.org
GROKBOT_WEB_PUBLIC_URL=https://web.bot.example.org
```

网页版的入口转发到 `127.0.0.1:18081`，并允许 WebSocket，Bot 电脑的画面和实时语音都要用到。以 nginx 为例：

```nginx
server {
    listen 443 ssl;
    server_name web.bot.example.org;
    # 证书：ssl_certificate 和 ssl_certificate_key
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

## 环境变量

实例目录的 `.env` 可用于调整 Host 容器的运行参数（同机与独立 Host 部署均生效）：

- `GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES`：大体积 `conversation-blobs.db` 快速打开的字节阈值，默认 `33554432`（32 MiB）。文件大于该阈值且无待恢复标记时，打开连接先做结构探针避免阻塞启动，再通过独立工作线程（`node:sqlite`）在主事件循环之外执行 `PRAGMA quick_check(1)`；若检测到损坏会写入 `.quickcheck-required`，下次打开自动回退到原版完整隔离与抢救流程。注意：`quick_check(1)` 只在报告第一条错误后提前停止，对健康的大库仍会完整读取整个文件；已验证标记按 `(size, mtimeMs)` 记录，WAL 检查点会更新文件元信息，因此活跃的大库在冷启动时通常会重新扫描（在后台线程进行，不阻塞主线程）。设为 `infinity` 则恢复每次打开都在主线程同步执行完整 `quick_check` 的原版行为。
- `GROKBOT_DESKTOP_PARK_ENABLED`：是否启用共享执行电脑上各 Bot 独立 `Fork` 桌面的闲置自动休眠（默认 `0` 关闭，设为 `1` 开启）。开启后在无活跃回合、无待批操作或人工接管、无后台 Shell 任务、无执行中请求且无 VNC 观看连接时，闲置满 `GROKBOT_DESKTOP_PARK_IDLE_MINUTES`（默认 `30` 分钟）调用 `/usr/local/bin/stop-window --park` 关闭该桌面的 Chrome、`Xvfb`、`x11vnc` 与 `exec-daemon`（以及带 `SAND_DESKTOP_UNIT=:N` 标记或占用该 Chrome 目录的进程），但保留座位归属与 `Fork-<N>` 浏览器目录，下次使用自动唤醒（注意：已脱离的后台命令会失去父进程与显示器，需要显示器的程序、Chrome 正在进行的下载以及仅存于内存的会话 Cookie 或打开标签页可能会中断或无法恢复，持久化 Cookie 保留；唤醒后 Chrome 会重新启动，第一次浏览器操作可能报「无法获取当前页面状态」，和原版重启执行电脑后一样，再试一次即可）；当执行电脑可用内存低于 `GROKBOT_DESKTOP_PARK_PRESSURE_AVAILABLE_PERCENT`（默认 `15`%）或内核内存 PSI `avg10` 超过 `GROKBOT_DESKTOP_PARK_PRESSURE_PSI`（默认 `10`）时（同机部署下为宿主机整体内存指标），闲置满 `GROKBOT_DESKTOP_PARK_PRESSURE_IDLE_MINUTES`（默认 `5` 分钟）按最久未用顺序提前休眠。可通过 `GROKBOT_DESKTOP_PARK_MAX_PER_TICK`（默认 `5`，支持 `0`）和 `GROKBOT_DESKTOP_PARK_INTERVAL_MS`（默认 `60000`，最小 `10000`）进一步调整；设为 `0` 时完全不安装桌面休眠覆盖层，保持与原版完全一致的行为。

## 模型能力同步与缓存

模型档案支持按档案独立选择 `auto`（自动跟随）或 `manual`（手动）：升级而来的旧档案（含未迁移的旧版单服务 `model.env`，即使上下文填 `0`）在管理页与运行时均默认保留 `manual`，不会悄悄套用内置规格表猜测上下文上限；`host-admin.mjs model-set` 仅在指定 `--context` / `--efforts` 时设为 `manual`，未指定时沿用原档案模式。

- **缓存文件**：管理服务将上游 `/models` 返回的上下文容量（≥ 1024）、思考强度及同步开关写入 `/data/model-context-cache.json`；Host 运行时将溢出报错学到的观测上限写入 `/data/model-context-observed.json`（保留 30 天，仅在出现 `a + b > c` 这类比较式报错或连续两次一致观测后落盘）。两个文件均以服务格式、地址与模型 ID 的 SHA-256 摘要分键，不保存明文 API Key 或服务地址。
- **手动与自愈**：`manual` 模式不受观测上限压低，管理页推荐值及手动档位仍按总上下文的 75% 计算摘要阈值；`auto` 模式仅采用上游 `/models` 返回值与运行时观测上限（内置规格仅在管理页作建议展示，需确认后按 `manual` 保存），并按扣除输出预留后的 75% 计算摘要阈值（如 Anthropic 200K 模型扣除默认 64K `max_tokens` 后为 102K）。可通过管理页「清除观测上限」、手动「同步上游能力」或保存配置清掉已有观测上限：保存时只清改了接口格式、地址、Key、模型或上下文设置的档案，这些都没改时（原样保存、只改名或改路由）清掉全部档案的。清除前产生的观测不再落盘。
- **后台请求开关**：管理页模型页的「上游同步设置」提供两个开关——「自动同步上游模型能力」（默认开启：在存在 `auto` 档案时于启动、保存模型配置和每 6 小时携带对应服务的 API Key 请求上游 `/models`；全部为 `manual` 时跳过后台请求，关闭后不再发起任何后台请求）与「附带 Codex 客户端版本参数探测清单」（默认关闭：开启后才会在 `/models` 未返回上限时附加 `?client_version=0.160.0`）。

## 离线构建

构建工具默认从固定来源下载原版文件并严格校验，版本见 `recipes/host/manifest.json`。已有原版文件时：

```sh
python3 deploy.py up --host-archive /path/to/host.tgz --box-archive /path/to/box.tar.gz
```

- Box 归档校验通过后标记为 `grokbot-box-input:9d2ac1b`，Compose 直接使用。离线归档按配置摘要校验，与 Docker 的镜像存储方式无关。
- 已有实例把 `up` 换成 `update`；只构建不启动时，`release/build-docker.py` 接受相同参数。
- 这些参数只替代原版下载。全离线还要预缓存基础镜像、系统包和 npm 依赖，ARM 同机还需要 amd64 的 `busybox:1.37`。ARM 独立 Host 不传 `--box-archive`。
- `release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` 可以单独生成 Host 文件；只做固定的字节复制和新增，不反编译。

## 数据与备份

```sh
python3 deploy.py backup < /dev/null
```

- 同机部署备份 `host-data`、`box-home`、`box-workspace`；独立 Host 只有 `host-data`，执行节点要单独备份 `gateway-data` 和两个桌面卷。
- 备份目录只含卷归档和校验清单，**不含镜像、实例目录的 `.env` 和宿主机系统**。卷里有配对身份、模型 Key、对话和工作区文件，备份不要公开。
- 备份会暂停正在运行的容器，结束后恢复。`update` 先构建候选，再停止旧服务并备份。分机部署不是跨主机原子快照，要协调两端停止写入。
- **Bot 读记忆**：同机部署时，Docker Engine 26.0+（API 1.45+）且 Compose 2.26.0+ 的 `up`、`update`、`recover` 会加上 `release/compose.memory.yaml`，把 `agents`、`user-memory`、`workflows`、`plugins`、`managed-skills` 五棵数据目录**只读**挂到 Box 的 `/data/runtime/host-data/<目录>`，Bot 能查阅记忆，不能修改任何 Bot 的设置、记忆或自动任务。`agent-transcripts`、`connector-secrets`、`model.env`、`auth.json`、`projects` 和内部令牌都不会暴露给 Box；`agents/<id>/` 里的数据库 Bot 的 Shell 看得到，Read 工具读不了，和官方同机运行时一样。版本不够时提示并跳过，部署照常进行；`doctor` 的 `memoryMounts` 表示能否开启，`--host-only` 不挂这些目录。数据初始化只设置新建目录的属主和权限，不改已有顶层目录。部署、备份和恢复都会核对挂载集合。1.7.0–1.14.0 的 Box 以可写方式挂载这些目录，`backup` 照常备份，`update` 把它们换成只读。

**恢复成一个新实例**：分开保管卷备份、原 `.env`、对应代码版本和镜像；清单的 `serviceImages` 记录完整镜像 ID，目标 Docker 必须已有这些镜像。先确认原实例及其他机器上的同一身份都已停机，不要对原项目运行 `down -v`。以下是回环地址的同机示例，目录和项目名按实际替换；要让原有配对继续可用，用 `init` 的 `--listen`、`--port`、`--public-url` 重现原地址（网页版还有 `--web-port`、`--web-public-url`）；端口被其他容器或程序占用时，`recover` 在解包前拒绝。独立 Host 在 `init` 前加 `--host-only`。

```sh
python3 deploy.py --home "$HOME/grokbot-restored" --project grokbot-restored init < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" recover --directory /path/to/backup < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" status < /dev/null
```

`recover` 校验卷、项目名、拓扑和本地镜像 ID，只往新项目解包，启动时只用记录的镜像，不构建、不拉取、不改原卷。启动后用原设备读回旧对话和文件。启动失败时新项目的卷保留，原实例不会自动重启。

旧清单缺少完整的 `serviceImages`，或精确镜像不在本机时，不能自动恢复上线，也不要用 `:local` 标签猜版本。只恢复数据用 `python3 release/backup.py restore --project grokbot-data-only --directory /path/to/backup --image <已核实的镜像ID> < /dev/null`，它不启动服务，独立执行节点也用这个入口。之后手动用 Compose 启动同机部署时，`-f release/compose.yaml` 就能启动，但不开启「Bot 读记忆」。确认 Docker Engine 26.0+ 且 Compose 2.26.0+ 后才能开启：先运行一次下面第一条命令，创建 Bot 的电脑要挂载的目录（只建缺失的），再在之后的每条 Compose 命令里同时指定两个文件。Engine 26 以下会忽略子路径，把整个 `host-data`（含模型 Key 和登录凭据）挂进 Bot 的电脑，Compose 2.26 以下无法启动。`deploy.py` 的 `up`、`update`、`recover` 会自动判断并做这些步骤。

```sh
docker compose --env-file <实例目录>/.env -p <项目名> -f release/compose.yaml run --rm --no-deps --user 0:0 --entrypoint python3 host /opt/grokbot/release/data_init.py /data/runtime/host-data < /dev/null
docker compose --env-file <实例目录>/.env -p <项目名> -f release/compose.yaml -f release/compose.memory.yaml up -d < /dev/null
```

同一个 Docker daemon 上，部署工具用锁防止并发修改同一项目、同源恢复副本重复上线；不同 daemon 之间不共享锁，由操作者确认同一身份只运行一份。崩溃后可能留锁，先核实服务和操作进程，不要把删锁当成常规步骤。名字带 `_restore-in-progress` 的项目是未完成的恢复，不能启动，换一个空项目重试。

## 分开部署执行电脑

Host 机器用 `python3 deploy.py --host-only init` 再 `python3 deploy.py up`。在另一台 **amd64 Linux** 的 `host/` 目录部署执行节点：

```sh
python3 release/build-docker.py --box-only
# 设置至少 32 位的随机 GROKBOT_NODE_TOKEN；离线镜像可在上一条命令加 --box-archive
docker compose -f release/compose.execution.yaml up -d --build
```

然后在 Host 管理页填写执行节点的地址和密钥并启用。`--host-only` 模式要先配好模型并启用节点，聊天核心才会启动；没有节点时管理页能打开、容器也可能显示健康，但不能聊天。

- 局域网访问：设置 `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`，端口默认 18443。
- 内嵌网络：设置 `GROKBOT_TAILCAT_ENABLED=1`；高级选项是 `GROKBOT_TAILCAT_RELAY` 和 `GROKBOT_TAILCAT_DERP_MAP_URL`。

<a id="capacity-benchmark"></a>
## 整机基准

`bench/` 用来比较两个版本在同一台机器上的整机资源占用，不是备份工具，也不给出硬件最低配置。只在获准的专用非生产 Linux 虚拟机上运行，不接生产服务、卷或凭据。

| `--mode` | 采样对象 |
| --- | --- |
| `x86-local` | 同机：amd64 Host 上的 `host` 和 `box` |
| `arm-split` | 分机：arm64 Host 上的 `host`；另一台 amd64 上的 `gateway` 和 `box`（用 `--role desktop`），两端用同一个 `--run-id` |
| `arm-emulated` | 模拟同机（实验）：arm64 上的 `host` 和模拟的 amd64 `box` |
| `host-only` | 只有 `host`，只用于设置和空闲诊断，不评容量 |

```sh
R=/path/to/private-bench
python3 -B bench/bench.py sample --isolated-guest --mode x86-local --role host \
  --project benchdemo --run-id before-1 --out "$R/BEFORE/1/host.jsonl" --interval 5 --duration 5400
python3 -B bench/bench.py validate "$R/BEFORE/1" > "$R/round-report.json"
python3 -B bench/bench.py compare --before "$R/BEFORE" --after "$R/AFTER" > "$R/comparison.json"
```

- 采样器需要 `systemd-detect-virt --vm` 认可的虚拟机、cgroup v2 和本地 Docker 套接字；裸机、WSL、容器、远程或 rootless Docker 会被拒绝。stderr 输出 `sampling-ready` 后再开始构建或负载。
- 每轮目录需要 `run.json`、`actions.jsonl` 和各角色的采样文件。字段和阶段（`build`、`cold`、`idle`、`chat`、`desktop`、`restart`、`soak`、`concurrent`）的规则见 [`bench/evidence.py`](bench/evidence.py)，样例见 [`tests/benchmark_checks.py`](tests/benchmark_checks.py)。只有真实客户端、外部模型 API 的测量才能送审；`soak` 每轮至少 1 小时真实负载。
- `compare` 需要同条件下至少三对基线和候选，失败的轮次也要保留。退出码 `0` 表示可复核（不是硬件认证），`1` 表示失败、不完整或轮数不足，`2` 表示输入无效或条件不匹配。指标的计算方式见 [`bench/telemetry.py`](bench/telemetry.py)。
- 离线自检：`python3 -B bench/bench.py selftest`；回归测试：`node --test "tests/benchmark*.test.mjs"`。

首页的最低和推荐配置来自功能测试和实际占用，不是这套对照的结果，依据见[技术文档](../docs/ARCHITECTURE.md#capacity-evidence)。

## 应用开发

管理页的「应用」统一管理远程 MCP 服务、带代码的应用和附带的技能。一个应用就是一个 `grokbot-app` JSON 包，旧版插件 JSON 也能导入。

- 内置的「编写应用」提供开发指南、格式校验和提交工具。Bot 提交后，用户在客户端的「连接应用」里添加并授权。
- 导入、导出都是单个 JSON，包含代码、图标、说明和技能；已保存的配置和授权凭证不会导出。
- 代码应用通过执行电脑上的 MCP 进程运行，不额外部署容器，和这台电脑上的其他任务共享用户权限、文件和网络。
- OAuth 支持 PKCE、一次性 state 和过期刷新。开发者声明授权地址、Token 地址和 scopes；用户填写 Client ID/Secret，再从客户端打开授权页。
- 应用版本不可覆盖，升级后可以恢复到上一个版本。

完整的包格式、可运行示例和 OAuth 示例见 [server/application-guide.md](server/application-guide.md)（英文，Bot 写应用时读的就是这份）。

## 许可

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
