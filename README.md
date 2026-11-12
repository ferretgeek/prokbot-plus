<div align="center">

# ProkBot Plus

**把 Grok Bot 的服务端搬到你自己的服务器上，接你自己的模型。**

Windows · macOS · iOS 客户端补丁 ｜ [自开发 Android App（非官方）](#android-客户端) ｜ **Linux 服务端支持 x86_64 和 ARM64** ｜ OpenAI Chat / OpenAI Responses / Anthropic Messages

<p>
  <img alt="Windows 0.71.2" src="https://img.shields.io/badge/Windows-0.71.2_x64-0078D4?logo=windows&logoColor=white">
  <img alt="macOS 0.71.2" src="https://img.shields.io/badge/macOS-0.71.2-111111?logo=apple&logoColor=white">
  <img alt="iOS 1.16.0" src="https://img.shields.io/badge/iOS-1.16.0-111111?logo=apple&logoColor=white">
  <img alt="Android 9+" src="https://img.shields.io/badge/Android-9%2B-3DDC84?logo=android&logoColor=white">
  <img alt="Host d0a4baa" src="https://img.shields.io/badge/Host-d0a4baa-2496ED?logo=docker&logoColor=white">
  <img alt="Noncommercial License" src="https://img.shields.io/badge/License-Noncommercial-6B7280">
  <a href="https://linux.do"><img alt="LINUX DO" src="https://img.shields.io/badge/Community-LINUX%20DO-F5A623"></a>
</p>

**简体中文** · [English](README.en.md)

</div>

<p align="center">
  <img src="docs/images/windows-chat.png" alt="Windows 客户端：Bot 联网查询香山红叶的观赏时间并给出来源，同时画了一张 16:9 的水彩画" width="880">
</p>
<p align="center"><sub>Windows 客户端。一句话让 Bot 查资料、给出处，再顺手画一张图。模型、联网和生图都走你自己的接口。</sub></p>

ProkBot Plus 基于开源项目 [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) 修改。ProkBot 的思路是：原版 Grok Bot 的客户端和 Agent 都很好用，但它只能连官方云端。它把服务端（Host 和执行用的 Linux 桌面）用 Docker 跑在你自己的机器上，再给原版客户端打补丁，让客户端连到你的服务器。

Plus 在此基础上补了这些：**Windows 和 Android 客户端**；**Anthropic Messages 和 OpenAI Responses 两种模型接口**（上游只支持 OpenAI Chat）；以及让联网搜索、生图、本机命令在实际使用中跑顺的一批修复。

> 这是非官方项目，与 xAI 及 Grok Bot 官方没有任何关系。仅限非商业使用，详见[许可与声明](#许可与声明)。

## 能做什么

- **用原版的 Grok Bot。** 界面、Agent、工具调用、记忆、定时任务、操作审批都是原版的，只是服务端在你自己手里。
- **接任何支持工具调用的模型。** Claude、GPT、DeepSeek、Grok，或者各种聚合网关。三种接口格式任选，思考强度从 `none` 到 `max` 都能设。也可以让 Jev 分类器按任务难度自动选模型。
- **让 Bot 在它自己的电脑上干活。** 服务端自带一台 Linux 桌面，Bot 在上面跑命令、开浏览器、处理文件。
- **让 Bot 操作你的电脑。** Mac 支持命令和图形界面控制；Windows 支持本机命令，每次执行前会弹窗问你。
- **联网和生图。** 用模型自带的联网能力搜索、读网页；用 OpenAI 兼容的图片接口生图，支持按比例出图和拿参考图修改。
- **数据留在自己的机器上。** 对话、文件、记忆、Bot 资料都存在你的服务器上，遥测和自动更新已关闭。
- **在手机上用。** iOS 和 Android 客户端：Bot 回复时收到通知，还能看 Bot 电脑的实时画面、接手操作。
- **在外面也能用。** 局域网直连、内置的 Tailcat 组网（不需要公网 IP），或者你自己的 HTTPS 域名。

## 支持的系统

| 部分 | 支持 | 说明 |
| --- | --- | --- |
| 服务端 | Linux x86_64 或 ARM64 | x86_64 已在 Ubuntu 24.04 + Docker 29 实测。甲骨文 Ampere A1 原生运行 Host、搭配独立 amd64 桌面，已验证两轮聊天和 VNC 操作。只有一台 ARM 机器时，模拟桌面仍属实验模式。[选部署方式](docs/AI-INSTALL.md#先选部署方式) |
| Windows 客户端 | Windows 10 / 11，x64 | **本版本新增。** 便携版和安装包，不需要管理员权限 |
| Mac 客户端 | Apple Silicon，Grok Bot 0.71.2 | 来自上游 |
| iOS 客户端 | Grok Bot 1.16.0（23152） | 来自上游。需要自备砸壳 IPA 和签名证书 |
| Android 客户端 | Android 9 及以上 | **本版本新增。** 用官方桌面版的界面加本项目的外壳生成 APK，在 Windows、Mac 或 Linux 电脑上生成 |
| Linux 桌面 | 不支持 | 官方没有对应的客户端 |

## 这个版本新增了什么

### Windows 客户端

<table>
  <tr>
    <td width="36%"><img src="docs/images/windows-connect.png" alt="Windows 客户端首次连接：填写 Host 地址和配对码"></td>
    <td><img src="docs/images/windows-approve.png" alt="Bot 要在 Windows 电脑上执行命令前，弹出允许一次、始终允许、从不的确认卡片"></td>
  </tr>
  <tr>
    <td><sub>第一次打开时填 Host 地址和 6 位配对码。</sub></td>
    <td><sub>Bot 要在你的电脑上执行命令时，先问你。</sub></td>
  </tr>
</table>

上游只有 Mac 和 iOS。Windows 版用官方 0.71.2 Windows 安装包加补丁生成，界面和官方 Windows 版一致：

- 托盘常驻、系统通知、附件、Tailcat；
- 本机命令执行（PowerShell，中文输出不会乱码）；
- 把复杂编程交给本机的 Codex；
- 生成便携版和安装包两种形式。

补丁由 Mac 版移植而来，每一段都校验过结构。

### Android 客户端

**这是 ProkBot Plus 自开发的 Android App，不是 xAI 官方 Android 版，也不是对官方 Android APK 打补丁。**

<p align="center">
  <img src="docs/images/android-chat-zh.png" alt="Android 客户端真实聊天：用户问番茄蛋炒饭先炒什么，饭点回复先炒蛋；用户追问米饭结块怎么办，饭点建议用湿手捏散。" width="380">
</p>
<p align="center"><sub>Android 15 模拟器实拍：在 App 里问「先炒什么」，再追问「那米饭结块了怎么办」。两轮回复均由连接到自部署 Host 的模型实际生成。</sub></p>

官方 Android 版带有防篡改保护，不能修改。Plus 换了一种做法：把官方**桌面版**的界面（和 Windows、Mac 客户端同一套，取自你自己下载的官方 Windows 安装包）装进一个本项目编写的 Android 外壳，生成 APK：

- 对话、Bot 管理、技能、资料库、例行任务和设置都是原版界面，照官方手机版的样子重新排版：Bot 列表和对话分成两屏，圆形悬浮按钮、消息气泡、配色和字体都和官方手机版一致，详情、设置和搜索全屏打开，菜单和对话框从底部弹出；支持返回键和深色模式；
- 在手机上看 Bot 电脑的实时画面，「取得控制权」后用触摸和软键盘操作；
- 上传手机里的文件，把 Bot 发来的文件保存到手机；
- 后台通知不依赖 Google 推送服务，点通知直接打开对应的 Bot；
- 设备凭据用 Android Keystore 加密保存，网页里拿不到。

APK 用只属于你的密钥签名。不支持 Tailcat，外网使用请用 VPN、内网穿透或 HTTPS 域名。详见 [Android 客户端](android/README.md)。

### 三种模型接口

<p align="center"><img src="docs/images/admin-model.png" alt="管理页的对话模型设置：接口格式、Base URL、API Key、默认模型和思考强度" width="760"></p>

上游只支持 OpenAI Chat Completions。Plus 加了 **Anthropic Messages** 和 **OpenAI Responses**，三种格式都完整支持：图片、文件、工具调用、思考强度、多轮推理接续。

- 对话中途换模型、换格式不会出错。
- 服务商不支持某个可选参数时，自动去掉再试。
- 自动安全审查也能用这三种格式。

### 联网和生图

<table>
  <tr>
    <td><img src="docs/images/admin-web.png" alt="联网工具设置：用 Claude Opus 5.5 的原生联网能力搜索和抓取网页"></td>
    <td><img src="docs/images/admin-media.png" alt="图片与视频设置：默认图片模型 GPT Image 2.6 Sunburst"></td>
  </tr>
</table>

原版的联网和生图工具，上游已经接上了，但用新版模型时有不少问题。Plus 修了这些：

- 新版 Claude 不接受强制调用工具，联网直接失败 → 自动改成普通调用；
- 并行搜索中有一路超出次数，整次搜索都被判失败 → 只要有一路成功就用；
- Bot 说「画一张 16:9 的图」时，OpenAI 图片接口报错 → 自动换算成对应的尺寸；
- 带参考图修图会报错 → 改走修图接口。

### 其他修复

- **消息顺序。** 原版 Bot 会把回复拆成几条短消息发出。上游的实现里，这几条消息的先后可能被打乱，短的先到；现在严格按模型写的顺序送达。
- **自动审查。** 模型偶尔不按格式回答时，原来会直接拒绝操作，而且日志里什么都没有。现在会重试一次，失败会记日志。
- **Linux 部署。** Docker 29 默认改用 containerd 镜像存储，上游的构建脚本会报错，现在已兼容。
- **命令行管理。** 新增 `host/tools/host-admin.mjs`，不打开网页也能初始化、配模型、生成配对码，方便脚本和 AI 操作。
- **文档。** 新增一份能力一般的模型也能照着做的 [AI 部署手册](docs/AI-INSTALL.md)。

完整改动见 [CHANGELOG](CHANGELOG.md) 和 [技术文档](docs/ARCHITECTURE.md)。

## 和官方 Grok Bot 比

**好处**

- 用你自己选的模型和服务商，费用按你自己的接口计费，也可以用中转或聚合网关。
- 对话、文件、记忆都在你自己的服务器上，没有遥测。
- 在官方服务用不了的地方也能用；只在局域网里用也可以。
- 多了一些官方没有的东西：
  - 可以修改系统提示词，并随时恢复原版；
  - 按模型设置上下文长度；
  - 用量统计；
  - Webhook 触发任务；
  - 自己写应用（插件）；
  - 多台 Host 之间的 Bot 协作；
  - 整机备份恢复。

**代价**

- 要有一台 Linux 服务器（8 GB 内存、30 GB 磁盘起步），自己负责升级和备份。
- 版本是固定的：客户端 0.71.2、iOS 1.16.0、Host `d0a4baa`。官方更新后，要等补丁跟进才能升级，也没有自动更新。
- 效果取决于你选的模型。官方针对自家模型做过调校，换成别的模型，体验可能有差距。
- 部分官方功能被关掉或换掉：
  - 关掉的：虚拟卡、外部消息草稿、产品反馈、通行密钥转发；
  - 换掉的：语音、推送、生图视频等，要你自己准备服务商；
  - 实时通话目前是实验功能。
- 客户端没有代码签名：Windows 首次打开会有 SmartScreen 提示；iOS 要自己签名安装；Android 要允许安装未知来源的应用。
- Windows 版还不能让 Bot 操作鼠标键盘，原版的这部分组件只有 macOS 版本。
- Android 版不支持 Tailcat；后台通知靠一个常驻的连接，部分手机要在系统设置里允许它后台运行。
- 修改官方客户端可能违反官方的用户条款，风险自负。

## 部署需要什么

| 必需 | 要求 |
| --- | --- |
| 服务器 | 64 位 Linux、Docker Compose v2、Python 3.10+。同机运行桌面建议至少 8 GB 内存、30 GB 空闲磁盘，首次下载约 8 GB；ARM 单机还需要 QEMU/binfmt |
| 模型接口 | 任意一种：Anthropic Messages、OpenAI Responses、OpenAI Chat Completions。要支持工具调用；想让 Bot 操作电脑，还要支持图片输入 |
| 生成客户端的电脑 | Windows 客户端在 Windows 10/11 x64 上生成，Mac 客户端在 Apple Silicon Mac 上生成，Android 客户端在 Windows、Mac、Linux 上都能生成，都需要 Node.js 22.12+。iOS 需要砸壳 IPA 和签名证书 |

| 可选 | 用途 |
| --- | --- |
| 支持原生联网的模型 | Bot 搜索、读网页（例如 Claude 的 `web_search`） |
| OpenAI 兼容的图片接口 | Bot 生图、修图 |
| Bark 或 Apple 推送证书 | iPhone 推送（Android 不需要） |
| 语音识别和合成服务 | 语音输入、实时通话 |
| 域名和 HTTPS | 不用 Tailcat 时的外网访问 |

## 安装

最省事的办法是交给一个能执行命令的 AI（Claude Code、Codex、Cursor 等都可以）。把下面这段发给它：

```text
请帮我部署 ProkBot Plus：https://github.com/ferretgeek/prokbot-plus
先完整阅读仓库里的 docs/AI-INSTALL.md，然后严格按里面的步骤做。
先问我现有机器、是否已有实例、模型和访问方式。先运行 doctor；不要删除数据卷、公开密钥或把容器启动当成验收。最后用客户端验证两轮聊天和桌面操作。
```

AI 会先列出你要准备的东西，然后一步步部署服务端、配置模型、生成客户端，最后验收。

想自己动手的话，照着 [AI 部署手册](docs/AI-INSTALL.md) 做就行。它是写给 AI 的，但每一步都写了命令和检查方法，人照着做也完全没问题。

[Releases](https://github.com/ferretgeek/prokbot-plus/releases) 按平台分发补丁工具。`v1.0.0` 不含 ARM64 Host 和 Android 工具；部署 ARM64 请使用 `main` 分支，生成 Android App 见 [Android 客户端说明](android/README.md)。Releases **不提供**包含官方程序的成品客户端。

## 文档

| 文档 | 内容 |
| --- | --- |
| [AI 部署手册](docs/AI-INSTALL.md) | 从零部署的完整步骤，每一步都写了「应该看到什么」和「失败了怎么办」 |
| [技术文档](docs/ARCHITECTURE.md) | 原理、每个功能怎么实现、Plus 改了什么、目录、测试、二次开发入口和已知限制 |
| [Windows 客户端](windows/README.md) · [Mac 客户端](mac/README.md) · [iOS 客户端](ios/README.md) · [Android 客户端](android/README.md) | 各平台补丁的用法 |
| [分开部署、备份与应用开发](host/README.md) | 进阶用法 |

## 友情链接

- [LINUX DO](https://linux.do)：新的理想型社区。ProkBot Plus 的交流和发布都在这里，有问题、有想法欢迎来社区聊。

## 许可与声明

- 本项目源自 [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot)（基于其 2026-11-05 版本，提交 `3e9fe8c`），沿用它的 [ProkBot 非商业许可证 1.0](LICENSE)。
  - 可以个人使用、学习、修改和非商业分发；
  - 不能用于任何商业用途，包括收费部署、付费服务和企业内部使用。
  - 来源和修改清单见 [NOTICE](NOTICE)。
- 仓库里没有任何 Grok Bot 官方程序，也不提供成品客户端 APK 或 IPA。`android/dist/` 只包含自开发的空外壳；桌面界面从你自己下载并校验的 Windows 安装包中提取。
- Grok、Grok Bot 及相关商标归各自权利人所有。本项目与他们没有关联，也没有得到他们的认可。
- 本项目大部分代码由 AI 辅助编写，按现状提供，不提供任何担保。
- 发现安全问题请看 [SECURITY.md](SECURITY.md)，参与贡献请看 [CONTRIBUTING.md](CONTRIBUTING.md)。
