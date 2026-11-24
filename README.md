<div align="center">

# ProkBot Plus

**在自己的服务器上运行 Grok Bot，用你自己选的模型。**

<p>
<!-- client-badges:start -->
  <a href="#client-versions"><img alt="Windows 官方 1.3.0 x64 (此补丁不支持)" src="https://img.shields.io/badge/Windows%20%E5%AE%98%E6%96%B9-1.3.0%20x64%20(%E6%AD%A4%E8%A1%A5%E4%B8%81%E4%B8%8D%E6%94%AF%E6%8C%81)-0078D4?logo=windows&logoColor=white"></a>
  <a href="#client-versions"><img alt="Windows 补丁接受 1.2.3 x64（推荐）、1.1.0、0.71.2" src="https://img.shields.io/badge/Windows%20%E8%A1%A5%E4%B8%81%E6%8E%A5%E5%8F%97-1.2.3%20x64%EF%BC%88%E6%8E%A8%E8%8D%90%EF%BC%89%E3%80%811.1.0%E3%80%810.71.2-237E55?logo=windows&logoColor=white"></a>
  <a href="#client-versions"><img alt="Linux 官方 1.3.0 x64 / ARM64 (此补丁不支持)" src="https://img.shields.io/badge/Linux%20%E5%AE%98%E6%96%B9-1.3.0%20x64%20%2F%20ARM64%20(%E6%AD%A4%E8%A1%A5%E4%B8%81%E4%B8%8D%E6%94%AF%E6%8C%81)-237E55?logo=linux&logoColor=white"></a>
  <a href="#client-versions"><img alt="macOS 官方 1.3.0 ARM64 / Intel" src="https://img.shields.io/badge/macOS%20%E5%AE%98%E6%96%B9-1.3.0%20ARM64%20%2F%20Intel-111111?logo=apple&logoColor=white"></a>
  <a href="#client-versions"><img alt="iOS 官方 1.28.0" src="https://img.shields.io/badge/iOS%20%E5%AE%98%E6%96%B9-1.28.0-111111?logo=apple&logoColor=white"></a>
  <a href="#client-versions"><img alt="Android shell 1.1.0" src="https://img.shields.io/badge/%E8%87%AA%E5%BC%80%E5%8F%91%20Android-1.1.0-237E55?logo=android&logoColor=white"></a>
  <a href="#client-versions"><img alt="网页版 1.1.0" src="https://img.shields.io/badge/%E7%BD%91%E9%A1%B5%E7%89%88-1.1.0-237E55?logo=googlechrome&logoColor=white"></a>
<!-- client-badges:end -->
  <img alt="Noncommercial License" src="https://img.shields.io/badge/License-Noncommercial-6B7280">
  <a href="https://linux.do"><img alt="LINUX DO" src="https://img.shields.io/badge/Community-LINUX%20DO-F5A623"></a>
</p>

**简体中文** · [English](README.en.md)

</div>

<p align="center">
  <img src="docs/images/hero-zh.jpg" alt="三端截图：左边是 Windows 客户端，Bot 联网查资料并画了一张图；中间是浏览器里的网页版；右边是 Android App 上的对话">
