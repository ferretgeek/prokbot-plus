# 更新记录 / Changelog

版本号从 ProkBot Plus 1.0.0 开始。上游 ProkBot 的版本记录附在后面，供参考。

Versions start at ProkBot Plus 1.0.0. Upstream ProkBot releases are listed at the end for reference.

## ProkBot Plus 1.1.0 (2026-11-14)

客户端工具更新：不必重装或升级现有 Host，不改服务器的 `.env`、项目名或数据卷。Windows 与 Mac 的固定原包仍是 0.71.2；第三方桌面 1.1.0 的文件、校验和与部分界面已检查，未通过新版自托管配对和聊天。Android 外壳 1.1.0（10100）与固定 Windows 界面 0.71.2 分开编号；已有 Android 安装须使用原签名密钥，不要先卸载。iOS 固定 1.16.0（23152），没有 Mac、iPhone 或 iPad 真机结果。不承诺低配容量或服务器升级无损。

Client tools update: existing users do not need to reinstall or upgrade their Host, change its `.env`, project name or volumes. Windows and Mac still require the 0.71.2 originals; the vendor's desktop 1.1.0 files and parts of the UI were inspected, not accepted for self-hosted pairing or chat. Android shell 1.1.0 (10100) carries the pinned 0.71.2 Windows renderer. Use the existing Android signing key; do not uninstall first. iOS remains pinned to 1.16.0 (23152). No Mac, iPhone or iPad hardware test, capacity rating or lossless server upgrade is claimed.

- **原包和外壳验证 / Input verification**：桌面与 Android 的 `--verify-only` 回放固定补丁；Android 还核对实际 APK 清单、入口页和手机版界面补丁。Mac 对显式 DMG 校验整包；原始 App 验签只在 macOS 完成。Desktop and Android verification replays pinned recipes; Android also checks the compiled APK manifest, entry point and mobile changes. The Mac tool verifies supplied DMG bytes and requires a valid original app signature on macOS.
- **配对和重连 / Pairing and reconnect**：换 Host 需要重新配对；旧连接取消或重连时不再把非事件流响应当作新消息。Changing Host requires fresh pairing. Cancelling or reconnecting no longer treats a non-event response as a stream of messages.
- **包内容 / Distribution**：提供 Host、Windows、Mac、iOS、Android 五个工具包和 SHA-256。与前一默认分支相比，Host 源码不变；不分发厂商原包、IPA 或生成的客户端。Five tool ZIPs and SHA-256 sums, with the Host source unchanged from the previous default branch. No vendor program, IPA or generated client is included.

## Earlier main-branch changes / 早期主分支变更

- **文档更正 / Documentation correction (2026-11-14)**：首页列明四种部署模式尚无实测配置评级、苹果真机验收边界和数据卷备份范围；修正 `v1.0.0` 发布说明中的安装链接，不改变其安装包。The homepages distinguish measured deployment limits, Apple hardware coverage and volume-only backups. The two installation links in the `v1.0.0` release notes were repaired without replacing its assets.

- **ARM64 与部署**：Host 可原生构建在 ARM64 Linux 上；官方桌面仍为 amd64，可放独立节点，或在同机经预检后模拟（实验）。新增统一部署入口，记住项目和模式，更新前备份；双语安装手册改为一条流程。维护者可离线核对固定版本、补丁和外壳摘要。
- **ARM64 and deployment**: build the Host natively on ARM64 Linux. The original amd64 desktop runs separately or under local emulation after a preflight (experimental). A single operator command remembers the project and topology and backs up before upgrading. Both install guides now follow one route; maintainers can check pinned inputs, recipes and shell digests offline.
- **A1 真机验证 / A1 hardware verification**：ARM64 Host 搭配独立 amd64 桌面通过两轮聊天、VNC 操作及旧版数据兼容测试。A native ARM64 Host with a separate amd64 desktop passed two-turn chat, VNC control and data compatibility tests. This did not test a single-machine Docker deployment on A1.

- **Android 主页截图**：中英文 README 分别展示在 Android App 中实际发送的两轮对话和模型回复，配对页截图移至安装说明。
- **Android screenshots**: each README now shows a real two-turn conversation in its own language; pairing screenshots are in the Android installation guide.

