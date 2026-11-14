# ProkBot Plus 部署手册

[English](AI-INSTALL.en.md) · [架构与扩展](ARCHITECTURE.md) · [备份恢复、离线输入与独立执行节点](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/host/README.md)

**给人和 AI 的同一条路线：选机器 → 检查 → 启动 → 配模型 → 客户端发消息。** 不要把容器显示 `healthy` 当作交付成功。下文的服务器命令从仓库根目录运行，Host 发布包解压后也是同样的结构。

**已有 Host、只更新客户端？** 跳过下面全部服务器命令。使用对应客户端 ZIP；保留现有 `.env`、项目名和数据卷，不运行 `init`、`up` 或 `update`。

## 先选部署方式

| 你有的机器 | 怎么部署 | 注意 |
| --- | --- | --- |
| 一台 x86_64 Linux | 默认，Host 和执行桌面都原生运行 | 已有实际对话验证的路线 |
| 一台 ARM64 Linux，例如 Oracle Ampere A1 | 默认，Host 原生运行，桌面经 QEMU 模拟 amd64 | **实验**。不是原生 ARM 桌面；先通过 `doctor`，实际速度取决于任务 |
| ARM64 Linux + 一台 amd64 Linux | 在 Host 的 `doctor`、`init` 前加 `--host-only`；桌面放第二台 | 推荐的 ARM 方案。A1 原生 Host 已验证聊天和桌面控制，无需在 ARM 机下载或模拟桌面。先看 [独立节点说明](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/host/README.md#分开部署执行电脑) |

开始前一次问清：新装还是升级？服务器及 SSH 访问方式？客户端从哪访问（本机、专网、HTTPS 域名）？使用哪种模型接口、模型 ID、哪些客户端？密码和 API Key 由用户在管理页输入，不要贴到聊天、工单或日志。已有服务、域名、反向代理和防火墙不默认改动。

服务器需 Python 3.10+、可访问的 Linux Docker daemon、Docker Compose v2（支持 `up --wait`）、Git 或解压好的 Host 包。同机桌面的早期规划预留为 8 GB 内存、Docker 数据盘 30 GB 空闲，不是持续负载下的实测最低值，首次要下载约 8 GB；模拟桌面应留更多余量。ARM 同机还需要系统注册 x86-64 QEMU/binfmt，安装或变更前请机主确认。

全新 Ubuntu 24.04 可从系统仓库安装 `docker.io docker-compose-v2 docker-buildx python3 git`，启用 Docker，让部署用户获得使用权限并重新登录。仅 ARM 同机模式还需 `qemu-user-static binfmt-support`，用 `sudo update-binfmts --enable qemu-x86_64` 启用解释器，再跑 `doctor`。已有 Docker 的机器只补缺项；加入 `docker` 组相当于授予主机管理权限。

## 检查与启动

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

`doctor` 成功时输出 JSON：`ok: true`、Host 架构、桌面方式、资源和数据卷。`hostDataVolumes` 包括其他项目名下的 Host 卷。若发现已有实例，先确认原来的 `.env`、项目名和部署方式。仅在明确要升级服务端时才运行 `update`；只更新客户端请跳过服务器步骤。不要换项目名重装。探针失败不会下载大桌面。新装示例：

```sh
cd "$HOME/grokbot/src"
python3 host/deploy.py init < /dev/null
python3 host/deploy.py up < /dev/null
python3 host/deploy.py status < /dev/null
```

`init` 只写一次 `~/grokbot/.env`。默认仅本机 `http://127.0.0.1:18080` 可访问。**远端手机不能用这个回环地址配对。** 在运行 `init` 前选择实际的连接方式：

- 已有 HTTPS 反向代理：给 `init` 加 `--public-url https://bot.example.org`（换成自己的域名）。代理转给服务器回环端口并支持 WebSocket；无需把 18080 开到公网。
- 专网 / 局域网：给 `init` 加 `--listen 服务器专网IP --public-url http://服务器专网IP:18080`。只绑定实际接口，只允许可信设备访问；不要在公网明文发送配对码或密码。
- 独立桌面：新装时用 `python3 host/deploy.py --host-only init`，之后工具会记住模式。自定义实例目录或项目名用 `--home`、`--project`，全局选项在命令前。旧的 `.env` 没有模式标记，独立部署每次都要传 `--host-only` 和原来的项目名。

<a id="91-windows-1011-x64"></a><a id="92-macapple-silicon"></a><a id="94-android-手机"></a>
<a id="client-packages"></a>
## 模型与客户端

仅更新客户端不需要重新部署服务端。先看[可接受的原包和外壳版本](../README.md#client-versions)；Android 用之前的签名密钥原地升级。使用发布包时，应使用同一包内文档，不能从旧标签的说明改装默认分支。

1. 在私有终端运行 `python3 host/deploy.py setup-key`，不要把输出转发到聊天。打开管理页，用初始化码设置 12–128 位管理员密码。该码仅首次使用，与设备配对码不同。
2. 独立桌面模式先在管理页连接执行节点。然后在「模型」里填接口地址、模型 ID、Key。OpenAI Chat 和 Responses 通常填到 `/v1`，Anthropic Messages 可填根地址；按供应商实际接口选择。先测试再保存，等 Host 显示已连接。联网、生图、语音、推送按需配置，不是首次聊天的前提。
3. 管理页生成一次性六位配对码（5 分钟有效）。客户端输入与 `GROKBOT_PUBLIC_URL` 相同的地址和配对码。每台设备单独配对。Android 不支持 Tailcat 链接，请用专网地址或 HTTPS。

| 客户端 | 生成与安装 |
| --- | --- |
| Windows 10/11 x64 | [Windows 说明](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/windows/README.md) |
| Mac（Apple Silicon） | [Mac 说明](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/mac/README.md) |
| iPhone | [iOS 补丁和签名](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/ios/README.md) |
| Android 9+ | [自开发 Android 客户端（非官方）](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/android/README.md) |

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
| 恢复 | [Host 备份与恢复](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/host/README.md#数据与备份)：恢复到新项目，原卷不覆盖 |

更新期间短暂暂停容器做备份，再构建并启动。备份或构建失败不会切换正在运行的容器；启动新容器失败不等于已自动回滚。不要删除卷或运行 `down -v`。更新成功后重复聊天和桌面验收。客户端有改动时才重新生成；Android 更新要保留第一次签名的密钥。

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

客户端特有问题见上表对应平台说明。报告错误时附系统架构、代码版本、步骤和脱敏日志，不附密码、配对码或备份。
