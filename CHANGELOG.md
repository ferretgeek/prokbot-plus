# 更新记录 / Changelog

版本号从 ProkBot Plus 1.0.0 开始。上游 ProkBot 的版本记录附在后面，供参考。

Versions start at ProkBot Plus 1.0.0. Upstream ProkBot releases are listed at the end for reference.

## 未发布 / Unreleased

- **文档精简**：
  - 技术说明、功能细节、待办和手动安装说明合并为[技术文档](docs/ARCHITECTURE.md)；
  - Host 的离线构建、备份、分开部署和应用开发并入 `host/README.md`，iOS 签名说明并入 `ios/README.md`；
  - 删除没有用到的截图。
- **新增 `AGENTS.md`**：给接手本仓库的 AI 看的项目概览，`CLAUDE.md` 引用它。

English: the technical notes, feature details, to-do list and manual install notes are merged into the [technical documentation](docs/ARCHITECTURE.en.md); the Host deployment, backup and app notes are merged into `host/README.en.md` and the iOS signing notes into `ios/README.en.md`; unused screenshots are removed; `AGENTS.md` adds a project overview for AI agents.

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