</p>

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/images/card-search.jpg" alt="Windows 客户端：Bot 联网查香山红叶的观赏时间，列出来源，再画一张水彩画"><br><b>联网查资料、画图</b><br><sub>列出来源，图直接出现在对话里。</sub></td>
    <td width="50%" valign="top"><img src="docs/images/card-approve.jpg" alt="Bot 要在 Windows 电脑上执行命令前，弹出始终允许、允许一次、从不的确认卡片"><br><b>在你的电脑上执行命令</b><br><sub>Windows 客户端，执行前先问你。</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/images/card-phone-zh.jpg" alt="手机上的 Bot 列表，以及和「旅行规划」的对话，Bot 用表格排了杭州两日行程"><br><b>手机上用</b><br><sub>按官方手机版排版，Android App 和网页版共用这套界面。</sub></td>
    <td valign="top"><img src="docs/images/card-tablet-zh.jpg" alt="iPad 横屏打开网页版：左边是 Bot 列表，右边是代码助手写的 Python 脚本"><br><b>平板和任何浏览器</b><br><sub>网页版随屏幕自动排版，用配对码登录。</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/images/card-models-zh.jpg" alt="Host 管理页的对话模型：anthropic 和 openai-responses 两个模型服务，以及两个模型档案"><br><b>用你自己的模型</b><br><sub>Anthropic、OpenAI Responses、OpenAI Chat 三种接口，每个 Bot 可以单独选模型和备用模型。</sub></td>
    <td valign="top"><img src="docs/images/card-pair-zh.jpg" alt="Android App 首次连接：填写 Host 地址和 6 位配对码"><br><b>配对码连接</b><br><sub>填 Host 地址和管理页生成的 6 位配对码就能连上。</sub></td>
  </tr>
</table>
<p align="center"><sub>截图均为演示数据。</sub></p>

## 这是什么

Grok Bot 是 xAI 的 AI 助手应用。它的 Bot 除了聊天，还有自己的一台 Linux 电脑，能跑命令、开浏览器、处理文件，有记忆和定时任务。原版只能连官方云端。

[ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) 把服务端用 Docker 搬到你自己的服务器上，再给官方客户端打补丁，让它连你的服务器。**ProkBot Plus** 在此基础上增加了：

- **更多客户端**：Windows 客户端、Linux 桌面客户端（x64 / ARM64）、自开发的 Android App 和网页版（浏览器打开就能用）；
- **更多模型接口**：Anthropic Messages、OpenAI Responses、OpenAI Chat 三种格式，可以给每个 Bot 指定主模型、思考强度和备用模型；
- **修好的功能**：联网搜索、生图、消息顺序、自动审查等；
- **部署工具**：一条命令检查、启动、升级、备份，另有一份 AI 能照着做的部署手册。

界面、工具调用、记忆、定时任务和操作审批都是原版的。对话、文件和记忆存在你的服务器上，遥测和自动更新已关闭。

