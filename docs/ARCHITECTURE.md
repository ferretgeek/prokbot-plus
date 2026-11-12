# 技术文档

[English](ARCHITECTURE.en.md)

这份文档说明 ProkBot Plus 的原理、每个功能是怎么实现的、本版本在上游 ProkBot 之上改了什么，以及目录、测试、二次开发入口和已知限制。部署步骤见 [AI 部署手册](AI-INSTALL.md)。

## 原理

原版 Grok Bot 的服务端在官方云端，分两部分：Host 负责对话、调度 Agent 和保存记录；云电脑是一台 Linux 桌面，Agent 在上面实际操作。

这个项目把两部分都搬到你自己的机器上，尽量直接使用原版程序：

- **Host**：原版 Node.js 程序，只替换和官方服务绑定的部分，外面再加一层管理服务。
- **执行电脑**：官方 Linux 桌面镜像，原样运行在 Docker 里。也可以让 Agent 操作你自己的电脑。
- **客户端**：原版界面不变，补丁让它只连接你的 Host。

```mermaid
flowchart LR
  Win[Windows 客户端] --> Admin
  Mac[Mac 客户端] --> Admin
  iOS[iOS 客户端] --> Admin
  And[Android 客户端] --> Admin
  subgraph Host 容器
    Admin[管理服务 :8000<br/>登录 / 配对 / 配置 / 代理] --> Core[原版 Host 127.0.0.1:1340<br/>Agent / 工具 / 上下文]
    Core --> Adapter[模型适配层]
  end
  Adapter --> Model[你的模型接口<br/>Chat / Responses / Anthropic]
  Core --> Box[box 容器<br/>官方 Linux 桌面]
  Core -.经客户端反向连接.-> PC[你的 Mac / Windows 电脑]
  Admin --> Push[APNs / Bark]
  Admin <--> Tailcat[Tailcat 内置组网]
```

## 维护地图

在完整仓库运行 `node ci/check-inputs.mjs` 查看各平台实际使用的版本并核对输入。版本和摘要由构建工具读取的清单决定，不以 README 徽章为准。

