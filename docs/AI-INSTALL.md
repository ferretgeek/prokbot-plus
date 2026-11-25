# ProkBot Plus 部署手册

[English](AI-INSTALL.en.md) · [架构与扩展](ARCHITECTURE.md) · [分机部署](#split-host) · [卷备份与恢复](#volume-recovery)

**给人和 AI 的同一条路线：选机器 → 检查 → 启动 → 配模型 → 客户端发消息。** 不要把容器显示 `healthy` 当作交付成功。下文的服务器命令从仓库根目录运行，Host 发布包解压后也是同样的结构。

## 先选部署方式

**已有 Host、只更新客户端？** 跳过下面全部服务器命令。使用对应客户端 ZIP，保留 `.env`、项目名和数据卷；不要为更新客户端运行 `init`、`up` 或 `update`。

| 你有的机器 | 怎么部署 | 注意 |
| --- | --- | --- |
| 一台 x86_64 Linux | 默认，Host 和执行桌面都原生运行 | 最低 2 核 4 GB，推荐 4 核 8 GB；2 核 2 GB 实测不够。见[首页的服务器要求](../README.md#server-requirements) |
| 一台 ARM64 Linux，例如 Oracle Ampere A1 | 默认，Host 原生运行，桌面经 QEMU 模拟 amd64 | **实验**。不是原生 ARM 桌面；先通过 `doctor`，实际速度取决于任务 |
| ARM64 Linux + 一台 amd64 Linux | 在 Host 的 `doctor`、`init` 前加 `--host-only`；桌面放第二台 | ARM 机不下载或模拟桌面。当前版本未在 ARM 上重新实测 |

<a id="split-host"></a>
**分机部署**：`--host-only` 只省略本机桌面，不是无桌面的聊天模式。在另一台 amd64 Linux 上部署执行节点，然后在 Host 管理页填写节点地址、密钥并启用它。模型与节点未配置好之前，管理页和健康检查可以正常，但聊天核心不会启动。节点不可达时也不能算通过验收。离线输入和节点部署的完整步骤在同版本 Host 包的 `host/README.md`。

先保存了模型时，概览显示「需要执行节点」，CLI 提示模型**已保存、尚未应用**，不用重填。点「配置节点」启用节点，确认 Host 已连接后再验证聊天。

开始前一次问清：新装还是升级？服务器及 SSH 访问方式？客户端从哪访问（本机、专网、HTTPS 域名）？使用哪种模型接口、模型 ID、哪些客户端？密码和 API Key 由用户在管理页输入，不要贴到聊天、工单或日志。已有服务、域名、反向代理和防火墙不默认改动。升级演练、恢复演练和容量测试只在获准的专用非生产实例上做，不使用生产服务、数据卷或凭据。

服务器需 Python 3.10+、Docker 和 Compose v2，以及 Git 或解压好的 Host 包。Docker Engine 26.0+（API 1.45+）且 Compose 2.26.0+ 时，同机部署的 `up`、`update`、`recover` 会顺带开启「Bot 读记忆」：把五个记忆目录以只读方式挂进执行桌面，Bot 能查阅、不能修改；版本不够时提示并跳过这一项，部署照常进行。`doctor` 输出的 `memoryMounts` 表示能否开启。旧版 Engine 会忽略子路径、把整个 `host-data`（含模型 Key）挂进执行桌面，所以版本不够时不要手动加 `host/release/compose.memory.yaml`；`--host-only` 不挂这些目录。同机部署最低 2 核、4 GB 内存、30 GB 可用磁盘，推荐 4 核、8 GB、50 GB；构建缓存和备份另占空间，依据见[首页的服务器要求](../README.md#server-requirements)。ARM 同机还需注册 x86-64 QEMU/binfmt，安装或变更前请机主确认。

全新 Ubuntu 24.04 可从系统仓库安装 `docker.io docker-compose-v2 docker-buildx python3 git`，启用 Docker，让部署用户获得使用权限并重新登录。2026-11 实测它的更新源提供 Docker 29.1、Compose 2.40，满足要求；其他发行版的系统仓库可能较旧，改从 Docker 官方仓库安装 Engine、Buildx 和 Compose v2 插件。仅 ARM 同机模式还需 `qemu-user-static binfmt-support`，用 `sudo update-binfmts --enable qemu-x86_64` 启用解释器，再跑 `doctor`，它会核对版本。已有 Docker 的机器只补缺项；加入 `docker` 组相当于授予主机管理权限。

## 检查与启动

**下面两段示例用于 Host 与桌面同机的新装。桌面在另一台机器时，不要直接照抄：**首次检查用 `python3 host/deploy.py --host-only doctor`，首次初始化用 `python3 host/deploy.py --host-only init`。旧实例保留原项目名，先读[卷备份与恢复](#volume-recovery)。[分机部署](#split-host)的执行节点命令在同版本 Host 包 `host/README.md` 的「分开部署执行电脑」一节。

通过 SSH 工作时，用 Bash（Windows 可用 Git Bash）。每一段都是新会话，使用 `set -eu`，切到同一个代码目录；会读输入的命令加 `< /dev/null`。例如首次获取源码并检查：

```sh
ssh USER@SERVER 'bash -s' <<'EOF'
set -eu
mkdir -p "$HOME/grokbot"
git clone https://github.com/ferretgeek/prokbot-plus.git "$HOME/grokbot/src" < /dev/null
cd "$HOME/grokbot/src"
python3 host/deploy.py doctor < /dev/null
EOF
```

已有代码不要重复 clone。服务器不能访问 GitHub 时，在本机用 `git archive --format=tar.gz -o prokbot-host-src.tar.gz HEAD host`，只上传这个归档，解到新的源码目录；不要打包工作目录或私密文件。构建仍需访问固定原版来源和依赖源。

`doctor` 成功时输出 JSON：`ok: true`、Host 架构、桌面方式、`memoryMounts`、资源和数据卷；已有 `.env` 时还有网页版地址 `webClientUrl`，并检查管理页和网页版端口没有被其他容器或本机其他程序占用。`hostDataVolumes` 包括其他项目名下的 Host 卷。若发现已有实例，先确认原来的 `.env`、项目名和部署方式。仅在明确要升级服务端时才运行 `update`；只更新客户端请跳过服务器步骤。不要换项目名重装。探针失败不会下载大桌面。新装示例：

```sh
cd "$HOME/grokbot/src"
python3 host/deploy.py init < /dev/null
python3 host/deploy.py up < /dev/null
python3 host/deploy.py status < /dev/null
```

`init` 只写一次 `~/grokbot/.env`。默认仅本机 `http://127.0.0.1:18080` 可访问。网页版有自己的端口和网址，和管理页分开：端口默认是 `--port` 加 1（即 18081，`--web-port` 可改），`init` 输出的 `webClientUrl` 就是网页版地址。**远端手机不能用这个回环地址配对。** 在运行 `init` 前选择实际的连接方式：

- 已有 HTTPS 反向代理：给 `init` 加 `--public-url https://bot.example.org`（换成自己的域名）。代理转给服务器回环端口 18080 并支持 WebSocket；无需把 18080 开到公网。要用网页版，**必须给它单独一个入口**：建议用子域名（例如 `https://web.bot.example.org`）转给回环端口 18081，同样支持 WebSocket，并给 `init` 加 `--web-public-url https://web.bot.example.org`；不能用 `https://bot.example.org/web/` 这样的路径把网页版放在管理页网址下面。
- 专网 / 局域网：给 `init` 加 `--listen 服务器专网IP --public-url http://服务器专网IP:18080`，网页版就在 `http://服务器专网IP:18081/web/`。只绑定实际接口，只允许可信设备访问；不要在公网明文发送配对码或密码。
- 独立桌面：新装时用 `python3 host/deploy.py --host-only init`，之后工具会记住模式。自定义实例目录或项目名用 `--home`、`--project`，全局选项在命令前。旧的 `.env` 没有模式标记，独立部署每次都要传 `--host-only` 和原来的项目名。

<a id="91-windows-1011-x64"></a><a id="92-macapple-silicon"></a><a id="94-android-手机"></a>
## 模型与客户端

1. 在私有终端运行 `python3 host/deploy.py setup-key`，不要把输出转发到聊天。打开管理页，用初始化码设置 12–128 位管理员密码。该码仅首次使用，与设备配对码不同。
2. 独立桌面模式先在管理页连接执行节点。然后在「模型」里先添加每个模型服务（接口格式、地址、Key），再创建绑定服务和模型 ID 的模型档案。OpenAI Chat 和 Responses 通常填到 `/v1`，Anthropic Messages 可填根地址；按供应商实际接口选择。设置默认路由后，可为单个 Bot 覆盖主模型、思考强度和有序备用模型（切换规则见[技术文档](ARCHITECTURE.md#模型适配层)），不需要 Jev Key。逐个测试档案后再保存，等 Host 显示已连接。联网、生图、语音、推送按需配置，不是首次聊天的前提。
3. 管理页生成一次性六位配对码（5 分钟有效）。客户端输入与 `GROKBOT_PUBLIC_URL` 相同的地址和配对码。每台设备单独配对。Windows 和 Mac 连接页的 Tailcat 开关只在粘贴「远程访问」里的连接链接时打开，填专网或 HTTPS 地址时保持关闭。Android 和网页版不支持 Tailcat 链接，请用专网地址或 HTTPS。

<a id="client-packages"></a>
**选择客户端包**：各 ZIP 都含这份手册，但只含本平台所需的工具。下表的路径从对应 ZIP 的解压根目录算起，须取与 Host 匹配的补丁版本。其他包不含这些文件是正常的。

| 客户端 | 固定输入及对应包内手册 |
| --- | --- |
| Windows 10/11 x64 | Windows 包内 `windows/README.md`。默认用官方 1.2.3 x64 安装包生成便携版或安装器；1.2.3 用不了时加 `--version 1.1.0` 或 `--version 0.71.2` 回退。保留同包的 `mac/` 共用代码。 |
| Mac（Apple Silicon 或 Intel） | Mac 包内 `mac/README.md`。使用官方 1.2.3 原版，工具按本机芯片选择 Apple Silicon 或 Intel 版；本机图形控制还需 `--identity auto` 证书签名和系统授权。 |
| Linux 桌面（x64 或 ARM64） | Linux 包内 `linux/README.md`。使用官方 1.2.3 `.deb` 原包生成便携目录、`.tar.gz` 和用户级 `install.sh`（无需 root）；保留同包的 `mac/` 和 `host/bin/` 共用文件。Ubuntu 24.04+ 如遇 AppArmor 限制，可运行随包 `sudo …/setup-apparmor.sh`。 |
| iPhone | iOS 包内 `ios/README.md` 的「签名」。自备 1.27.0 (29519，推荐)、1.26.0 (29388，回退) 或 1.16.0 (23152，回退) 的已解密 IPA；按 `extension-signing.json` 为主应用和三个扩展配置各自的签名。 |
| Android 9+ | Android 包内 `android/README.md`。默认用官方 Windows 1.1.0 安装包（和 Windows 客户端同一个文件）的界面和项目外壳生成 APK，1.1.0 界面用不了时加 `--version 0.71.2`；不使用官方 Android APK；单独备份自己的签名密钥，升级须使用同一密钥。 |
| 网页版（任何浏览器） | 网页版包内 `web/README.md`。在电脑上用官方 Windows 1.1.0 安装包（和 Windows、Android 同一个文件）生成界面包，加 `--upload <GROKBOT_PUBLIC_URL>` 直接装到 Host 并启用（管理员密码经 `GROKBOT_ADMIN_PASSWORD` 传入），或在管理页「网页版」上传；1.1.0 界面用不了时加 `--version 0.71.2`。之后在各设备的浏览器打开网页版地址（`init`、`update` 输出的 `Web client`，默认是主机名加 18081 端口；经 HTTPS 反向代理时是 `GROKBOT_WEB_PUBLIC_URL`），输入配对码登录；旧的 `<GROKBOT_PUBLIC_URL>/web/` 会跳转过去。保留同包的 `android/`、`windows/`、`mac/` 共用代码。界面包含有官方界面，只装在机主自己的 Host 上，不要转发或公开。 |

准备原包前看首页的[客户端版本表](../README.md#client-versions)。官方商店和更新通道可能先行发布新版；工具只接受右栏固定输入。Android 外壳有自己的应用版本，和界面版本、最低 Android 系统版本不是一回事。

AI 可以用 `python3 host/deploy.py admin help` 查看同一套管理操作。管理员密码和模型 Key 通过 `GROKBOT_ADMIN_PASSWORD`、`MODEL_API_KEY` 环境变量传入，不放进命令参数；不要打印环境变量。`admin session` 查初始化，`admin status` 查核心是否连接，`admin model-set --test-only` 可用指定的格式、地址和模型测试而不保存。

**交付验收**：客户端发一句问题，再追问上一轮；让 Bot 在自己的执行桌面运行 `uname -m` 并读回结果，再打开桌面画面。三个结果分别证明对话、上下文、执行桌面，而不是只证明管理页可打开。在 ARM 同机模式，桌面应返回 `x86_64`，Host 的 `doctor` 应报告 `linux/arm64`。交付只记录地址、代码版本、模式、备份位置、通过和未通过的项目，不记录密钥。

<a id="附录-a日常运维"></a>
## 日常运维

在原来的源码目录运行：

| 操作 | 命令 |
| --- | --- |
| 查看状态 / 最近日志 | `python3 host/deploy.py status` / `python3 host/deploy.py logs` |
| 备份 | `python3 host/deploy.py backup < /dev/null`；输出备份目录，只交给机主 |
| 更新 | Git 安装先 `git pull --ff-only`；发布包解到新源码目录。获取成功后 `python3 host/deploy.py update < /dev/null` |
| 恢复 | 按下面的[卷恢复清单](#volume-recovery)准备新项目，不覆盖原卷 |

从 1.14.0 及更早的版本更新时注意两点：网页版改到自己的端口（`.env` 里没写 `GROKBOT_WEB_PUBLIC_PORT` 时是 18081，地址按 `GROKBOT_PUBLIC_URL` 的主机名推出），经 HTTPS 反向代理使用网页版的，更新前先给网页版配好单独入口，并在实例 `.env` 加上 `GROKBOT_WEB_PUBLIC_URL`；同一台机器上有多个实例时，各自的 `.env` 要写不同的 `GROKBOT_WEB_PUBLIC_PORT`，端口被占用时工具会在构建前拒绝。另外，1.7.0–1.14.0 的执行桌面以可写方式挂载记忆目录，`update` 会把它们换成只读。

更新先构建候选镜像，再停止原项目、备份卷并切换。启动候选失败时，先检查是否已确认停机；不能把旧镜像直接接回可能已迁移的卷。不要删除卷或运行 `down -v`。

<a id="volume-recovery"></a>
### 卷备份与恢复

备份目录含项目管理的数据卷归档和校验清单，**不含 Docker 镜像、实例目录的 `.env` 或宿主机系统**。同机部署归档 `host-data`、`box-home`、`box-workspace`；分机时 Host 只归档 `host-data`，执行节点的 `gateway-data`、`box-home`、`box-workspace` 要在另一台机器单独备份。卷可能包含配对凭据、模型 Key、会话和工作区文件；备份只交给机主私下保管。

1. 分别保留卷备份、原实例 `.env`、匹配的代码版本和镜像。清单 `serviceImages` 记录服务镜像的完整 ID，不是镜像内容；目标 daemon 必须已经有这些精确镜像，不能拿同名标签代替。
2. 确认原实例及其他 daemon 上同一身份的副本均已停机，分机备份时协调两端的写入。工具的项目锁只在同一 Docker daemon 生效；跨 daemon 的互斥和防止两份身份同时上线由操作者负责，无法确认时不要启动恢复实例。
3. 选择新的实例目录、项目名和卷，重建原拓扑及对外地址。Host 包 `host/README.md` 的「数据与备份」给出 `init`、`recover` 的完整示例和仅恢复卷的入口。启动后用原配对设备读回旧消息、附件和设置，再验证新对话与桌面。能解开归档不等于恢复成功。

<a id="附录-b故障排查"></a>
## 故障排查

| 现象 | 下一步 |
| --- | --- |
| `doctor` 连不上 Docker 或找不到 Compose | 查 daemon、当前用户权限、Compose v2。不要重装正常运行的 Docker |
| ARM 报 `exec format error` / 探针超时 | 区分镜像下载错误和架构错误；检查 binfmt 的 x86-64 解释器及 `F` 标志，重新跑 `doctor`，或改用独立 amd64 节点 |
| 发现旧卷、项目或 `.env` 冲突 | 找到原项目名和模式，使用 `update`。不要删除数据来消除报错 |
| 镜像摘要不匹配 | 核对固定版本与下载完整性；不要跳过哈希校验 |
| 管理页通、聊天不通 | 看 `logs` 和管理页模型测试；独立部署检查执行节点连接。`healthy` 不是模型验收 |
| 聊天通、桌面不通或很慢 | `status` 查 box；独立模式查第二台机器。ARM 模拟很慢时优先分开部署 |
| 地址不一致 / 配对失败 | 对照 `.env` 和客户端地址；检查反向代理与 WebSocket；重发配对码。遇 429 等一分钟 |
| 网页版打不开，或从 `/web/` 跳转后连不上 | 网页版用自己的端口（默认 18081）。检查防火墙和反向代理有没有给它入口，`.env` 的 `GROKBOT_WEB_PUBLIC_URL` 是否就是浏览器实际访问的地址；它不能和 `GROKBOT_PUBLIC_URL` 相同 |

客户端特有问题见上表对应平台说明。报告错误时附系统架构、代码版本、步骤和脱敏日志，不附密码、配对码或备份。