> 非官方项目，与 xAI 无关，仅限非商业使用，见[许可与声明](#许可与声明)。

<a id="server-requirements"></a><a id="部署需要什么"></a>
## 服务器要求

模型走 API，**服务器不需要显卡**，只运行两个容器：Host 和 Bot 用的 Linux 电脑。

| | 最低 | 推荐 |
| --- | --- | --- |
| CPU / 内存 | 2 核 / 4 GB | 4 核 / 8 GB |
| 硬盘可用空间 | 30 GB | 50 GB |
| 系统 | 64 位 Linux，Docker 26+ 和 Compose 2.26+，Python 3.10+ | Ubuntu 24.04（系统仓库的 Docker 就够） |

- 2 核 4 GB 和 4 核 8 GB 都从零部署实测可用；2 核 2 GB 实测不够。适合个人或家庭使用，多人同时高强度使用没测过。
- 平时占用：Host 约 0.7 GB 内存，Bot 的电脑约 0.8 GB（最高 1.7 GB）；镜像约 13 GB。
- x86_64 最省事。ARM64 机器（例如甲骨文 A1）可以只跑 Host，Bot 的电脑放另一台 x86_64；也可以在 ARM 上模拟运行，但明显更慢，属于实验功能。当前版本没在 ARM 上重新实测。

还需要：一个支持工具调用的模型接口（想让 Bot 操作电脑，模型还要能看图）；一台装了 Node.js 22.12+ 的电脑来生成客户端；你自己下载的官方安装包。联网搜索、生图、语音、推送和 HTTPS 域名都是可选的。

## 客户端

<a id="client-versions"></a>
<!-- client-versions:start -->
**下载哪个版本的官方安装包？** 按右栏下载，补丁只认这些版本。列了两个版本时先用推荐的新版，用不了再换旧版。左栏是官方当前最新版（2026-11-25 核对），比右栏新时要等本项目适配。

| 平台 | 官方最新版 | 本项目需要的版本 |
| --- | --- | --- |
| Windows x64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand)（此补丁不支持） | **1.2.3**（推荐）；用不了再用 1.1.0、0.71.2 |
| Linux x64 / ARM64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand)（此补丁不支持） | 1.2.3（尚未适配 1.3.0；.deb 原包；已在 WSL2 的 Ubuntu 22.04 x64 上实测，原生桌面和 ARM64 未实测） |
| macOS ARM64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand) | 1.2.3（尚未适配 1.3.0；未在 Mac 真机上测试） |
| macOS Intel (x64) | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/darwin-x64/sand) | 1.2.3（尚未适配 1.3.0；已在 Intel Mac 上实测 1.2.3 可用） |
| iOS | [1.28.0](https://apps.apple.com/us/app/grok-bot/id6794501026)（此补丁不支持） | 1.27.0（构建 29519；已在 iPad 上验证连接、发消息和 App Intent） |
| Android 9+（自开发，非官方） | 不用官方 Android 版 | App **1.1.0**（构建 10100），界面取自 Windows **1.1.0** 安装包（推荐；用不了再用 0.71.2） |
| 网页版（浏览器，非官方） | 不用安装 | 界面取自 Windows **1.1.0** 安装包（推荐；用不了再用 0.71.2），生成后上传到你的 Host |
| Linux 服务端 | 不适用 | Host `d0a4baa`；Bot 的电脑 `9d2ac1b`（x86_64） |

ProkBot Plus 自己的版本号见[最新发布](https://github.com/ferretgeek/prokbot-plus/releases/latest)；上游 ProkBot 基线是 `3e9fe8c`。
<!-- client-versions:end -->

| 客户端 | 系统要求 | 说明 |
| --- | --- | --- |
| Windows | Windows 10 / 11 x64 | 本项目新增。便携版或安装包，不需要管理员权限。Bot 可以在你的电脑上执行命令，执行前先问你。已在 Windows 11 上实测。 |
| Linux | Linux x64 / ARM64 桌面 | 本项目新增。便携目录、`.tar.gz` 与用户级安装脚本，不需要 root 权限。支持 Tailcat、本机命令和 Codex，不支持鼠标键盘图形控制；在 WSL2 的 Ubuntu 22.04 x64 上实测过，原生 Linux 桌面和 ARM64 还没实测。 |
| Android | Android 9+，系统 WebView 89+ | 本项目自开发的 App，不是官方 Android 版。在 Android 15 / 16 模拟器上测过，未经真机测试。 |
| 网页版 | 新版 Chrome、Edge、Firefox、Safari | 由你的 Host 提供，手机、平板、电脑自动适配，用配对码登录。只操作 Bot 的电脑，不操作你本机。 |
| Mac | Apple 芯片或 Intel 芯片 | 支持官方 1.2.3 的 Apple 芯片与 Intel 芯片（Intel 1.2.3 已在 Intel Mac 真机实测可用，Apple 芯片 1.2.3 已通过证书签名构建校验）。 |
| iPhone / iPad | 自备已解密的 IPA 和签名证书 | 支持官方 1.27.0（构建 29519，推荐），可回退 1.26.0 和 1.16.0。贡献者在 iPad 上实测了 1.27.0 的升级、配对、对话和附件，iPhone 还没有完整测试。 |

<a id="android-客户端"></a><a id="web-client"></a>
**Android App** 不改官方 Android 版（它有防篡改保护），而是把官方桌面版的界面装进本项目写的外壳：能看 Bot 电脑的实时画面并接手操作，收通知不依赖 Google 推送。APK 用你自己的密钥签名。

**网页版** 在电脑上生成界面包、上传到 Host 后，任何设备的浏览器打开 `Host 地址/web/` 输入配对码就能用，也能添加到主屏幕。从外网访问请用 HTTPS。详见[网页版说明](web/README.md)。

## 安装

最省事：把下面这段发给一个能执行命令的 AI（Claude Code、Codex、Cursor 等）：

```text
请帮我部署 ProkBot Plus：https://github.com/ferretgeek/prokbot-plus
先完整阅读仓库里的 docs/AI-INSTALL.md，然后严格按里面的步骤做。
先问我现有机器、是否已有实例、模型和访问方式。先运行 doctor；不要删除数据卷、公开密钥或把容器启动当成验收。最后用客户端验证两轮聊天和桌面操作。
```

自己动手就照着[部署手册](docs/AI-INSTALL.md)做：服务器上 `doctor` → `init` → `up` → `status`，然后在管理页填模型、生成配对码，用客户端连接。

[最新版本](https://github.com/ferretgeek/prokbot-plus/releases/latest)提供 Host、Windows、Mac、Linux、iOS、Android、网页版七个工具包，下载需要的那个。工具包里没有官方程序，客户端要在你自己的电脑上用官方安装包生成。

## 和官方比

**好处**：模型和服务商自己选；数据在自己手里，只在局域网用也行；多了一些官方没有的功能，比如改系统提示词、用量统计、Webhook、自写应用、备份恢复。

**代价**：

- 要自己维护一台 Linux 服务器；
- 客户端版本固定，官方出新版要等本项目适配，没有自动更新；
- 效果取决于你选的模型；
- 虚拟卡、外部消息草稿、通行密钥转发等官方功能已关闭，语音、推送、生图要自己准备服务商；
- 官方网站上别人分享的 Bot（x.ai/bot/… 页面的「Add to Grok Bot」）不能添加，这些模板存在官方云端；Bot 只能在 Host 之间用 ZIP 分享；
- 客户端没有代码签名：Windows 会有 SmartScreen 提示，iPhone 要自己签名，Android 要允许安装未知来源应用；
- Windows 和 Linux 版的 Bot 能执行命令，但还不能操作鼠标键盘；
- 修改官方客户端可能违反官方用户条款，风险自负。

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署手册](docs/AI-INSTALL.md) | 部署、配置模型、生成客户端、日常运维、备份恢复、故障排查 |
| [技术文档](docs/ARCHITECTURE.md) | 原理、Plus 的改动、目录结构、测试、维护与发布、已知限制 |
| [Linux 客户端说明](linux/README.md) | Linux（x64 / ARM64）客户端的生成、便携运行、免 root 安装与 AppArmor 沙箱说明 |
| [网页版说明](web/README.md) | 网页版的生成、上传、登录和浏览器支持 |
| [更新记录](CHANGELOG.md) | 每个版本改了什么 |

各平台的详细说明在 `host/`、`windows/`、`mac/`、`linux/`、`android/`、`web/`、`ios/` 目录的 README 里，也随对应的工具包分发。

## 交流

- 交流和发布帖在 [LINUX DO](https://linux.do)；
- bug 请提 [Issue](https://github.com/ferretgeek/prokbot-plus/issues)，安全问题按 [SECURITY.md](SECURITY.md) 私下报告；
- 参与贡献请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可与声明

- 源自 [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot)（提交 `3e9fe8c`），沿用 [ProkBot 非商业许可证 1.0](LICENSE)：可以个人使用、学习、修改和非商业分发，不能用于任何商业用途（包括收费部署、付费服务和企业内部使用）。来源和修改清单见 [NOTICE](NOTICE)。
- 仓库和 Release 里没有 Grok Bot 官方程序，也不提供打好补丁的客户端、APK、IPA 或网页版界面包；`android/dist/` 只有本项目自己的外壳。
- Grok、Grok Bot 及相关商标归各自权利人所有，本项目与他们没有关联。
- 大部分代码由 AI 辅助编写，由 6.2Astra 和 Opus5.5 一起维护，按现状提供，不提供任何担保。