| 想改什么 | 从哪里开始 | 必须一起验证什么 |
| --- | --- | --- |
| 部署方式、升级、备份 | `host/deploy.py` → `host/release/`；容器内启动在 `host/deploy/supervisor.mjs` | 新装与带旧卷升级分别测试；Host CPU 架构和桌面 CPU 架构分别验证 |
| 更新原版 Host 或桌面 | `host/recipes/host/manifest.json` 和同目录补丁；ARM 原生依赖锁在 `host/release/arm-runtime/` | 摘要校验、生成补丁、目标镜像、旧卷启动、实际对话和桌面 |
| 新增服务端功能 | `host/server/` 负责管理 API、持久化与页面；`host/runtime/` 负责原版 Agent 和模型行为 | 管理页保存后，客户端对话是否真的用上设置 |
| 更新桌面 / 手机 | Mac 与 Windows 共用 `mac/clients/desktop/`；Windows 解包器和 recipe 也是 Android 的输入；iOS 独立 | 每个平台的 `supported.json` 或 recipe 清单、签名、配对。共享代码改动要测所有使用方 |
| 增加可选能力 | 先看能否做成应用或技能：[应用开发](../host/README.md#应用开发)；只有需要改变 Host 行为才改运行时 | 安装、授权、调用和移除；不修改官方程序或把它带进发布包 |

## 功能对照

🟢 保留原版　🔁 换成你自己的服务　⛔ 已关闭

| 功能 | 原版 | 这里 | 你需要准备 |
| --- | --- | --- | --- |
| 🔁 登录 | 官方账号 | 不需要账号。Host 管理页生成 6 位配对码，客户端输入 Host 地址和配对码即可连接 | — |
| 🔁 Host 和执行电脑 | 官方云端 | Host 按服务器架构构建，执行桌面保持原版 | amd64 / arm64 Linux，amd64 桌面可独立部署 |
| 🔁 对话模型 | 官方模型，自动选择等级 | 自选模型，支持 OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages 三种接口格式。可以让 Jev 分类器自动选择模型和思考强度 | 模型接口地址和 API Key |
| 🟢 电脑和浏览器操作 | 原版 Agent | 保留原版 | 支持视觉能力的模型 |
| 🟢 记忆、上下文压缩、定时任务 | 原版 Agent，部分依赖官方服务 | 保留原版，改用你的模型和本地计时，上下文压缩可自行设置 | — |
| 🟢 操作审批、人工接管、交互表单 | 原版 | 保留原版 | — |
| 🔁 自动审查 | 官方分类服务 | 用你的模型判断操作能不能执行，允许和阻止规则可以自己写 | — |
| 🔁 演示任务（Teach a task） | 官方服务整理 | 录制保留原版，整理成技能用你的模型 | 支持视觉能力的模型 |
| 🔁 操作你的电脑 | 经官方服务 | 经你的 Host，电脑不需要开放端口。Mac 支持命令与图形控制；Windows 支持本机命令 | 签名后的 Mac 客户端，或 Windows 客户端 |
| 🔁 Bot 资料库、用户资料 | 官方云存储和账号 | 保存在 Host 上，所有设备看到的一样 | — |
| 🔁 技能 | 官方技能目录 | Host 自己的技能目录，可以查看版本、对比和恢复 | — |
| 🔁 连接应用 | 官方应用市场 | Host 自己的应用目录，可以导入代码应用、远程 MCP 或纯技能，支持 OAuth、API Key 授权；Bot 也能自己编写应用 | 应用自己的凭据 |
| 🔁 复杂编程 | 官方云端编程 Agent | 交给已连接的 Mac 或 Windows 电脑上的 Codex，使用这台电脑的 Codex 登录和模型 | 安装并登录 Codex CLI 的电脑 |
| 🔁 Bot 和技能分享 | 官方发布平台 | 发布到自己的 Host，可导出 ZIP，在别的 Host 导入 | — |
| 🔁 多个 Bot 协作 | 官方服务 | 把任务交给其他 Host 上的 Bot，结果回到你的对话 | 另一个 Host |
| 🔁 语音输入 | 官方转写 | Fish Audio、OpenAI 兼容的转写服务，或 Mac 上的本地模型 | 转写服务的 Key 或本地模型 |
| 🔁 实时通话 | 官方实时语音模型 | 识别和合成分别接你选的服务（实验功能） | 识别和合成服务 |
| 🔁 图片和视频生成 | 官方服务 | OpenAI 兼容的图片接口（支持按画面比例出图和参考图修图）、WaveSpeed 等 | 供应商的 Key |
| 🔁 联网搜索 | 官方搜索 | Claude 或 OpenAI Responses 模型自带的联网能力，或单独配置的 DeepSeek、HTTP JSON 搜索服务 | 可选 |
| 🔁 手机推送 | 官方推送 | iOS：安装包签名带推送权限时用 APNs，否则用 Bark。Android：App 自己保持与 Host 的连接接收通知 | iOS 需要 Bark App，或 Apple 开发者账号和 APNs 密钥（.p8） |
| 🔁 外网访问 | 直接连官方云端 | IP 地址、Tailscale、HTTPS 反向代理，或内置的 Tailcat | 视情况准备域名 |
| ⛔ 遥测和错误上报 | 发给官方 | 已关闭 | — |
| ⛔ 自动更新 | 官方更新 | 已关闭，补丁固定在支持的版本 | — |

原版的这些功能目前没有提供：虚拟卡、外部消息草稿、产品反馈和通行密钥转发。

上游 ProkBot 还新增了这些原版没有的功能：

| 功能 | 说明 |
| --- | --- |
| **应用** | 一个 JSON 文件就是一个应用，可以带代码、远程 MCP 服务或技能。代码应用运行在执行电脑上。Bot 也可以用内置的「编写应用」自己写应用。见[应用开发](../host/README.md#应用开发) |
| **Webhook** | 外部系统发一个签名请求，Bot 就开始执行任务 |
| **用量统计** | 每天用了多少 Token，在管理页和 iOS 设置里都能看到 |
| **提示词管理** | 可以修改系统提示词并随时恢复原版，还能看到每个角色实际收到的提示词和工具 |
| **按模型设置上下文** | 每个模型的容量和开始摘要的时机可以单独设置 |
| **管理网页** | 所有设置都在浏览器里完成，支持中英文、深浅色和手机屏幕 |
| **分开部署** | Host 和执行电脑可以放在不同的机器上，见 [host/README.md](../host/README.md#分开部署执行电脑) |
| **备份恢复** | 备份全部数据，恢复成一个新的实例 |

## 各部分的实现

### 补丁方式

补丁工具从你提供（或自动下载）的原版文件里复制字节，加入本项目的修改，生成新的客户端或镜像。补丁只有「复制」和「新增」两种操作，每一段都校验原文件哈希，不反编译、不重写原版程序。

### Host 与管理服务

原版 Host 是一个 Node.js 程序。本项目只替换了和官方服务绑定的四个部分：身份验证、Agent 身份、模型调用和 MCP 配置；原版定时任务由官方后端触发，这里补上了本地计时。原版 Host 外面是管理服务，负责管理员登录、设备配对、各类配置和推送，并把客户端请求转给原版 Host。

- **`host` 容器**：管理服务监听 8000，映射到宿主机 `${GROKBOT_LISTEN_ADDRESS:-127.0.0.1}:${GROKBOT_PUBLIC_PORT:-18080}`。原版 Host 只监听容器内的 `127.0.0.1:1340`。
- **`box` 容器**：官方 Linux 桌面，VNC 端口只在容器网络内可见。

| 数据 | 内容 |
| --- | --- |
| 卷 `host-data`（`/data`） | 管理员（`auth.json`）、设备、Bot、对话记录、用量统计、各类配置。模型 Key 在 `model.env`，联网配置在 `web-services.json`，图片配置在 `media.json` |
| `/data/setup-key` | 初始化码，初始化完成后自动删除 |
| 卷 `box-home`、`box-workspace` | 执行电脑的家目录和工作区 |

| `.env` 变量 | 说明 |
| --- | --- |
| `GROKBOT_LISTEN_ADDRESS` | 端口绑定地址，默认 `127.0.0.1` |
| `GROKBOT_PUBLIC_PORT` | 宿主机端口，默认 `18080` |
| `GROKBOT_PUBLIC_URL` | 对外地址。客户端配对时校验地址是否一致，管理接口的 Origin 也以它为准；只能是整个域名或 IP，不能带路径 |
| `TZ` | 时区，影响定时任务和用量统计 |

管理接口的安全措施：

- 管理员密码用 scrypt 哈希保存（12–128 位），登录后用 Cookie 会话；
- 非 GET 请求必须带 `x-grokbot-csrf: 1`，带 `Origin` 时必须和对外地址一致；
- 登录、初始化、模型测试按 IP 限流，每分钟 5 次；
- 配对码 6 位，5 分钟内有效，只能用一次；配对后设备拿到独立令牌，可以在管理页吊销。

命令行管理工具 `host/tools/host-admin.mjs`（本版本新增）封装了常用的管理接口：初始化、列出模型、配置并测试模型、生成配对码、查看状态。

### 模型适配层

原版的模型请求发给官方分类器，由官方决定用哪个模型。本项目在 Host 发出请求前接手：把原版 Harness 的消息转换成三种接口之一，再把流式回复转换回原版格式。工具调用、子 Agent、上下文管理仍是原版逻辑。上游只支持 OpenAI Chat，**Responses 和 Anthropic 两种格式是本版本新增的**。

| 文件 | 职责 |
| --- | --- |
| `host/runtime/model-session.mjs` | 入口，按 `apiFormat`（`openai` / `openai-responses` / `anthropic`）分派 |
| `host/runtime/openai-chat.mjs` | Chat Completions，地址后接 `/chat/completions` |
| `host/runtime/openai-responses.mjs` | Responses，地址后接 `/responses`，无状态调用 |
| `host/runtime/anthropic-messages.mjs` | Messages，地址写根地址或 `/v1` 都可以 |
| `host/runtime/model-common.mjs` | SSE 解析、错误归一、图片和文件转换、推理来源标记、可选参数回退 |
| `host/runtime/model-policy.mjs` | 思考强度档位和各模型的参考档位表 |
| `host/runtime/model-router.mjs` | 手动模式，或 Jev 按任务难度选模型和强度 |
| `host/server/models.mjs` | 保存配置、读取模型列表、连接测试（和正式对话走同一条代码路径） |

| 能力 | OpenAI Chat | OpenAI Responses | Anthropic Messages |
| --- | --- | --- | --- |
| 思考强度 | `reasoning_effort`；DeepSeek 另加 `thinking` 开关 | `reasoning.effort`，附推理摘要和加密推理 | Claude 4.6 起用自适应思考加 `output_config.effort`，更早的型号用思考预算；不能关闭思考的型号把 `none` 换成 `low` |
| 多轮推理接续 | 回传同一模型的 `reasoning_content` | `store: false`，回传加密推理 | 回传带签名的思考块 |
| 图片和文件 | 图片、PDF、文本文件 | 工具结果中直接带图，PDF | 工具结果中直接带图，PDF 和文本文档 |
| 输出上限 | 自动在 `max_completion_tokens` 和 `max_tokens` 之间选择 | `max_output_tokens` | 按型号上限 |

- **思考强度**：档位有 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，以及 `default`（不发送强度参数）。某个模型支持哪些档位，优先用接口 `/models` 返回的值，没有时用内置参考表。
- **推理来源标记**：不同格式、不同模型的推理内容互相读不了。每段推理在 `providerOptions.grokbot` 里记下格式和模型，回放时只回放当前格式、当前模型能读的部分，所以对话中途切换模型不会出错。没有摘要的加密推理和空的思考块保存成 `redacted-reasoning`，回放时再还原。
- **可选参数回退**：服务商用 400 拒绝某个可选参数（例如 `reasoning.summary`、`max_tokens`、`fallbacks`）时，去掉它重试一次，在本次会话内记住，并在日志里打印 `[model] … retrying without …`。回放的推理失效时同样处理。
- **已知网关问题**：有的聚合网关用 Responses 格式转发 Claude 时，只要请求带工具就返回 `native_thinking_replay_mismatch`。这是网关的问题，Claude 请用 Anthropic 格式。

### 自动审查

Bot 要在执行电脑或你的电脑上做有风险的操作时，原版会先问官方的分类服务。这里改为用你配置的模型来判断，沿用原版的分类提示词和结果格式（`host/runtime/host-auto-review.mjs`）。三种接口格式都支持。

本版本补了两点：

- 模型偶尔不按要求回答（没有调用分类工具、JSON 不完整、字段不合法），会自动重试一次，仍失败才拒绝这个操作。服务商报错和取消不重试。
- 每次失败都在 Host 日志里写一行 `Local auto-review failed: <原因>`。原版的失败是静默的。

### 联网与生成图片

原版的 `WebSearch`、`WebFetch`、`GenerateImage` 三个工具由 Host 提供服务，没有配置服务商时不会出现。

| 文件 | 作用 |
| --- | --- |
| `host/runtime/web-services.mjs` | 联网适配器：`anthropic-tools`（模型自带的 `web_search` / `web_fetch`）、`responses-search`（Responses 的 `web_search`，只能搜索）、`deepseek-tools`、`http-json` |
| `host/server/media-providers.mjs` | 图片适配器：`openai-images`、`wavespeed`、`http-json`；`mediaInput` 把工具参数转换成请求体 |
| `host/runtime/media-services.mjs` | 生成任务记录、结果落盘、防止重复提交 |

本版本的改动：

- **新版 Claude 也能联网**：开启思考的 Claude 不接受强制工具调用。`anthropic-tools` 收到这类 400 后改用自动调用，在提示词里要求调用工具，并对这个模型记住这个选择。
- **并行搜索容错**：Claude 常同时发出两路搜索，超出次数的那一路返回 `max_uses_exceeded`。原逻辑因此判整个搜索失败，现在只要有一路成功就采用。
- **画面比例换算成尺寸**：原版工具传的是 `aspect_ratio`，OpenAI 图片接口只认 `size`。Host 从模型参数定义的 `size` 列表里选比例最接近的一项，没有列表时用 `1024x1024`、`1536x1024`、`1024x1536`。Bot 明确写了 `parameters.size` 时以它为准。
- **参考图修图**：`openai-images` 收到参考图时，改为 multipart 请求 `/images/edits`（字段名 `image[]`）。

图片模型的参数定义是可选的进阶配置，写在 `PUT /admin/api/media` 的 `models[].inputSchema` 里。不写时，比例会换算成三种标准尺寸，也能接收参考图：

```json
{
  "id": "gpt-image-2", "providerId": "images", "model": "gpt-image-2", "kind": "image", "enabled": true,
  "name": "GPT Image 2", "description": "文生图与参考图修图。需要高清时 quality 用 high。",
  "parameters": { "size": "1024x1024", "quality": "high" },
  "inputSchema": { "type": "object", "additionalProperties": false, "properties": {
    "prompt": { "type": "string" },
    "images": { "type": "array", "items": { "type": "string" }, "maxItems": 10 },
    "size": { "type": "string", "enum": ["auto", "1024x1024", "1536x1024", "1024x1536", "1536x1152", "1152x1536", "1536x864", "864x1536"] },
    "quality": { "type": "string", "enum": ["auto", "low", "medium", "high"] }
  } }
}
```

- 写了参数定义时，只有含 `images` 属性的模型才接收参考图；接口不支持修图的模型不要写它。
- `size` 列表里要同时有横版和竖版，比例换算才有得选。
- 联网和图片供应商的地址一律以 `/v1` 结尾，包括 `anthropic-tools`，这和对话模型的 Anthropic 根地址不同。

### 多条消息的送达顺序

原版提示词要求 Bot 像发短信一样回复：先一句确认，再把结论和补充分成 2–4 条 `SendToUser` 消息。原版的模型输出是流式的，每个工具调用写完就执行，消息自然按顺序到达。

本项目的模型层要等整段回复结束，才把工具调用一次性交给 Harness，这样流中途出错重试时不会重复执行工具。但可靠性层 `host/runtime/reliability/tool-journal.mjs` 执行每个工具前要先把执行意图写入磁盘，几条消息同时启动时，谁先写完谁先发出。

`host/runtime/reliability/tool-order.mjs`（本版本新增）记下每次回复里 `SendToUser` / `SendToAgent` 的书写顺序，让每条消息等上一条执行完再开始，其他工具照常并行；前一条始终没执行时最多等 15 秒，取消时立即停止等待。

### 执行电脑

原版每个用户有一台官方云电脑。这里直接使用同一个官方 Linux 桌面镜像，在你的 Docker 里运行，Host 通过带认证的连接操作它。执行电脑可以和 Host 放在同一台机器，也可以放到另一台。想让 Agent 操作你的电脑时，客户端会主动连到 Host，所以你的电脑不需要开放任何端口。

### Mac 客户端

原版 Mac 客户端是 Electron 应用。这里保留原版界面，重写了负责连接和系统功能的主进程（`mac/clients/desktop/`，Windows 版也用它），让它只连接你的 Host。复杂的编程任务交给这台 Mac 上的 Codex，用的是本机的 Codex 登录和模型。

- 默认 ad-hoc 签名。要让 Agent 控制本机图形界面，需要用自己的证书签名（`--identity auto`），并授予辅助功能和屏幕录制权限。
- 输出放在 `.noindex` 目录，避免 Spotlight 把它收录成重复的 App。

### Windows 客户端（本版本新增）

官方同版本的 Windows 客户端和 Mac 版用同一套 Electron 界面代码，差异只在构建编号、资源文件名、模块顺序和少数换行。

**补丁流程**（`windows/patchers/desktop/patch.mjs`）：

1. 下载 `Grok_Bot_0.71.2_Setup.exe` 并校验 SHA-256，也可以用 `--source` 指定安装包、`app-64.7z` 或已安装的目录。
2. 从 NSIS 安装包中切出 `app-64.7z`，用 Windows 11 自带的 `tar.exe` 解压（Windows 10 用 7-Zip）。
3. 解开 `resources/app.asar`，主进程换成共用的 `mac/clients/desktop` 代码。
4. 执行 `recipes/` 中的字节补丁。
5. 重新打包 ASAR，不打包的 `.node` 等文件与原版逐个比对。
6. `Grok Bot.exe` 内嵌了 ASAR 头的 SHA-256，补丁原位替换这个值，并移除因此失效的官方签名。
7. 附加 `grokbot-tailcat.exe`，输出便携目录、便携 zip、安装包和 `*.patch.json` 清单。

**Recipe 移植**（`windows/tools/port-desktop-recipes.mjs`）：由 Mac recipe 和两个平台的原版文件自动生成。逐段对齐两个平台的原文件，复制的内容全部取自 Windows 原文件，导出标识符按平台翻译，每一段都做语法结构校验。

**运行时的平台差异**：

- **窗口**：沿用原版无边框窗口，用 `titleBarOverlay` 显示系统标题栏按钮（`platform.mjs`）。
- **托盘与通知**：关闭窗口后留在通知区域；系统通知通过带 AppUserModelID 的开始菜单快捷方式投递。
- **电脑连接**：机器 ID 为 `win-<设备ID>`，Host 显示平台 `win32`。
- **本机命令**：
  - 用原版的执行程序。正常启动时它用 Windows PowerShell 执行命令。
  - 原版没有打开 PowerShell 的 UTF-8 输出选项，中文 Windows 上的输出会乱码。客户端加载执行程序时把这个原版选项打开（`local-exec.mjs` 的 `loadLocalExecDaemon`）。
  - 从 Git Bash 里启动客户端时，原版会改用 Git Bash，`cmd /c` 这类参数会被改写，所以要从开始菜单启动。
- **显示 Host 上的图片**：Host 记录的图片地址形如 `file:///data/...`。Windows 版按 POSIX 规则解析它（`attachments.mjs` 的 `remoteAttachmentPath`），否则图片会一直显示加载中。
- **Codex 委派**：查找本机 `codex.exe`（包括 npm 安装的 Codex），结束时用 `taskkill /T` 终止整个进程树。
- **不支持本机鼠标键盘控制**：原版的电脑操作组件只有 macOS 版本。

**安装器**（`windows/installer/`，Go 标准库）：

- 安装包结构是 `stub.exe` + 便携 zip + 32 字节尾部。
- 按用户安装到 `%LOCALAPPDATA%\Programs\Grok Bot Local`，注册卸载项，创建开始菜单快捷方式；支持 `/S` 和 `/D=目录`。
- 重新生成 stub：在 `windows/installer/` 执行 `go build -trimpath -ldflags="-H=windowsgui -s -w" -o ../dist/installer/grokbot-setup-stub.exe .`。
- 重新生成 Windows 版 Tailcat：在仓库根目录执行 `python host/network/build-tailcat.py --target windows-amd64 --output windows/dist/network`（需要 Go）。

### Android 客户端

官方 Android 版（`ai.x.grok.bot` 1.16.0）是 React Native 应用，带有 Google Play 的防篡改保护，改动后无法运行；绕过这种保护不在本项目的范围内。所以 Android 客户端不改官方 Android 版，而是在手机上运行官方**桌面版**的界面（和 Windows、Mac 客户端同一套），由本项目编写的 Android 外壳代替 Electron。

**外壳**（`android/shell/`，Kotlin，不依赖第三方库；`android/dist/grokbot-android-shell.apk` 是它的预编译版本）是一个全屏 WebView，加上这些部分：

- **本地网关**（`LocalGateway.kt`），只监听 `127.0.0.1`：
  - 界面端口（39710 起）提供界面文件和 `/__native/*` 原生接口，并把 `/api`、`/events`、`/local`、`/connect`、`/notifications` 转发给 Host，由网关加上设备令牌；
  - 电脑画面端口（39720 起）只转发 `/vnc/desktop/`、`/vnc/fork/` 下的 noVNC 页面和 WebSocket；
  - 两个端口都校验每次启动随机生成的 HttpOnly、SameSite=Strict Cookie，界面端口还校验 Host、Origin 和 Sec-Fetch-Site；
  - 设备令牌只在原生层，网页拿不到。Host 出错时返回 502，而不是让页面收到空响应。
- **凭据**（`Storage.kt`）：设备令牌用 Android Keystore 中的 AES-GCM 密钥加密保存；设置和界面的持久化数据放在应用私有目录。
- **通知**（`Notifications.kt`）：一个前台服务跟随 Host 的 `/notifications/events`（iOS 客户端读的同一个事件流），按创建时间去重，正在看的 Bot 不重复提醒。点击通知通过 `grokbot-local://agent/<id>` 打开对应的 Bot。开机和升级后自动恢复；设备被吊销时提示重新配对。通知文字跟随 App 内选择的语言。
- **系统功能**：文件选择、系统保存对话框、麦克风权限、返回键、深色模式和系统栏颜色、屏幕安全区域。

**桥接**（`android/client/`）在 WebView 里代替 Electron 的主进程和 preload：

- `bridge.js` 模拟 `ipcRenderer`、`contextBridge` 和 `process`，原样运行官方的 `preload.cjs`；
- `services.js`、`gateway.js` 移植了桌面客户端主进程（`mac/clients/desktop/`）里的本地方法：附件分块上传、文件保存、资料、语音、设置、连接应用等；
- `webview.js` 用 iframe 代替 Electron 的 `<webview>`：
  - 电脑画面页面由网关从 Host 转发，网关在 noVNC 页面的同一目录注入 `vnc-bridge.js` 和官方的 `preload-vnc.cjs`（官方 preload 交给 `executeJavaScript` 的代码按页面地址导入 noVNC 模块）；
  - `executeJavaScript`、`send`、`insertCSS` 和 `ipc-message` 通过 postMessage 实现，只接受本应用界面的消息；
  - iframe 跟随界面设置的 `pointer-events`，所以只有「取得控制权」后才能用触摸和软键盘操作 Bot 的电脑；
  - 桌面客户端用的是精简版 VNC preload，这里用官方版，所以手机上也有输入法字段、剪贴板和自适应画质；
- `layout.js`、`android.css` 照官方手机版的样子排版，颜色、尺寸和字体取自官方手机版的设计参数：
  - 窗口宽度小于 600 px 时，Bot 列表和对话是两个全屏页面。`layout.js` 根据点按 Bot、搜索、新建或删除 Bot、新建群聊和通知决定显示哪一页，在对话页加返回按钮，返回键在对话页回到列表；按下「创建」后等 Host 建好 Bot 再进入它的对话；
  - 返回、账户、搜索、新建和加号是圆形悬浮按钮，对话顶部是 Bot 名字的胶囊；气泡、输入框、列表行和底部面板的尺寸与配色按官方手机版；字体用桌面版界面自带的 XVF；
  - 列表页不显示市场按钮，`layout.js` 在账户菜单里加一个市场入口；列表每行的最后活动时间由 `layout.js` 格式化（今天显示时刻，其次是「昨天」、星期和日期）；
  - 对话详情、设置、市场和搜索全屏显示，其他对话框、菜单和选项从底部弹出；看图和大画面黑底全屏；
  - 宽度 600 px 以上沿用桌面排版；对话详情在 792 px 以下是全屏层，打开大画面时让开；
  - 隐藏在 Android 上没有意义的设置（硬件加速、本机访问、Tailcat）；宽图片按列宽缩放；
- `anchor-fallback.js`：Chromium 125 以前的 WebView 不支持 CSS 锚点定位，电脑画面会缩成 0。兼容代码记录锚点名称和位置表达式，在布局后换算成像素。

**生成工具**（`android/patchers/patch.mjs`）：

1. 下载并校验官方 `Grok_Bot_0.71.2_Setup.exe`（和 Windows 客户端同一个文件），解出 `app.asar`，执行 Windows recipe。
2. 校验界面入口、`preload.cjs`、`preload-vnc.cjs` 的 SHA-256，再执行 `renderer-patches.mjs` 中的界面修改，每个文件先校验哈希、每个锚点必须唯一：
   - 放宽对话详情的窗口宽度判断（手机不能把窗口加宽）；
   - 去掉「教 Bot 做任务」和「获取手机版」两个入口；
   - 给电脑画面的锚点样式附加兼容代码读取的自定义属性；
   - Bot 列表每行显示最后活动时间。
3. 把界面、桥接代码、官方 preload（包装成 ES 模块和普通脚本）和官方图标放进外壳 APK 的 `assets/web/`。
4. 按 zipalign 的规则对齐，用 APK 签名方案 v2 签名（`apk.mjs`，纯 Node 实现）。签名密钥在第一次生成时创建，保存在 `~/.grokbot-local/android-signing.json`。

**配对**：Android 发送 `platform: desktop` 和 `clientKind: android`。新版 Host 将新配对的手机保存为 Android 设备，不授予桌面执行权限；旧 Host 忽略附加字段，仍可配对。中文输入法打出的全角字符会先转成半角。

**和桌面版的差异**：不支持 Tailcat；不能在手机上执行命令或操作手机（`getLocalToolPermission` 返回 `never`）；没有「教 Bot 做任务」。

### iOS 客户端

原版 iOS 客户端用 React Native 开发。这里写了一个注入的动态库（Objective-C，源码在 `ios/clients/ios/`，用 `build.py` 编译），把原本发往官方的请求转到你的 Host，再对 Hermes 字节码做少量固定修改。小组件、分享和通知三个扩展保留，使用独立的 Bundle ID。补丁输出未签名的 IPA，主应用和三个扩展都要自己签名（见 [ios/README.md](../ios/README.md#签名)）。

iOS 字节码补丁（`ios/recipes/ios/*.hbc.gbp.gz`）是上游作者生成的数据：补丁内容完整公开，但修改字节码的过程没有附在上游仓库里。

### 语音

实时通话原本用官方的实时语音模型。这里保留原版的通话界面、麦克风和播放逻辑，把对话改成三步：识别服务把你的话转成文字，当前 Bot 用自己的模型、上下文和工具回答，再由合成服务读出来。

### 推送和外网访问

Host 可以直接给 Apple 推送服务（APNs）发通知，这需要有推送权限的 Apple 开发者账号和 .p8 密钥；没有的话用 Bark。

访问 Host 可以只在局域网、用 VPN、配置 HTTPS 反向代理，最方便的是内置的 Tailcat。Tailcat 基于 Tailscale 的开源组网组件，内置在客户端、Host 和执行电脑里，复制连接链接或扫码即可连接，不需要登录 Tailscale。

### 技能、应用、分享和协作

原版的技能目录、应用市场、Bot 模板发布和多 Agent 协作都依赖官方平台。这里在 Host 上各做了一份，并尽量沿用原版界面：应用市场列表、技能发布菜单、Bot 发布卡片都是原版界面，只是数据来自你的 Host。代码应用和 Webhook 是新增的，接入了原版的工具和自动任务。

## 目录与关键文件

| 路径 | 内容 |
| --- | --- |
| `host/deploy.py` | 对外部署入口；识别实例、预检、初始化、升级前备份和状态。与容器内的 `host/deploy/` 不同 |
| `host/release/` | `build-docker.py` 下载校验原版并构建 `grokbot-host:local`；`patch-host.py`、`bytepatch.py` 应用 Host 补丁；`compose*.yaml` 部署；`backup.py` 备份恢复；`Dockerfile.*` |
| `host/server/` | 管理服务：认证、配对、推送、各类配置、管理网页（`public/`） |
| `host/runtime/` | 注入原版 Host 的运行时：模型适配层、联网与图片、自动审查、可靠性层（`reliability/`） |
| `host/deploy/` | 容器内的进程管理、独立执行节点 |
| `host/tools/host-admin.mjs` | 命令行管理工具 |
| `host/network/` | Tailcat 的 Go 源码与构建脚本；`host/bin/` 是预编译的 Linux 版 |
| `host/tests/` | 服务端单元测试 |
| `mac/clients/desktop/` | 桌面客户端主进程，Mac 与 Windows 共用：连接、配对、通知、附件（`attachments.mjs`、`attachment-uploads.mjs`）、外部链接与预览、本机命令（`local-exec.mjs`）、Codex 委派；平台差异集中在 `platform.mjs`。`*-settings-extension.js` 是 recipe 加进原版设置页的代码的源码，改了要重新制作 recipe 才生效。Android 客户端也复制其中的 `i18n.mjs`、`external-url.mjs`、`connectors.mjs` |
| `mac/patchers/desktop/` | Mac 补丁、recipe 应用器、原版下载器（`download-original.mjs`），Windows 补丁也用它 |
| `windows/patchers/desktop/` | Windows 补丁：`patch.mjs`、`original.mjs`（解压官方安装包，Android 也用）、`pe.mjs`（图标、ASAR 完整性、签名表）、`zip.mjs`、`recipes/` |
| `windows/tools/`、`windows/installer/`、`windows/dist/` | Recipe 移植工具、安装器源码、预编译的 Tailcat 和安装器 stub |
| `android/shell/` | Android 外壳（Kotlin）：本地网关、凭据、配对、通知、文件和返回键；`release-shell.mjs` 构建 `android/dist/grokbot-android-shell.apk` |
| `android/client/` | WebView 里的桥接：代替 Electron 主进程和 preload、电脑画面、布局调整、锚点兼容、连接页 |
| `android/patchers/` | Android 生成工具：`patch.mjs`、`apk.mjs`（ZIP 与 APK 签名）、`renderer-patches.mjs`、`supported.json` |
| `ios/release/` | iOS 补丁入口 `patch-ios.py`：校验用户 IPA，输出未签名文件 |
| `ios/clients/ios/` | 注入库源码、原生界面与功能适配（例如 `GBNetwork.m` 的隧道管理、`GBVoiceSocket.m` 的语音传输）；`audio-processing/` 是回声处理库 |
| `*/recipes/` | 从原版文件复制字节并加入本项目修改的补丁数据 |
| `*/THIRD_PARTY/` | 第三方许可证 |

## Linux 部署要点

- `host/release/platforms.py` 识别 **Docker 服务端**架构；`host/recipes/host/manifest.json` 是原版 Host、桌面和补丁的输入清单。两种架构走同一套补丁。amd64 Host 保留原版镜像基底；ARM64 用 Node 22、锁定的 ARM 原生模块和按架构编译的 Tailcat。官方桌面始终是 `linux/amd64`。
- ARM 同机先运行隔离的小型 amd64 容器，失败时不下载大桌面。独立桌面模式跳过模拟检测，ARM Host 不下载桌面。原版镜像接受固定的清单或配置摘要；离线输入校验配置摘要及导入后的身份。
- ARM 验证分两层：Ubuntu 24.04 ARM64 虚拟服务器通过两种 `doctor` 预检，包括实际执行 amd64 容器；隔离的 ARM64 Node 运行环境中，原版 Host 核心已连接原版 amd64 执行服务，验证了设备配对、Bot 列表、绘图和本地测试模型的流式回复。后一环境不含完整桌面，不能证明多轮客户端聊天或 VNC 可用。
- 在 Windows 上检出或上传的代码会丢掉可执行权限，所以 `Dockerfile.base` 和 `Dockerfile.execution` 复制 Tailcat 程序后会再 `chmod 755`，Mac 补丁也会给输出里的 Tailcat 加上可执行权限。
- Docker 发布的端口不经过 ufw。需要限制访问时，改 `GROKBOT_LISTEN_ADDRESS`，或在网络边界上限制。
- 备份期间会暂停容器，健康检查可能短暂失败，属于正常现象。

## 测试

```sh
node --test "host/tests/*.test.mjs"      # 服务端
node --test "windows/tests/*.test.mjs"   # Windows 客户端
node --test "mac/tests/*.test.mjs"       # Mac / 共用客户端
node --test "android/tests/*.test.mjs"   # Android 客户端
```

iOS 注入库的网络层另有一项测试，要在装了 Xcode 命令行工具的 Mac 上运行：`python3 ios/tests/ios-network.test.py`。

覆盖范围：

- **服务端**：三种格式的请求构造、流解析、推理回放、参数回退、错误分类，以及：
  - 图片比例换算和参考图修图；
  - 联网工具的回退和并行容错；
  - 自动审查的重试；
  - 消息顺序。
- **Windows 客户端**：窗口样式、安装包结构、Codex 查找、Host 图片路径、命令输出编码。
- **Mac 客户端**：附件、外部链接、预览、侧栏等。
- **iOS 网络层**：Tailcat 隧道的启动（并发请求只启动一次）、恢复、连接异常后的重建和关闭。
- **Android 客户端**：APK 对齐、签名和防篡改校验，签名密钥，界面入口和界面补丁，官方 preload 的包装，Host 附件路径，电脑画面地址，事件流解析，锚点位置换算，图片缩放，手机上列表和对话两页的切换规则，列表时间的格式。

改动代码后，建议再做一次真实验证：

- 用 `host-admin.mjs model-set --test-only` 对各格式发起真实请求；
- 在客户端完成一次带工具调用的多轮对话；
- 让 Bot 搜一条新闻、读一个网页、画一张 16:9 的图，再基于这张图改一处。

**ARM 发布验收**：选一台获准测试的空闲 ARM64 Linux，不复用生产卷。按[部署手册](AI-INSTALL.md)做同机新装，记录 `doctor` 的 Host 架构、桌面模式、构建是否完成。用客户端配对、两轮聊天并在桌面创建一个无敏感内容的文件，打开 VNC 看见它；运行 `backup`、`update`，确认对话和文件都还在。记录服务器型号、冷启动时间和桌面响应体验。单独的 Host 核心、预检探针或模型测试均不能替代这组结果。

## 二次开发入口

升级原版的顺序：先运行 `node ci/check-inputs.mjs` 查看当前清单，再更新对应平台的 `supported.json` / `manifest.json` 和 recipe。重新运行检查与四套测试，用自己下载的固定输入构建，在客户端验证聊天和工具；不发布原版程序。改 Host 还需在目标架构重建镜像。下面的表只列修改入口，不另设第二份版本表。

| 需求 | 位置 |
| --- | --- |
| 新增模型接口格式 | 在 `host/runtime/` 新建适配文件，实现和 `openai-chat.mjs` 相同形态的生成器，再在这些地方注册：`model-session.mjs`、`host-auto-review.mjs` 的 `CLASSIFIERS`、`host/server/models.mjs`、管理页 `host/server/public/model.js` |
| 调整模型的思考档位 | `host/runtime/model-policy.mjs` 的 `effortLevels`；Claude 型号特性在 `anthropic-messages.mjs` |
| 修改管理页 | `host/server/public/`，英文文案在 `locales-en.js` |
| 修改桌面客户端 | `mac/clients/desktop/`（Mac 与 Windows 共用，Android 用到其中三个文件） |
| 修改 Android 客户端 | 桥接在 `android/client/`；外壳在 `android/shell/`，改完执行 `node android/shell/release-shell.mjs` 更新预编译外壳和摘要（需要 JDK 17+ 和 Android SDK） |
| 支持新的官方客户端版本 | 更新 `supported.json` 的哈希；Mac recipe 要重新制作，Windows recipe 用 `windows/tools/port-desktop-recipes.mjs` 移植；Android 还要更新 `android/patchers/supported.json` 和 `renderer-patches.mjs` |
| 应用（插件）开发 | [host/README.md](../host/README.md#应用开发) |

## 已知限制与待办

- 只支持构建清单里的固定版本，官方更新后要更新补丁；没有自动更新。
- Windows 客户端：
  - 还不能让 Bot 控制鼠标键盘；
  - 没有代码签名，首次打开会有 SmartScreen 提示；
  - 只支持 x64；
  - Tailcat 和实时语音还没有和真实 Host 联调过。
- Android 客户端：
  - 不支持 Tailcat；
  - 排版照官方手机版，但页面内容是桌面版的：设置是「通用 / 电脑 / 更新」等标签页，市场的分类和内容与桌面版相同，对话页没有官方手机版右上角的电脑按钮（Bot 的电脑从对话详情打开）；
  - 后台通知靠一个前台服务保持连接，部分厂商系统需要允许后台运行；
  - 语音输入和实时通话只验证到请求送达 Host，还没有和真实的语音服务联调；
  - 在 Android 15 模拟器（WebView 124）上做了完整测试，在 Android 16 模拟器（WebView 134）上验证了配对、通知权限和界面布局，还没有在真机上测试。
- 原版桌面只有 amd64。ARM 同机执行桌面为实验模式，未在 Oracle A1 实机完成聊天、桌面和性能验收。
- iOS 需要自备砸壳 IPA 和签名证书；耳机、蓝牙与网络切换场景还没有在真机上充分验证。