- **客户端与 Host 修复**：Windows 安装和卸载前校验目录归属；Windows、Android 对显式提供的官方 EXE 校验整包及内层摘要；仅校验时清理临时目录，Windows 构建失败不覆盖已有 ZIP。Android 正确报告保存失败、释放重连监听器、限制网关连接数和握手时间，后台通知不再漏掉同一毫秒的不同事件。新版 Host 区分 Android 和 Windows；新配对的 Android 设备没有桌面执行权限。模型请求不跟随重定向；消息排序等待不会因 Node 提前退出而丢失。
- **验证与主页**：加入可选的三平台 CI 模板（默认未启用）、Windows 安装器测试，以及 Android 15 干净演示环境的中英文实拍截图，明确 Android App 由项目自开发、不是官方版本。

English: Windows checks directory ownership before installation or removal. Both builders verify explicit EXEs and their payloads; Windows verification cleans up, and failed ZIP builds preserve existing output. Android reports save failures, releases reconnect listeners, bounds gateway connections and handshakes, and keeps distinct notifications with identical timestamps. Updated Hosts distinguish Android from Windows and withhold desktop execution privileges from newly paired Android clients. Model requests refuse redirects, and ordered messages retain their timeout even on an otherwise idle Node process. The optional three-platform CI template is inactive by default. Installer tests and clean Android 15 screenshots are included.

- **新增 Android 客户端**（`android/`）：
  - 界面用官方桌面版的界面，取自用户自己下载的官方 Windows 0.71.2 安装包，套在本项目编写的 Android 外壳里（官方 Android 版带防篡改保护，不做修改）；
  - 生成工具 `android/patchers/patch.mjs` 在 Windows、macOS、Linux 上都能运行，用为用户单独生成的密钥签名（APK 签名方案 v2）；
  - 功能：对话、Bot 电脑的实时画面和远程操作（触摸和软键盘）、附件上传和保存、后台通知（不依赖 Google 推送）、深色模式、返回键；Android 9 及以上；
  - 照官方手机版的样子重新排版：Bot 列表和对话分成两屏，圆形悬浮按钮、消息气泡、配色和 XVF 字体都按官方手机版，列表每行显示 Bot 的最后活动时间，市场入口移到账户菜单；详情、设置、市场和搜索全屏打开，菜单和对话框从底部弹出，看图和电脑大画面黑底全屏；旧版 WebView 上 Bot 电脑画面也能正确定位；
  - 配对时自动把中文输入法打出的全角字符转换为半角。
- **Windows 补丁**：解压官方安装包的代码移到 `windows/patchers/desktop/original.mjs`，供 Android 共用。
- **文档**：
  - 技术说明、功能细节、待办和手动安装说明合并为[技术文档](docs/ARCHITECTURE.md)；
  - Host 的离线构建、备份、分开部署和应用开发并入 `host/README.md`，iOS 签名说明并入 `ios/README.md`；
  - 删除没有用到的截图；
  - 部署手册补充更新客户端的步骤和 Android 的故障排查；贡献说明、PR 和问题模板、安全建议加上 Android；技术文档补充 iOS 网络层测试；
  - 新增 `AGENTS.md`：给接手本仓库的 AI 看的项目概览，`CLAUDE.md` 引用它。
- **清理**：删除没有程序读取、内容也已过时的文件清单 `host/source-files.json`。

English: **new Android client** (`android/`). It runs the official desktop interface, taken from the user's own download of the official Windows 0.71.2 installer, inside an Android shell written for this project (the official Android app carries tamper protection and is not modified). The builder `android/patchers/patch.mjs` runs on Windows, macOS and Linux and signs the APK (scheme v2) with a key created for the user. It supports conversations, the live view and remote control of the Bot's computer (touch and on-screen keyboard), uploading and saving attachments, background notifications without Google push, dark mode and the back gesture, on Android 9 and later; the interface is rearranged after the official phone app (the Bot list and a conversation are separate screens with its round floating buttons, message bubbles, colors and XVF typeface; each Bot row shows when the Bot was last active; the marketplace moves into the account menu; details, settings, the marketplace and search open full screen; menus and dialogs slide up from the bottom), the computer view is positioned correctly on older WebView builds, and pairing converts full-width characters typed by Chinese input methods. The Windows patcher's installer extraction moved to `windows/patchers/desktop/original.mjs` for sharing.

English: the technical notes, feature details, to-do list and manual install notes are merged into the [technical documentation](docs/ARCHITECTURE.en.md); the Host deployment, backup and app notes are merged into `host/README.en.md` and the iOS signing notes into `ios/README.en.md`; unused screenshots are removed; the deployment guide adds steps for updating the clients and Android troubleshooting; the contributing guide, pull request and issue templates and security advice cover Android; the technical documentation lists the iOS network test; `AGENTS.md` adds a project overview for AI agents. The unused and outdated file list `host/source-files.json` is removed.

## 1.0.0（2026-11-10）

基于 ProkBot v2026.11.05（提交 `3e9fe8c`）。

**新增**

- **Windows x64 客户端**：基于官方 Grok Bot 0.71.2 Windows 版生成，提供便携版和安装包（装在当前用户目录，不需要管理员权限）。
  - 功能：对话、托盘、系统通知、附件、Tailcat、本机命令（PowerShell）、Codex 委派。
- **模型接口**：新增 Anthropic Messages 和 OpenAI Responses，与 OpenAI Chat 并列。
  - 三种格式都支持图片、文件、工具调用、思考强度和多轮推理接续；
  - 思考强度新增 `minimal`；
  - 连接测试和自动审查也支持三种格式。
- **命令行管理工具** `host/tools/host-admin.mjs`：初始化管理员、列出模型、配置并测试模型、生成配对码。
- **AI 部署手册** `docs/AI-INSTALL.md`：每一步都有「应该看到」和「如果失败」，开头先让 AI 告诉用户需要准备什么。

**修复**

- **Windows**：
  - Bot 生成的图片和截图在客户端里一直显示加载中；
  - 中文 Windows 上本机命令的输出乱码。
- **联网工具**：
  - 新版 Claude 不接受强制工具调用，导致联网失败；
  - 并行搜索中有一路超出次数时，整次搜索被判失败。
- **图片生成**：
  - 指定画面比例时 OpenAI 图片接口报错；
  - 带参考图修图时报错。
- **消息顺序**：同一次回复里的多条消息可能乱序送达。
- **自动审查**：模型偶尔返回格式不对的结果时，直接拒绝操作且不留日志。现在重试一次，失败会记日志。
- **构建**：Docker 29 默认的 containerd 镜像存储下，构建报 `Unsupported Box image identity`。
- **Tailcat**：代码从 Windows 上传到服务器时，Tailcat 程序会丢掉可执行权限，导致服务端无法开启 Tailcat。现在构建镜像时会补上这个权限。
- **测试**：Mac 测试在中文系统下失败（断言只认英文报错）。

**English summary**

- **New**:
  - Windows x64 client (portable build and per-user installer);
  - Anthropic Messages and OpenAI Responses model formats next to OpenAI Chat, with `minimal` effort and reasoning replay;
  - `host/tools/host-admin.mjs` admin CLI;
  - step-by-step AI deployment guide.
- **Fixed**:
  - Windows: Host images stuck loading; garbled command output on Chinese Windows.
  - Web tools: failed with current Claude models; parallel searches failed when one call hit its limit.
  - Image tools: errors on aspect ratios and on reference images.
  - Message order: messages from one reply could arrive out of order.
  - Auto review: failed silently on malformed classifications.
  - Build: broke with Docker 29's containerd image store.
  - Tailcat: failed to start on the server when the code was uploaded from Windows (lost executable bit); the image build now sets it.
  - Tests: a Mac test failed on Chinese systems.

---

## 上游 ProkBot 版本 / Upstream ProkBot releases

来自 https://gitee.com/ahaduoduoduo/ProkBot ，仅作记录。

- **v2026.11.05**：Mac 修复 Bot 置顶、分组及折叠状态的保存。
- **v2026.11.02**：iOS 修复锁屏后 Tailcat 持续重连；回到前台时自动恢复连接。
- **v2026.11.01**：首个公开版本。可以用自己的 Host 和模型，并保留 Grok Bot 的 Mac 和 iOS 界面；提供 Mac、iOS、Host 三个补丁工具。
